import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Executor, Row } from './executor.js';

/**
 * Runs migrations against a local SQLite file with Node's built-in driver.
 *
 * It deliberately mirrors the Harakumo endpoint: statements in a script run
 * one by one in autocommit mode, so a failure halfway leaves the earlier
 * statements applied. That way local runs and the test suite exercise the
 * same partial-failure path production can hit.
 */
export class SqliteExecutor implements Executor {
  readonly target: string;
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync, file: string) {
    this.db = db;
    this.target = file === ':memory:' ? 'local sqlite (memory)' : `local sqlite ${file}`;
  }

  static async open(file: string): Promise<SqliteExecutor> {
    // Imported lazily so the Harakumo path works on runtimes without node:sqlite.
    const { DatabaseSync } = await import('node:sqlite');
    return new SqliteExecutor(new DatabaseSync(file), file);
  }

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}
