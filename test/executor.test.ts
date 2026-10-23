import { HarakumoError } from '@harakumo/sdk';
import { describe, expect, it, vi } from 'vitest';
import { backoffMs, HarakumoExecutor, isRetryable, type DatabasesApi } from '../src/executor.js';

function apiError(status: number): HarakumoError {
  return Object.assign(new HarakumoError(`HTTP ${status}`), { status, body: null });
}

/** A fake `hk.databases` that fails with the given statuses, then answers. */
function fakeDatabases(failures: number[], results: Record<string, unknown>[] = [{ ok: 1 }]) {
  const calls: { dbId: number; sql: string; params?: unknown[] }[] = [];
  const databases: DatabasesApi = {
    query: vi.fn(async (dbId, sql, params) => {
      calls.push({ dbId, sql, params });
      const status = failures.shift();
      if (status) throw apiError(status);
      return { results, statements: 1, meta: {} };
    }),
  };
  return { databases, calls };
}

const noSleep = async () => {};

describe('HarakumoExecutor', () => {
  it('sends the SQL and params to the database and returns the rows', async () => {
    const { databases, calls } = fakeDatabases([], [{ n: 2 }]);
    const exec = new HarakumoExecutor({ databaseId: 5, databases });
    expect(await exec.query('SELECT count(*) AS n FROM notes WHERE id > ?', [1])).toEqual([{ n: 2 }]);
    expect(calls).toEqual([{ dbId: 5, sql: 'SELECT count(*) AS n FROM notes WHERE id > ?', params: [1] }]);
    expect(exec.target).toBe('harakumo db #5');
  });

  it('retries a 429 even for a migration script: the platform refused it before running', async () => {
    const { databases, calls } = fakeDatabases([429, 429]);
    await new HarakumoExecutor({ databaseId: 5, databases, sleep: noSleep }).exec('CREATE TABLE t (id);');
    expect(calls).toHaveLength(3);
  });

  it('retries a 502 only when the call is idempotent', async () => {
    const idem = fakeDatabases([502]);
    await new HarakumoExecutor({ databaseId: 5, databases: idem.databases, sleep: noSleep }).query('SELECT 1', [], {
      idempotent: true,
    });
    expect(idem.calls).toHaveLength(2);

    const script = fakeDatabases([502]);
    const exec = new HarakumoExecutor({ databaseId: 5, databases: script.databases, sleep: noSleep });
    await expect(exec.exec('INSERT INTO t VALUES (1);')).rejects.toMatchObject({ status: 502 });
    expect(script.calls).toHaveLength(1);
  });

  it('never retries a SQL error', async () => {
    const { databases, calls } = fakeDatabases([400]);
    const exec = new HarakumoExecutor({ databaseId: 5, databases, sleep: noSleep });
    await expect(exec.query('SELEC 1', [], { idempotent: true })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(1);
  });

  it('gives up after the retry budget', async () => {
    const { databases, calls } = fakeDatabases([429, 429, 429]);
    const exec = new HarakumoExecutor({ databaseId: 5, databases, retries: 2, sleep: noSleep });
    await expect(exec.query('SELECT 1')).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(3);
  });

  it('validates its configuration', () => {
    expect(() => new HarakumoExecutor({ databaseId: 0, apiKey: 'k' })).toThrow(/databaseId/);
    expect(() => new HarakumoExecutor({ databaseId: 1 })).toThrow(/apiKey/);
  });
});

describe('isRetryable', () => {
  it('treats network failures like 502s', () => {
    expect(isRetryable(new TypeError('fetch failed'), true)).toBe(true);
    expect(isRetryable(new TypeError('fetch failed'), false)).toBe(false);
  });
});

describe('backoffMs', () => {
  it('grows and caps', () => {
    for (let i = 0; i < 10; i++) {
      const ms = backoffMs(i);
      expect(ms).toBeGreaterThanOrEqual(Math.min(8_000, 500 * 2 ** i) / 2);
      expect(ms).toBeLessThanOrEqual(8_000);
    }
  });
});
