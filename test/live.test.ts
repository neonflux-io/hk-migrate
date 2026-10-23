/**
 * Runs the real migration flow against a Harakumo edge SQLite database.
 *
 *   HARAKUMO_API_KEY=hk_live_… HARAKUMO_TEST_DB_ID=5 npm run test:live
 *
 * Use a scratch database. The test only touches tables it names with a
 * random suffix and drops them afterwards.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { HarakumoExecutor } from '../src/executor.js';
import { loadMigrations } from '../src/migrations.js';
import { Migrator } from '../src/migrator.js';
import { migrationsDir, writeFiles } from './helpers.js';

const apiKey = process.env.HARAKUMO_API_KEY;
const databaseId = Number(process.env.HARAKUMO_TEST_DB_ID);
const enabled = Boolean(apiKey && databaseId);

describe.skipIf(!enabled)('live: Harakumo edge SQLite', () => {
  const suffix = randomBytes(4).toString('hex');
  const table = `_hk_migrations_test_${suffix}`;
  const notes = `notes_${suffix}`;
  const executor = enabled
    ? new HarakumoExecutor({ databaseId, apiKey: apiKey!, baseUrl: process.env.HARAKUMO_URL })
    : (undefined as never);

  afterAll(async () => {
    if (!enabled) return;
    await executor.exec(`DROP TABLE IF EXISTS ${notes}; DROP TABLE IF EXISTS ${table}; DROP TABLE IF EXISTS ${table}_lock;`);
  });

  it('applies, records, detects drift, and records a partial failure', async () => {
    const dir = await migrationsDir({
      '0001_create.sql': `CREATE TABLE ${notes} (id INTEGER PRIMARY KEY, body TEXT NOT NULL);`,
      '0002_column.sql': `ALTER TABLE ${notes} ADD COLUMN created_at TEXT NOT NULL DEFAULT '';`,
    });
    const migrator = async () => new Migrator({ executor, table, migrations: await loadMigrations(dir) });

    expect((await (await migrator()).up()).map((a) => a.version)).toEqual([1, 2]);
    await executor.query(`INSERT INTO ${notes} (body, created_at) VALUES (?, ?)`, ['from the edge', '2026-10-24']);
    expect(await executor.query(`SELECT body FROM ${notes}`)).toEqual([{ body: 'from the edge' }]);

    await writeFiles(dir, { '0002_column.sql': `ALTER TABLE ${notes} ADD COLUMN created_at TEXT;` });
    expect((await (await migrator()).status()).problems).toMatchObject([{ version: 2, state: 'drifted' }]);
    await (await migrator()).resolve(2, 'applied');

    await writeFiles(dir, { '0003_broken.sql': `CREATE INDEX ${notes}_body ON ${notes} (body);\nSELECT * FROM nope_${suffix};` });
    await expect((await migrator()).up()).rejects.toMatchObject({ code: 'MIGRATION_FAILED' });
    const status = await (await migrator()).status();
    expect(status.problems).toMatchObject([{ version: 3, state: 'failed' }]);
    expect(status.lock).toBeNull();
  });
});
