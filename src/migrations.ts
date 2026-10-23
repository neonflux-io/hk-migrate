import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MigrateError } from './errors.js';

export interface MigrationFile {
  /** Numeric prefix of the filename; migrations apply in ascending order. */
  version: number;
  /** The part after the prefix, e.g. `create_notes`. */
  name: string;
  filename: string;
  sql: string;
  /** sha256 of the SQL with line endings normalized, so a Windows checkout matches CI. */
  checksum: string;
}

const FILENAME = /^(\d+)_([a-z0-9][a-z0-9_-]*)\.sql$/i;

export function parseFilename(filename: string): { version: number; name: string } | null {
  const match = FILENAME.exec(filename);
  if (!match) return null;
  return { version: Number(match[1]), name: match[2]! };
}

export function normalizeSql(sql: string): string {
  return sql.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

export function checksum(sql: string): string {
  return createHash('sha256').update(normalizeSql(sql)).digest('hex');
}

/** True when the SQL holds nothing but whitespace and comments. */
export function isEffectivelyEmpty(sql: string): boolean {
  return normalizeSql(sql)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .trim() === '';
}

export function formatVersion(version: number): string {
  return String(version).padStart(4, '0');
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) throw new MigrateError('CONFIG', `"${name}" has no letters or digits to name a migration with.`);
  return slug;
}

/**
 * Read every `NNNN_name.sql` file in `dir`, sorted by version. Other file
 * types are ignored; a `.sql` file that does not follow the pattern is an
 * error rather than silently skipped, because a skipped migration is a schema
 * that quietly differs between environments.
 */
export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const files: MigrationFile[] = [];
  const seen = new Map<number, string>();
  for (const filename of entries.filter((f) => f.toLowerCase().endsWith('.sql')).sort()) {
    const parsed = parseFilename(filename);
    if (!parsed) {
      throw new MigrateError(
        'BAD_FILENAME',
        `${filename} does not match NNNN_name.sql. Rename it, e.g. 0001_create_users.sql.`,
      );
    }
    const clash = seen.get(parsed.version);
    if (clash) {
      throw new MigrateError(
        'DUPLICATE_VERSION',
        `${clash} and ${filename} share version ${parsed.version}. Renumber one of them.`,
      );
    }
    seen.set(parsed.version, filename);

    const sql = normalizeSql(await readFile(path.join(dir, filename), 'utf8'));
    if (isEffectivelyEmpty(sql)) {
      throw new MigrateError('EMPTY_MIGRATION', `${filename} has no SQL in it yet.`);
    }
    files.push({ ...parsed, filename, sql, checksum: checksum(sql) });
  }
  return files.sort((a, b) => a.version - b.version);
}

/** Write the next numbered migration file and return its path. */
export async function createMigrationFile(
  dir: string,
  name: string,
  sql = '-- Forward-only SQL. Statements run in order.\n',
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const existing = (await readdir(dir)).map(parseFilename).filter((p) => p !== null);
  const next = existing.reduce((max, p) => Math.max(max, p.version), 0) + 1;
  const file = path.join(dir, `${formatVersion(next)}_${slugify(name)}.sql`);
  await writeFile(file, sql.endsWith('\n') ? sql : sql + '\n', { flag: 'wx' });
  return file;
}
