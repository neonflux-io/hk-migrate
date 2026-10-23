import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Executor } from './executor.js';
import { createMigrationFile, loadMigrations } from './migrations.js';
import { Migrator } from './migrator.js';
import { VERSION } from './version.js';

export interface McpOptions {
  /** Migrations directory. Re-read on every call, so files the agent creates show up. */
  dir: string;
  openExecutor: () => Promise<Executor>;
  table?: string;
  /**
   * Off by default: an agent can inspect, plan and write migration files, but
   * a person runs `up`. Turn on only for disposable or development databases.
   */
  allowApply?: boolean;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const json = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const failure = (err: unknown): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
});

/**
 * Tools an agent can use to turn "add a due date to notes" into a reviewed
 * schema change: read the current state, write a migration file, preview the
 * plan, and (only when allowed) apply it.
 */
export function createMcpServer(opts: McpOptions): McpServer {
  const server = new McpServer({ name: 'hk-migrate', version: VERSION });

  async function withMigrator<T>(fn: (m: Migrator) => Promise<T>): Promise<ToolResult> {
    try {
      const migrations = await loadMigrations(opts.dir);
      const executor = await opts.openExecutor();
      try {
        return json(await fn(new Migrator({ executor, migrations, table: opts.table })));
      } finally {
        await executor.close?.();
      }
    } catch (err) {
      return failure(err);
    }
  }

  const to = z.number().int().positive().optional().describe('Stop after this version (inclusive).');

  server.registerTool(
    'migrations_status',
    {
      title: 'Migration status',
      description:
        'Compare the migration files with the database: which are applied, pending, drifted (edited after ' +
        'applying), failed or interrupted, and whether a runner holds the lock. Read-only.',
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      withMigrator(async (m) => {
        const { pending, ...status } = await m.status();
        return { ...status, pending: pending.map((p) => p.filename) };
      }),
  );

  server.registerTool(
    'migrations_plan',
    {
      title: 'Plan migrations',
      description: 'List the migrations `up` would apply, in order, with their SQL. Fails if something blocks them. Read-only.',
      inputSchema: { to },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) =>
      withMigrator(async (m) =>
        (await m.plan({ to: args.to })).map(({ version, filename, sql }) => ({ version, filename, sql })),
      ),
  );

  server.registerTool(
    'migration_create',
    {
      title: 'Create migration file',
      description:
        'Write the next numbered migration file with the given SQL. It is not applied. SQLite dialect; ' +
        'forward-only; no BEGIN/COMMIT (statements run one by one). Prefer additive changes: ' +
        'ADD COLUMN with a default, CREATE INDEX IF NOT EXISTS, new tables.',
      inputSchema: {
        name: z.string().min(1).describe('Short description, e.g. "add due date to notes".'),
        sql: z.string().min(1).describe('The SQL statements, each ending in a semicolon.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const file = await createMigrationFile(opts.dir, args.name, args.sql);
        return json({ file, next: 'Review the file, then run migrations_plan.' });
      } catch (err) {
        return failure(err);
      }
    },
  );

  if (opts.allowApply) {
    server.registerTool(
      'migrations_apply',
      {
        title: 'Apply migrations',
        description:
          'Apply pending migrations to the database in order, under a lock. Changes the live schema and ' +
          'cannot be undone automatically. Run migrations_plan first and confirm with the user.',
        inputSchema: { to },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      },
      (args) => withMigrator(async (m) => ({ applied: await m.up({ to: args.to }) })),
    );
  }

  return server;
}

export async function startMcpServer(opts: McpOptions): Promise<McpServer> {
  const server = createMcpServer(opts);
  await server.connect(new StdioServerTransport());
  return server;
}
