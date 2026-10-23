import Harakumo, { HarakumoError } from '@harakumo/sdk';

export type Row = Record<string, unknown>;

export interface QueryOptions {
  /**
   * Safe to send twice. Only idempotent calls are retried after a 502/503,
   * because those can arrive after the statement already ran.
   */
  idempotent?: boolean;
}

/** Where migrations run. Harakumo edge SQLite in production, node:sqlite locally. */
export interface Executor {
  /** Human description of the target, e.g. `harakumo db #5`. */
  readonly target: string;
  /** Run a single statement with `?` params and return its rows. */
  query<T extends Row = Row>(sql: string, params?: unknown[], opts?: QueryOptions): Promise<T[]>;
  /** Run a script of one or more statements, in order. Never retried. */
  exec(sql: string): Promise<void>;
  close?(): void | Promise<void>;
}

interface QueryResponse {
  results?: Row[];
  statements?: number;
  meta?: unknown;
}

/**
 * The slice of the SDK this package uses. `@harakumo/sdk@0.1.0` implements
 * `databases.query` at runtime but its index.d.ts leaves it out, so it is
 * typed here (see FEEDBACK.md).
 */
export interface DatabasesApi {
  query(dbId: number, sql: string, params?: unknown[]): Promise<QueryResponse>;
}

export interface HarakumoExecutorOptions {
  databaseId: number;
  apiKey?: string;
  baseUrl?: string;
  /** Inject a client (tests, or one you already built). Takes precedence over apiKey. */
  databases?: DatabasesApi;
  /** Retries for throttled or (idempotent) failed calls. Default 4. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function statusOf(err: unknown): number | undefined {
  return err instanceof HarakumoError && typeof err.status === 'number' ? err.status : undefined;
}

/**
 * 429 means the platform refused the request before running it, so it is
 * always safe to retry. 502/503 and network failures may land after the
 * statement ran, so those are retried only for idempotent calls.
 */
export function isRetryable(err: unknown, idempotent: boolean): boolean {
  const status = statusOf(err);
  if (status === 429) return true;
  if (!idempotent) return false;
  if (status === 502 || status === 503) return true;
  // fetch() rejects with a TypeError when the connection itself fails.
  return status === undefined && err instanceof TypeError;
}

/** Exponential backoff with jitter: ~0.5s, 1s, 2s, 4s, capped at 8s. */
export function backoffMs(attempt: number): number {
  const base = Math.min(8_000, 500 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

export class HarakumoExecutor implements Executor {
  readonly target: string;
  private readonly databaseId: number;
  private readonly databases: DatabasesApi;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: HarakumoExecutorOptions) {
    if (!Number.isInteger(opts.databaseId) || opts.databaseId <= 0) {
      throw new TypeError(`databaseId must be a positive integer, got ${opts.databaseId}`);
    }
    this.databaseId = opts.databaseId;
    this.target = `harakumo db #${opts.databaseId}`;
    this.retries = opts.retries ?? 4;
    this.sleep = opts.sleep ?? wait;
    if (opts.databases) {
      this.databases = opts.databases;
    } else {
      if (!opts.apiKey) throw new TypeError('apiKey is required when no databases client is injected');
      const hk = new Harakumo({ apiKey: opts.apiKey, ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) });
      this.databases = hk.databases as unknown as DatabasesApi;
    }
  }

  async query<T extends Row = Row>(sql: string, params: unknown[] = [], opts: QueryOptions = {}): Promise<T[]> {
    const res = await this.send(sql, params, opts.idempotent ?? false);
    return (res.results ?? []) as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.send(sql, undefined, false);
  }

  private async send(sql: string, params: unknown[] | undefined, idempotent: boolean): Promise<QueryResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return (await this.databases.query(this.databaseId, sql, params)) ?? {};
      } catch (err) {
        if (attempt >= this.retries || !isRetryable(err, idempotent)) throw err;
        await this.sleep(backoffMs(attempt));
      }
    }
  }
}
