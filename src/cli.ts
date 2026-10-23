import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { HarakumoError } from '@harakumo/sdk';
import { MigrateError } from './errors.js';
import { HarakumoExecutor, type Executor } from './executor.js';
import { createMigrationFile, formatVersion, loadMigrations } from './migrations.js';
import { describeProblem, Migrator, type MigrateEvent, type Status } from './migrator.js';
import { startMcpServer } from './mcp.js';
import { SqliteExecutor } from './sqlite-executor.js';
import { VERSION } from './version.js';

export interface CliIO {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  color: boolean;
  /** Where `harakumo login` saved its key. Default ~/.harakumo/config.json. */
  configPath?: string;
}

const HELP = `hk-migrate — versioned SQL migrations for Harakumo edge SQLite

Usage
  hk-migrate new <name...>                 Create migrations/NNNN_<name>.sql
  hk-migrate status                        Applied, pending, drifted and failed migrations
  hk-migrate up [--to N] [--dry-run]       Apply pending migrations in order, under a lock
  hk-migrate verify [--require-up-to-date] CI gate: exit 1 on drift, failures, or (optionally) pending
  hk-migrate resolve <N> --applied | --rolled-back
                                           Settle a failed, interrupted or drifted migration
  hk-migrate unlock                        Clear a lock left by a runner that died
  hk-migrate mcp [--allow-apply]           Serve these commands to an AI agent over MCP (stdio)

Target (one of)
  --db <id>          Harakumo database id              env HARAKUMO_DB_ID
  --local <file>     Local SQLite file, for development and tests

Options
  -d, --dir <path>   Migrations directory              default ./migrations
  --key <hk_live_…>  API key  env HARAKUMO_API_KEY, else the key saved by \`npx harakumo login\`
  --url <origin>     API origin                        env HARAKUMO_URL
  --table <name>     History table                     default _hk_migrations
  --json             Machine-readable output
  -h, --help         Show this help
  -v, --version      Print the version`;

const OPTIONS = {
  dir: { type: 'string', short: 'd' },
  db: { type: 'string' },
  local: { type: 'string' },
  key: { type: 'string' },
  url: { type: 'string' },
  table: { type: 'string' },
  to: { type: 'string' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  applied: { type: 'boolean' },
  'rolled-back': { type: 'boolean' },
  'require-up-to-date': { type: 'boolean' },
  'allow-apply': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type Flags = ReturnType<typeof parseFlags>['values'];

function parseFlags(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

/** Run the CLI and return the exit code: 0 ok, 1 failed, 2 usage error. */
export async function run(argv: string[], io: CliIO): Promise<number> {
  let parsed: ReturnType<typeof parseFlags>;
  try {
    parsed = parseFlags(argv);
  } catch (err) {
    io.stderr(`${(err as Error).message}\nRun hk-migrate --help for usage.`);
    return 2;
  }
  const { values: flags, positionals } = parsed;
  const [command, ...args] = positionals;
  const ui = palette(io.color && !flags.json);

  if (flags.version) {
    io.stdout(VERSION);
    return 0;
  }
  if (flags.help || !command || command === 'help') {
    io.stdout(HELP);
    return command && command !== 'help' ? 2 : 0;
  }

  const dir = path.resolve(io.cwd, flags.dir ?? 'migrations');
  const out = (human: () => string | string[], json: unknown) => {
    if (flags.json) io.stdout(JSON.stringify(json, null, 2));
    else io.stdout([human()].flat().join('\n'));
  };

  try {
    switch (command) {
      case 'new': {
        if (!args.length) return usage(io, 'hk-migrate new <name>');
        const file = await createMigrationFile(dir, args.join(' '));
        out(() => `${ui.ok('✓')} Created ${path.relative(io.cwd, file)}`, { file });
        return 0;
      }

      case 'status':
      case 'verify': {
        const status = await withMigrator(flags, io, dir, (m) => m.status());
        const failOnPending = command === 'verify' && flags['require-up-to-date'];
        const passed = status.ok && !(failOnPending && status.pending.length > 0);
        out(() => renderStatus(status, ui), { ...status, pending: status.pending.map(summary), passed });
        return command === 'verify' && !passed ? 1 : 0;
      }

      case 'up': {
        const to = flags.to === undefined ? undefined : parseVersion(flags.to);
        if (to === null) return usage(io, 'hk-migrate up --to <version number>');
        if (flags['dry-run']) {
          const plan = await withMigrator(flags, io, dir, (m) => m.plan({ to }));
          out(
            () =>
              plan.length
                ? [`Would apply ${plan.length} migration${plural(plan.length)}:`, ...plan.map((m) => `  ${m.filename}`)]
                : `${ui.ok('✓')} Nothing to apply.`,
            { dryRun: true, plan: plan.map((m) => ({ ...summary(m), sql: m.sql })) },
          );
          return 0;
        }
        const onEvent = flags.json ? undefined : (e: MigrateEvent) => renderEvent(e, io, ui);
        const applied = await withMigrator(flags, io, dir, (m) => m.up({ to }), onEvent);
        out(
          () =>
            applied.length
              ? `${ui.ok('✓')} Applied ${applied.length} migration${plural(applied.length)}.`
              : `${ui.ok('✓')} Already up to date.`,
          { applied },
        );
        return 0;
      }

      case 'resolve': {
        const version = parseVersion(args[0]);
        if (version === null || flags.applied === flags['rolled-back']) {
          return usage(io, 'hk-migrate resolve <version> --applied | --rolled-back');
        }
        const as = flags.applied ? 'applied' : 'rolled-back';
        const entry = await withMigrator(flags, io, dir, (m) => m.resolve(version, as));
        out(() => `${ui.ok('✓')} ${formatVersion(entry.version)}_${entry.name} is now ${entry.state}.`, entry);
        return 0;
      }

      case 'unlock': {
        const previous = await withMigrator(flags, io, dir, (m) => m.unlock());
        out(
          () => (previous ? `${ui.ok('✓')} Released lock held by ${previous.owner} since ${previous.acquiredAt}.` : 'No lock was held.'),
          { released: previous },
        );
        return 0;
      }

      case 'mcp': {
        // Fail fast on a bad target instead of on the agent's first tool call.
        await (await openExecutor(flags, io)).close?.();
        await startMcpServer({
          dir,
          table: flags.table,
          allowApply: flags['allow-apply'] ?? false,
          openExecutor: () => openExecutor(flags, io),
        });
        io.stderr(`hk-migrate MCP server ready on stdio (${flags['allow-apply'] ? 'apply enabled' : 'read-only'})`);
        return 0;
      }

      default:
        io.stderr(`Unknown command "${command}".`);
        io.stderr(HELP);
        return 2;
    }
  } catch (err) {
    io.stderr(`${ui.err('✖')} ${explain(err)}`);
    return 1;
  }
}

async function withMigrator<T>(
  flags: Flags,
  io: CliIO,
  dir: string,
  fn: (m: Migrator) => Promise<T>,
  onEvent?: (e: MigrateEvent) => void,
): Promise<T> {
  const migrations = await loadMigrations(dir);
  const executor = await openExecutor(flags, io);
  try {
    return await fn(new Migrator({ executor, migrations, table: flags.table, onEvent }));
  } finally {
    await executor.close?.();
  }
}

export async function openExecutor(flags: Flags, io: CliIO): Promise<Executor> {
  if (flags.local) {
    if (flags.db) throw new MigrateError('CONFIG', 'Pass either --db or --local, not both.');
    return SqliteExecutor.open(path.resolve(io.cwd, flags.local));
  }
  const rawId = flags.db ?? io.env.HARAKUMO_DB_ID;
  if (!rawId) {
    throw new MigrateError('CONFIG', 'No target. Pass --db <id> (or set HARAKUMO_DB_ID), or --local <file> for a local SQLite file.');
  }
  const databaseId = parseVersion(rawId);
  if (databaseId === null) throw new MigrateError('CONFIG', `--db must be a database id number, got "${rawId}".`);

  const saved = readSavedLogin(io.configPath ?? path.join(os.homedir(), '.harakumo', 'config.json'));
  const apiKey = flags.key ?? io.env.HARAKUMO_API_KEY ?? saved.apiKey;
  if (!apiKey) {
    throw new MigrateError('CONFIG', 'No API key. Run `npx harakumo login --key hk_live_…`, set HARAKUMO_API_KEY, or pass --key.');
  }
  const baseUrl = flags.url ?? io.env.HARAKUMO_URL ?? saved.baseUrl;
  return new HarakumoExecutor({ databaseId, apiKey, ...(baseUrl ? { baseUrl } : {}) });
}

/** The official CLI saves `{ apiKey, baseUrl }` here on `harakumo login`. */
function readSavedLogin(file: string): { apiKey?: string; baseUrl?: string } {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

const HTTP_HINTS: Record<number, string> = {
  401: 'Check the API key (Dashboard → Settings → API keys).',
  402: 'The plan limit is reached: database storage on Hobby holds writes that add data.',
  403: 'Database queries need a full-access key, even for SELECT.',
  404: 'Check the database id: `npx harakumo db <projectId>` lists them.',
  409: 'The database is not available yet, or its create failed.',
  410: 'The database no longer exists on the edge.',
};

function explain(err: unknown): string {
  if (err instanceof MigrateError) return err.message;
  if (err instanceof HarakumoError) {
    const hint = HTTP_HINTS[err.status];
    return `Harakumo API error (HTTP ${err.status}): ${err.message}${hint ? `\n  ${hint}` : ''}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function renderStatus(status: Status, ui: Palette): string[] {
  const lines = [ui.dim(`${status.target} · ${status.entries.length} migration${plural(status.entries.length)}`), ''];
  if (!status.entries.length) {
    lines.push('  No migrations yet. Create one: hk-migrate new create_users');
    return lines;
  }
  const rows = status.entries.map((e) => [
    formatVersion(e.version),
    e.name,
    e.state,
    e.appliedAt ? e.appliedAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '',
    e.durationMs === undefined ? '' : `${e.durationMs}ms`,
  ]);
  const header = ['VERSION', 'NAME', 'STATE', 'APPLIED', 'TOOK'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const pad = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  lines.push('  ' + ui.dim(pad(header)));
  for (const row of rows) {
    const state = row[2]!;
    const colored = pad(row).replace(state.padEnd(widths[2]!), ui.state(state, state.padEnd(widths[2]!)));
    lines.push('  ' + colored);
  }
  lines.push('');
  if (status.lock) lines.push(`${ui.warn('!')} Locked by ${status.lock.owner} since ${status.lock.acquiredAt}`);
  for (const p of status.problems) lines.push(`${ui.err('✖')} ${describeProblem(p)}`);
  for (const e of status.entries.filter((x) => x.state === 'missing')) {
    lines.push(`${ui.warn('!')} ${describeProblem(e)} — applied, but its file is gone`);
  }
  if (status.ok) {
    lines.push(
      status.pending.length
        ? `${status.pending.length} pending. Run: hk-migrate up`
        : `${ui.ok('✓')} Up to date.`,
    );
  }
  return lines;
}

function renderEvent(event: MigrateEvent, io: CliIO, ui: Palette): void {
  if (event.type === 'migration-applied') {
    io.stdout(`  ${ui.ok('✓')} ${formatVersion(event.version)}_${event.name} ${ui.dim(`${event.durationMs}ms`)}`);
  } else if (event.type === 'migration-failed') {
    io.stdout(`  ${ui.err('✖')} ${formatVersion(event.version)}_${event.name} ${ui.dim(`${event.durationMs}ms`)}`);
  }
}

function summary(m: { version: number; name: string; filename: string; checksum: string }) {
  return { version: m.version, name: m.name, filename: m.filename, checksum: m.checksum };
}

function parseVersion(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

function usage(io: CliIO, text: string): number {
  io.stderr(`Usage: ${text}`);
  return 2;
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

type Palette = ReturnType<typeof palette>;

function palette(enabled: boolean) {
  const wrap = (code: number) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
  const ok = wrap(32);
  const err = wrap(31);
  const warn = wrap(33);
  const dim = wrap(2);
  return {
    ok,
    err,
    warn,
    dim,
    state(state: string, text: string): string {
      if (state === 'applied') return ok(text);
      if (state === 'pending' || state === 'missing') return warn(text);
      return err(text);
    },
  };
}
