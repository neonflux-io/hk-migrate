import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { run, type CliIO } from '../src/cli.js';
import { migrationsDir, NOTES } from './helpers.js';

async function cli(cwd: string, ...argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIO = {
    stdout: (l) => stdout.push(l),
    stderr: (l) => stderr.push(l),
    env: {},
    cwd,
    color: false,
    configPath: path.join(cwd, 'no-config.json'),
  };
  const code = await run(argv, io);
  return { code, out: stdout.join('\n'), err: stderr.join('\n') };
}

/** A project directory with migrations/ and a local SQLite file target. */
async function project(files: Record<string, string> = NOTES) {
  const cwd = await migrationsDir();
  const dir = path.join(cwd, 'migrations');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(dir);
  for (const [name, sql] of Object.entries(files)) await writeFile(path.join(dir, name), sql);
  return { cwd, run: (...argv: string[]) => cli(cwd, ...argv, '--local', 'dev.db') };
}

describe('cli', () => {
  it('walks through status → up → status', async () => {
    const p = await project();

    let r = await p.run('status');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/0001\s+create_notes\s+pending/);
    expect(r.out).toContain('3 pending. Run: hk-migrate up');

    r = await p.run('up');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Applied 3 migrations.');

    r = await p.run('status');
    expect(r.out).toMatch(/0003\s+index_created_at\s+applied/);
    expect(r.out).toContain('✓ Up to date.');

    expect((await p.run('up')).out).toContain('Already up to date.');
  });

  it('prints a dry run without touching the database', async () => {
    const p = await project();
    const r = await p.run('up', '--dry-run', '--to', '2', '--json');
    expect(JSON.parse(r.out).plan.map((m: { filename: string }) => m.filename)).toEqual([
      '0001_create_notes.sql',
      '0002_add_created_at.sql',
    ]);
    expect(JSON.parse((await p.run('status', '--json')).out).pending).toHaveLength(3);
  });

  it('verify fails CI on pending only when asked to', async () => {
    const p = await project();
    expect((await p.run('verify')).code).toBe(0);
    expect((await p.run('verify', '--require-up-to-date')).code).toBe(1);
    await p.run('up');
    expect((await p.run('verify', '--require-up-to-date')).code).toBe(0);
  });

  it('reports a failed migration with the commands that settle it', async () => {
    const p = await project({ '0001_bad.sql': 'CREATE TABLE ok (id);\nSELECT * FROM nope;' });
    const r = await p.run('up');
    expect(r.code).toBe(1);
    expect(r.err).toContain('0001_bad failed');
    expect(r.err).toContain('hk-migrate resolve 1 --rolled-back');

    expect((await p.run('verify')).code).toBe(1);
    expect((await p.run('resolve', '1', '--applied')).out).toContain('0001_bad is now applied.');
    expect((await p.run('verify')).code).toBe(0);
  });

  it('creates numbered migration files', async () => {
    const p = await project({});
    expect((await cli(p.cwd, 'new', 'create', 'users')).out).toContain(path.join('migrations', '0001_create_users.sql'));
    await cli(p.cwd, 'new', 'add email');
    expect(await readdir(path.join(p.cwd, 'migrations'))).toEqual(['0001_create_users.sql', '0002_add_email.sql']);
  });

  it('explains how to pick a target and authenticate', async () => {
    const cwd = await migrationsDir();
    expect((await cli(cwd, 'status')).err).toContain('No target. Pass --db <id>');
    expect((await cli(cwd, 'status', '--db', '5')).err).toContain('npx harakumo login');
    expect((await cli(cwd, 'status', '--db', 'abc', '--key', 'k')).err).toContain('must be a database id');
  });

  it('rejects bad usage with exit code 2', async () => {
    const cwd = await migrationsDir();
    expect((await cli(cwd, 'status', '--nope')).code).toBe(2);
    expect((await cli(cwd, 'frobnicate')).code).toBe(2);
    expect((await cli(cwd, 'resolve', '1', '--local', 'x.db')).code).toBe(2);
    expect((await cli(cwd, '--help')).code).toBe(0);
  });
});
