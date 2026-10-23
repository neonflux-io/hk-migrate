import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { loadMigrations } from '../src/migrations.js';
import { Migrator, type MigratorOptions } from '../src/migrator.js';
import { SqliteExecutor } from '../src/sqlite-executor.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** A temp migrations directory holding the given files. */
export async function migrationsDir(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hk-migrate-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await writeFiles(dir, files);
  return dir;
}

export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, sql] of Object.entries(files)) await writeFile(path.join(dir, name), sql);
}

export async function memoryDb(): Promise<SqliteExecutor> {
  const db = await SqliteExecutor.open(':memory:');
  cleanups.push(() => db.close());
  return db;
}

/** A Migrator over the files currently in `dir`. Call again after changing files. */
export async function migrator(
  executor: SqliteExecutor,
  dir: string,
  opts: Partial<MigratorOptions> = {},
): Promise<Migrator> {
  return new Migrator({ executor, migrations: await loadMigrations(dir), ...opts });
}

export const NOTES = {
  '0001_create_notes.sql': `CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);\n`,
  '0002_add_created_at.sql': `ALTER TABLE notes ADD COLUMN created_at TEXT NOT NULL DEFAULT '';\n`,
  '0003_index_created_at.sql': `CREATE INDEX notes_created_at ON notes (created_at);\n`,
};
