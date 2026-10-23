import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { MigrateError } from './errors.js';
import type { Executor } from './executor.js';
import { formatVersion, type MigrationFile } from './migrations.js';

/**
 * - applied:      ran to completion and the file still matches.
 * - pending:      a file that has not run yet.
 * - drifted:      applied, but the file was edited afterwards.
 * - failed:       a statement failed; earlier statements in it may have applied.
 * - running:      in progress under a held lock.
 * - interrupted:  marked running but nobody holds the lock (the runner died).
 * - out-of-order: pending, but older than a migration already applied.
 * - missing:      applied in the database, no file in the directory.
 */
export type EntryState =
  | 'applied'
  | 'pending'
  | 'drifted'
  | 'failed'
  | 'running'
  | 'interrupted'
  | 'out-of-order'
  | 'missing';

/** States that stop `up` until a person decides what happened. */
export const BLOCKING_STATES: readonly EntryState[] = ['drifted', 'failed', 'running', 'interrupted', 'out-of-order'];

export interface StatusEntry {
  version: number;
  name: string;
  state: EntryState;
  appliedAt?: string;
  durationMs?: number;
  error?: string;
}

export interface LockInfo {
  owner: string;
  acquiredAt: string;
}

export interface Status {
  target: string;
  entries: StatusEntry[];
  pending: MigrationFile[];
  problems: StatusEntry[];
  lock: LockInfo | null;
  /** True when nothing blocks `up`. Pending migrations do not count as a problem. */
  ok: boolean;
}

export type MigrateEvent =
  | { type: 'lock-acquired'; owner: string }
  | { type: 'lock-released'; owner: string }
  | { type: 'migration-start'; version: number; name: string }
  | { type: 'migration-applied'; version: number; name: string; durationMs: number }
  | { type: 'migration-failed'; version: number; name: string; durationMs: number; error: string };

export interface AppliedMigration {
  version: number;
  name: string;
  durationMs: number;
}

export interface MigratorOptions {
  executor: Executor;
  migrations: MigrationFile[];
  /** History table name. The lock table is `<table>_lock`. Default `_hk_migrations`. */
  table?: string;
  /** Identifies this runner in the lock. Default `<hostname>#<pid>#<random>`. */
  owner?: string;
  onEvent?: (event: MigrateEvent) => void;
  now?: () => Date;
}

type HistoryRow = {
  version: number;
  name: string;
  checksum: string;
  state: 'running' | 'applied' | 'failed';
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class Migrator {
  private readonly exec: Executor;
  private readonly migrations: MigrationFile[];
  private readonly table: string;
  private readonly lockTable: string;
  private readonly owner: string;
  private readonly emit: (event: MigrateEvent) => void;
  private readonly now: () => Date;

  constructor(opts: MigratorOptions) {
    const table = opts.table ?? '_hk_migrations';
    // The table name is spliced into SQL, so it must be a plain identifier.
    if (!IDENTIFIER.test(table)) throw new MigrateError('CONFIG', `"${table}" is not a valid table name.`);
    this.exec = opts.executor;
    this.migrations = [...opts.migrations].sort((a, b) => a.version - b.version);
    this.table = table;
    this.lockTable = `${table}_lock`;
    this.owner = opts.owner ?? `${os.hostname()}#${process.pid}#${randomUUID().slice(0, 8)}`;
    this.emit = opts.onEvent ?? (() => {});
    this.now = opts.now ?? (() => new Date());
  }

  get target(): string {
    return this.exec.target;
  }

  /** Compare files against the database. Read-only: it never creates the tracking tables. */
  async status(): Promise<Status> {
    const exists = await this.exec.query<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)`,
      [this.table, this.lockTable],
      { idempotent: true },
    );
    const names = new Set(exists.map((r) => r.name));
    const history = names.has(this.table)
      ? await this.exec.query<HistoryRow>(`SELECT * FROM ${this.table} ORDER BY version`, [], { idempotent: true })
      : [];
    const lock = names.has(this.lockTable) ? await this.readLock() : null;
    return this.compare(history, lock);
  }

  /** The migrations `up` would apply, in order. Throws if something blocks them. */
  async plan(opts: { to?: number } = {}): Promise<MigrationFile[]> {
    const status = await this.status();
    assertRunnable(status);
    return selectUpTo(status.pending, opts.to);
  }

  /**
   * Apply pending migrations in order under a database lock. Stops at the
   * first failure, records it as `failed`, and rethrows.
   */
  async up(opts: { to?: number } = {}): Promise<AppliedMigration[]> {
    await this.ensureTables();
    await this.acquireLock();
    try {
      // Re-read under the lock: another runner may have applied something meanwhile.
      const status = await this.status();
      assertRunnable(status);
      const applied: AppliedMigration[] = [];
      for (const migration of selectUpTo(status.pending, opts.to)) {
        applied.push(await this.apply(migration));
      }
      return applied;
    } finally {
      await this.releaseLock();
    }
  }

  /**
   * Settle a failed, interrupted or drifted migration after a person has
   * looked at the database:
   * - `applied`:     its changes are in place; record it (with the file's current checksum).
   * - `rolled-back`: its changes are not in place; forget it so `up` runs it again.
   */
  async resolve(version: number, as: 'applied' | 'rolled-back'): Promise<StatusEntry> {
    const status = await this.status();
    if (status.lock) {
      throw new MigrateError(
        'LOCKED',
        `${this.target} is locked by ${status.lock.owner}. Wait for it, or run \`hk-migrate unlock\` if it is dead.`,
      );
    }
    const entry = status.entries.find((e) => e.version === version);
    if (!entry) throw new MigrateError('NOT_FOUND', `No migration ${formatVersion(version)} in the files or the database.`);

    const allowed: EntryState[] = as === 'applied' ? ['failed', 'interrupted', 'drifted'] : ['failed', 'interrupted'];
    if (!allowed.includes(entry.state)) {
      throw new MigrateError(
        'INVALID_STATE',
        `${label(entry)} is ${entry.state}; only ${allowed.join(', ')} migrations can be resolved as ${as}.`,
      );
    }

    if (as === 'rolled-back') {
      await this.exec.query(`DELETE FROM ${this.table} WHERE version = ?`, [version], { idempotent: true });
      return { version, name: entry.name, state: 'pending' };
    }
    const file = this.migrations.find((m) => m.version === version);
    if (!file) throw new MigrateError('NOT_FOUND', `${label(entry)} has no file to take a checksum from.`);
    await this.exec.query(
      `UPDATE ${this.table} SET state = 'applied', checksum = ?, error = NULL, finished_at = COALESCE(finished_at, ?) WHERE version = ?`,
      [file.checksum, this.now().toISOString(), version],
      { idempotent: true },
    );
    return { version, name: entry.name, state: 'applied' };
  }

  /** Break a lock left behind by a runner that died. Returns the previous holder. */
  async unlock(): Promise<LockInfo | null> {
    const status = await this.status();
    if (!status.lock) return null;
    await this.exec.query(`DELETE FROM ${this.lockTable} WHERE id = 1`, [], { idempotent: true });
    return status.lock;
  }

  private async apply(migration: MigrationFile): Promise<AppliedMigration> {
    const { version, name } = migration;
    const started = this.now();
    this.emit({ type: 'migration-start', version, name });

    // Mark it running first. If the process dies mid-script, the row stays
    // `running` with no lock holder and status reports it as interrupted
    // instead of silently re-running half-applied SQL.
    await this.exec.query(
      `INSERT OR REPLACE INTO ${this.table} (version, name, checksum, state, started_at) VALUES (?, ?, ?, 'running', ?)`,
      [version, name, migration.checksum, started.toISOString()],
      { idempotent: true },
    );

    try {
      await this.exec.exec(migration.sql);
    } catch (err) {
      const durationMs = this.now().getTime() - started.getTime();
      const error = err instanceof Error ? err.message : String(err);
      await this.exec.query(
        `UPDATE ${this.table} SET state = 'failed', error = ?, finished_at = ?, duration_ms = ? WHERE version = ?`,
        [error, this.now().toISOString(), durationMs, version],
        { idempotent: true },
      );
      this.emit({ type: 'migration-failed', version, name, durationMs, error });
      throw new MigrateError(
        'MIGRATION_FAILED',
        `${formatVersion(version)}_${name} failed: ${error}\n` +
          `Statements before the failing one may have applied. Inspect the database, then run\n` +
          `  hk-migrate resolve ${version} --rolled-back   (changes undone; fix the file and run up again)\n` +
          `  hk-migrate resolve ${version} --applied       (changes are in place)`,
        { cause: err },
      );
    }

    const durationMs = this.now().getTime() - started.getTime();
    await this.exec.query(
      `UPDATE ${this.table} SET state = 'applied', finished_at = ?, duration_ms = ? WHERE version = ?`,
      [this.now().toISOString(), durationMs, version],
      { idempotent: true },
    );
    this.emit({ type: 'migration-applied', version, name, durationMs });
    return { version, name, durationMs };
  }

  private async ensureTables(): Promise<void> {
    await this.exec.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table} (
        version     INTEGER PRIMARY KEY,
        name        TEXT    NOT NULL,
        checksum    TEXT    NOT NULL,
        state       TEXT    NOT NULL CHECK (state IN ('running', 'applied', 'failed')),
        error       TEXT,
        started_at  TEXT    NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS ${this.lockTable} (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        owner       TEXT    NOT NULL,
        acquired_at TEXT    NOT NULL
      );
    `);
  }

  /**
   * One row with a fixed primary key acts as the lock. INSERT OR IGNORE
   * succeeds for exactly one runner; everyone then reads back who won, which
   * avoids depending on the wording of a constraint error.
   */
  private async acquireLock(): Promise<void> {
    await this.exec.query(
      `INSERT OR IGNORE INTO ${this.lockTable} (id, owner, acquired_at) VALUES (1, ?, ?)`,
      [this.owner, this.now().toISOString()],
      { idempotent: true },
    );
    const lock = await this.readLock();
    if (lock?.owner !== this.owner) {
      const since = lock ? ` since ${lock.acquiredAt}` : '';
      throw new MigrateError(
        'LOCKED',
        `${this.target} is locked by ${lock?.owner ?? 'another runner'}${since}. ` +
          `If that run is dead, clear it with \`hk-migrate unlock\`.`,
      );
    }
    this.emit({ type: 'lock-acquired', owner: this.owner });
  }

  private async releaseLock(): Promise<void> {
    try {
      await this.exec.query(`DELETE FROM ${this.lockTable} WHERE id = 1 AND owner = ?`, [this.owner], {
        idempotent: true,
      });
      this.emit({ type: 'lock-released', owner: this.owner });
    } catch {
      // Never mask the error that got us here; a stale lock is visible in `status`.
    }
  }

  private async readLock(): Promise<LockInfo | null> {
    const [row] = await this.exec.query<{ owner: string; acquired_at: string }>(
      `SELECT owner, acquired_at FROM ${this.lockTable} WHERE id = 1`,
      [],
      { idempotent: true },
    );
    return row ? { owner: row.owner, acquiredAt: row.acquired_at } : null;
  }

  private compare(history: HistoryRow[], lock: LockInfo | null): Status {
    const byVersion = new Map(history.map((row) => [Number(row.version), row]));
    const files = new Map(this.migrations.map((m) => [m.version, m]));
    const versions = [...new Set([...files.keys(), ...byVersion.keys()])].sort((a, b) => a - b);
    const lastApplied = Math.max(0, ...history.map((row) => Number(row.version)));

    const entries: StatusEntry[] = [];
    const pending: MigrationFile[] = [];
    for (const version of versions) {
      const file = files.get(version);
      const row = byVersion.get(version);
      if (!row) {
        // file is defined: the version came from one of the two maps.
        const state = version < lastApplied ? 'out-of-order' : 'pending';
        entries.push({ version, name: file!.name, state });
        if (state === 'pending') pending.push(file!);
        continue;
      }
      const entry: StatusEntry = { version, name: row.name, state: 'applied', appliedAt: row.finished_at ?? row.started_at };
      if (row.duration_ms !== null) entry.durationMs = Number(row.duration_ms);
      if (row.state === 'failed') {
        entry.state = 'failed';
        entry.error = row.error ?? 'unknown error';
      } else if (row.state === 'running') {
        entry.state = lock ? 'running' : 'interrupted';
      } else if (!file) {
        entry.state = 'missing';
      } else if (file.checksum !== row.checksum) {
        entry.state = 'drifted';
      }
      entries.push(entry);
    }

    const problems = entries.filter((e) => BLOCKING_STATES.includes(e.state));
    return { target: this.target, entries, pending, problems, lock, ok: problems.length === 0 };
  }
}

function label(entry: { version: number; name: string }): string {
  return `${formatVersion(entry.version)}_${entry.name}`;
}

function selectUpTo(pending: MigrationFile[], to: number | undefined): MigrationFile[] {
  return to === undefined ? pending : pending.filter((m) => m.version <= to);
}

const ADVICE: Partial<Record<EntryState, (v: number) => string>> = {
  drifted: (v) => `was edited after it was applied. Restore the file, or accept it: hk-migrate resolve ${v} --applied`,
  failed: (v) => `failed partway. Inspect the database, then: hk-migrate resolve ${v} --rolled-back | --applied`,
  interrupted: (v) => `was interrupted. Inspect the database, then: hk-migrate resolve ${v} --rolled-back | --applied`,
  running: () => `is being applied by another runner right now.`,
  'out-of-order': () => `is older than a migration already applied. Renumber it after the latest one.`,
};

export function describeProblem(entry: StatusEntry): string {
  return `${label(entry)} ${ADVICE[entry.state]?.(entry.version) ?? entry.state}`;
}

function assertRunnable(status: Status): void {
  if (status.ok) return;
  throw new MigrateError(
    'BLOCKED',
    `Cannot migrate ${status.target}:\n` + status.problems.map((p) => `  - ${describeProblem(p)}`).join('\n'),
  );
}
