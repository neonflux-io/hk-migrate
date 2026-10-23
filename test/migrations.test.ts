import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MigrateError } from '../src/errors.js';
import { checksum, createMigrationFile, isEffectivelyEmpty, loadMigrations, parseFilename, slugify } from '../src/migrations.js';
import { migrationsDir } from './helpers.js';

describe('parseFilename', () => {
  it('reads version and name', () => {
    expect(parseFilename('0007_add_tags.sql')).toEqual({ version: 7, name: 'add_tags' });
    expect(parseFilename('20261024_init.sql')).toEqual({ version: 20261024, name: 'init' });
  });

  it('rejects anything else', () => {
    for (const bad of ['add_tags.sql', '0001-add.sql', '0001_.sql', '0001_x.txt']) {
      expect(parseFilename(bad)).toBeNull();
    }
  });
});

describe('checksum', () => {
  it('ignores line endings and a BOM, so Windows and CI agree', () => {
    expect(checksum('﻿CREATE TABLE a (id);\r\nSELECT 1;\r\n')).toBe(checksum('CREATE TABLE a (id);\nSELECT 1;\n'));
  });

  it('changes when the SQL changes', () => {
    expect(checksum('SELECT 1;')).not.toBe(checksum('SELECT 2;'));
  });
});

describe('isEffectivelyEmpty', () => {
  it('sees through comments', () => {
    expect(isEffectivelyEmpty('-- todo\n/* later */\n')).toBe(true);
    expect(isEffectivelyEmpty('-- add\nSELECT 1;')).toBe(false);
  });
});

describe('loadMigrations', () => {
  it('sorts numerically and skips non-SQL files', async () => {
    const dir = await migrationsDir({
      '10_ten.sql': 'SELECT 10;',
      '2_two.sql': 'SELECT 2;',
      'README.md': '# notes',
    });
    const files = await loadMigrations(dir);
    expect(files.map((f) => f.version)).toEqual([2, 10]);
  });

  it('returns nothing for a directory that does not exist', async () => {
    expect(await loadMigrations(path.join(await migrationsDir(), 'nope'))).toEqual([]);
  });

  it.each([
    [{ 'add_tags.sql': 'SELECT 1;' }, 'BAD_FILENAME'],
    [{ '1_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 1;' }, 'DUPLICATE_VERSION'],
    [{ '0001_a.sql': '-- nothing yet\n' }, 'EMPTY_MIGRATION'],
  ])('refuses a broken directory: %j', async (files, code) => {
    const dir = await migrationsDir(files);
    await expect(loadMigrations(dir)).rejects.toMatchObject({ name: 'MigrateError', code });
  });
});

describe('createMigrationFile', () => {
  it('numbers after the highest existing version', async () => {
    const dir = await migrationsDir({ '0001_a.sql': 'SELECT 1;', '0007_b.sql': 'SELECT 1;' });
    const file = await createMigrationFile(dir, 'Add tags to Notes!', 'ALTER TABLE notes ADD COLUMN tags TEXT;');
    expect(path.basename(file)).toBe('0008_add_tags_to_notes.sql');
    expect(await readFile(file, 'utf8')).toBe('ALTER TABLE notes ADD COLUMN tags TEXT;\n');
  });

  it('creates the directory on first use', async () => {
    const dir = path.join(await migrationsDir(), 'migrations');
    await createMigrationFile(dir, 'init');
    expect(await readdir(dir)).toEqual(['0001_init.sql']);
  });

  it('needs a usable name', () => {
    expect(() => slugify('!!!')).toThrow(MigrateError);
  });
});
