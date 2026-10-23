import { readdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/mcp.js';
import { memoryDb, migrationsDir, NOTES } from './helpers.js';

async function connect(dir: string, allowApply: boolean) {
  const db = await memoryDb();
  // The server closes the executor after each tool call; keep the in-memory db alive across calls.
  const executor = { target: db.target, query: db.query.bind(db), exec: db.exec.bind(db) };
  const server = createMcpServer({ dir, allowApply, openExecutor: async () => executor });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    const text = res.content[0]!.text;
    return { isError: res.isError ?? false, text, data: res.isError ? undefined : JSON.parse(text) };
  };
  return { client, call };
}

describe('MCP server', () => {
  it('is read-only unless apply is explicitly allowed', async () => {
    const dir = await migrationsDir(NOTES);
    const readOnly = await connect(dir, false);
    expect((await readOnly.client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'migration_create',
      'migrations_plan',
      'migrations_status',
    ]);

    const full = await connect(dir, true);
    const apply = (await full.client.listTools()).tools.find((t) => t.name === 'migrations_apply');
    expect(apply?.annotations?.destructiveHint).toBe(true);
  });

  it('lets an agent create, plan and apply a schema change', async () => {
    const dir = await migrationsDir(NOTES);
    const { call } = await connect(dir, true);

    expect((await call('migrations_status')).data.pending).toHaveLength(3);
    expect((await call('migrations_apply')).data.applied).toHaveLength(3);

    const created = await call('migration_create', {
      name: 'add due date to notes',
      sql: 'ALTER TABLE notes ADD COLUMN due_at TEXT;',
    });
    expect(created.data.file).toMatch(/0004_add_due_date_to_notes\.sql$/);
    expect(await readdir(dir)).toContain('0004_add_due_date_to_notes.sql');

    const plan = await call('migrations_plan');
    expect(plan.data).toEqual([
      { version: 4, filename: '0004_add_due_date_to_notes.sql', sql: 'ALTER TABLE notes ADD COLUMN due_at TEXT;\n' },
    ]);
    expect((await call('migrations_apply')).data.applied).toMatchObject([{ version: 4 }]);
  });

  it('returns failures as tool errors the agent can read', async () => {
    const dir = await migrationsDir({ '0001_bad.sql': 'SELECT * FROM nope;' });
    const { call } = await connect(dir, true);
    const res = await call('migrations_apply');
    expect(res.isError).toBe(true);
    expect(res.text).toContain('resolve 1 --rolled-back');
  });
});
