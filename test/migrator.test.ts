import { describe, expect, it } from 'vitest';
import type { MigrateEvent } from '../src/migrator.js';
import { memoryDb, migrationsDir, migrator, NOTES, writeFiles } from './helpers.js';

const states = (status: { entries: { version: number; state: string }[] }) =>
  Object.fromEntries(status.entries.map((e) => [e.version, e.state]));

describe('Migrator', () => {
  it('reports everything pending on a fresh database without writing to it', async () => {
    const db = await memoryDb();
    const m = await migrator(db, await migrationsDir(NOTES));

    const status = await m.status();
    expect(states(status)).toEqual({ 1: 'pending', 2: 'pending', 3: 'pending' });
    expect(status.ok).toBe(true);
    expect(await db.query(`SELECT name FROM sqlite_master WHERE type = 'table'`)).toEqual([]);
  });

  it('applies pending migrations in order, then has nothing to do', async () => {
    const db = await memoryDb();
    const events: MigrateEvent[] = [];
    const m = await migrator(db, await migrationsDir(NOTES), { onEvent: (e) => events.push(e) });

    const applied = await m.up();
    expect(applied.map((a) => a.version)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.type)).toEqual([
      'lock-acquired',
      ...Array(3).fill(['migration-start', 'migration-applied']).flat(),
      'lock-released',
    ]);

    await db.query(`INSERT INTO notes (body, created_at) VALUES (?, ?)`, ['hello', '2026-10-24']);
    expect(await db.query(`SELECT body FROM notes`)).toEqual([{ body: 'hello' }]);

    expect(await m.up()).toEqual([]);
    const status = await m.status();
    expect(states(status)).toEqual({ 1: 'applied', 2: 'applied', 3: 'applied' });
    expect(status.lock).toBeNull();
  });

  it('stops at --to', async () => {
    const db = await memoryDb();
    const m = await migrator(db, await migrationsDir(NOTES));
    expect((await m.up({ to: 2 })).map((a) => a.version)).toEqual([1, 2]);
    expect(states(await m.status())[3]).toBe('pending');
  });

  it('picks up new files on the next run', async () => {
    const db = await memoryDb();
    const dir = await migrationsDir({ '0001_create_notes.sql': NOTES['0001_create_notes.sql'] });
    await (await migrator(db, dir)).up();

    await writeFiles(dir, { '0002_add_created_at.sql': NOTES['0002_add_created_at.sql'] });
    const applied = await (await migrator(db, dir)).up();
    expect(applied.map((a) => a.version)).toEqual([2]);
  });

  it('blocks on a file edited after it was applied, until resolved', async () => {
    const db = await memoryDb();
    const dir = await migrationsDir(NOTES);
    await (await migrator(db, dir)).up({ to: 1 });

    await writeFiles(dir, { '0001_create_notes.sql': 'CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);' });
    const m = await migrator(db, dir);
    const status = await m.status();
    expect(status.ok).toBe(false);
    expect(status.problems).toMatchObject([{ version: 1, state: 'drifted' }]);
    await expect(m.up()).rejects.toMatchObject({ code: 'BLOCKED' });
    await expect(m.plan()).rejects.toMatchObject({ code: 'BLOCKED' });

    await m.resolve(1, 'applied');
    expect(states(await m.status())[1]).toBe('applied');
  });

  it('records a partial failure and refuses to continue until a person decides', async () => {
    const db = await memoryDb();
    const dir = await migrationsDir({
      '0001_create_notes.sql': NOTES['0001_create_notes.sql'],
      // The first statement succeeds, the second references a missing table.
      '0002_tags.sql': `CREATE TABLE tags (id INTEGER PRIMARY KEY);\nINSERT INTO missing_table VALUES (1);\n`,
      '0003_later.sql': 'CREATE TABLE later (id INTEGER);',
    });
    const m = await migrator(db, dir);

    await expect(m.up()).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
    const status = await m.status();
    expect(states(status)).toEqual({ 1: 'applied', 2: 'failed', 3: 'pending' });
    expect(status.problems[0]?.error).toMatch(/missing_table/);
    expect(status.lock).toBeNull(); // released despite the failure
    // The partial effect is real, exactly as on the edge: tags exists.
    expect(await db.query(`SELECT name FROM sqlite_master WHERE name = 'tags'`)).toHaveLength(1);

    await expect(m.up()).rejects.toMatchObject({ code: 'BLOCKED' });

    // A person undoes the partial change, fixes the file, and marks it rolled back.
    await db.exec('DROP TABLE tags;');
    await writeFiles(dir, { '0002_tags.sql': 'CREATE TABLE tags (id INTEGER PRIMARY KEY);' });
    const fixed = await migrator(db, dir);
    await fixed.resolve(2, 'rolled-back');
    expect((await fixed.up()).map((a) => a.version)).toEqual([2, 3]);
  });

  it('treats a run that died mid-migration as interrupted, not as in progress', async () => {
    const db = await memoryDb();
    const m = await migrator(db, await migrationsDir(NOTES));
    await m.up({ to: 1 });
    // A runner crashed after marking the row running; nobody holds the lock any more.
    await db.query(`INSERT INTO _hk_migrations (version, name, checksum, state, started_at) VALUES (2, 'add_created_at', 'x', 'running', '2026-10-24T00:00:00Z')`);

    expect((await m.status()).problems).toMatchObject([{ version: 2, state: 'interrupted' }]);
    await m.resolve(2, 'rolled-back');
    expect(states(await m.status())[2]).toBe('pending');
  });

  it('refuses to run while another runner holds the lock, and unlock clears a stale one', async () => {
    const db = await memoryDb();
    const dir = await migrationsDir(NOTES);
    const a = await migrator(db, dir, { owner: 'ci#1' });
    await a.up({ to: 1 });
    await db.query(`INSERT INTO _hk_migrations_lock (id, owner, acquired_at) VALUES (1, 'laptop#42', '2026-10-24T09:00:00Z')`);

    const b = await migrator(db, dir, { owner: 'ci#2' });
    await expect(b.up()).rejects.toMatchObject({ code: 'LOCKED', message: expect.stringContaining('laptop#42') });
    await expect(b.resolve(1, 'applied')).rejects.toMatchObject({ code: 'LOCKED' });
    // The losing runner must not remove someone else's lock.
    expect((await b.status()).lock).toEqual({ owner: 'laptop#42', acquiredAt: '2026-10-24T09:00:00Z' });

    expect(await b.unlock()).toMatchObject({ owner: 'laptop#42' });
    expect((await b.up()).map((x) => x.version)).toEqual([2, 3]);
  });

  it('flags a pending file older than the latest applied one', async () => {
    const db = await memoryDb();
    const dir = await migrationsDir({ '0001_a.sql': 'CREATE TABLE a (id);', '0003_c.sql': 'CREATE TABLE c (id);' });
    await (await migrator(db, dir)).up();

    await writeFiles(dir, { '0002_b.sql': 'CREATE TABLE b (id);' }); // merged from an old branch
    const status = await (await migrator(db, dir)).status();
    expect(status.problems).toMatchObject([{ version: 2, state: 'out-of-order' }]);
    expect(status.pending).toEqual([]);
  });

  it('warns about, but does not block on, an applied migration whose file is gone', async () => {
    const db = await memoryDb();
    await (await migrator(db, await migrationsDir(NOTES))).up({ to: 1 });

    const status = await (await migrator(db, await migrationsDir({}))).status();
    expect(states(status)).toEqual({ 1: 'missing' });
    expect(status.ok).toBe(true);
  });

  it('keeps separate histories under different table names', async () => {
    const db = await memoryDb();
    await (await migrator(db, await migrationsDir({ '0001_a.sql': 'CREATE TABLE a (id);' }), { table: 'app_a' })).up();
    const other = await migrator(db, await migrationsDir({ '0001_b.sql': 'CREATE TABLE b (id);' }), { table: 'app_b' });
    expect(states(await other.status())).toEqual({ 1: 'pending' });
  });

  it('only accepts a plain identifier as the table name', async () => {
    const db = await memoryDb();
    await expect(migrator(db, await migrationsDir(), { table: 'x; DROP TABLE notes' })).rejects.toMatchObject({
      code: 'CONFIG',
    });
  });

  it('only resolves states that need it', async () => {
    const db = await memoryDb();
    const m = await migrator(db, await migrationsDir(NOTES));
    await m.up({ to: 1 });
    await expect(m.resolve(1, 'rolled-back')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(m.resolve(2, 'applied')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(m.resolve(99, 'applied')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
