# hk-migrate

Versioned SQL migrations for **Harakumo edge SQLite**, built on [`@harakumo/sdk`](https://www.npmjs.com/package/@harakumo/sdk).
It ships as a CLI, a typed library, and an MCP server, so an agent can plan schema changes and a person approves them.

```console
$ npx hk-migrate status --local dev.db
local sqlite dev.db · 4 migrations

  VERSION  NAME               STATE    APPLIED               TOOK
  0001     create_notes       applied  2026-10-24 17:10:59Z  82ms
  0002     add_tags           applied  2026-10-24 17:10:59Z  37ms
  0003     add_pinned         applied  2026-10-24 17:10:59Z  32ms
  0004     add_archived_flag  failed   2026-10-24 17:11:01Z  22ms

✖ 0004_add_archived_flag failed partway. Inspect the database, then: hk-migrate resolve 4 --rolled-back | --applied
```

## Why

Every Harakumo database is a separate SQLite database on the edge. You reach it over HTTPS (`POST /api/databases/:id`), not through a connection. Three platform facts shaped this tool:

1. **There is no migration tooling.** Apps run `CREATE TABLE` by hand from the dashboard or the CLI, so environments drift apart quietly.
2. **There are no transactions to lean on.** A multi-statement request runs statement by statement. The docs say not to rely on a failing batch rolling back the earlier statements. A migration can therefore fail halfway, and the tool has to say so instead of pretending it was atomic.
3. **There is no restore.** Export is the only backup, so the tool must never re-run half-applied SQL on its own.

## Quickstart

```bash
npm install -D hk-migrate
npx harakumo login --key hk_live_…          # hk-migrate reuses this saved key
npx harakumo db create 12 app --engine sqlite # note the database id, e.g. 5

npx hk-migrate new create notes              # → migrations/0001_create_notes.sql
# write your SQL, then
npx hk-migrate up --db 5
```

Develop against a local file with the same files and the same semantics. This needs no key or network:

```bash
npx hk-migrate up --local dev.db
```

## Commands

| Command | What it does |
| --- | --- |
| `new <name>` | Creates `migrations/NNNN_<name>.sql`, numbered after the highest existing version. |
| `status` | Compares the files with the database: applied, pending, drifted, failed, interrupted, out of order, or missing. Read-only. It never creates tables. |
| `up [--to N] [--dry-run]` | Applies pending migrations in order under a database lock and stops at the first failure. |
| `verify [--require-up-to-date]` | CI gate. Exits 1 on anything that blocks `up`, and optionally on pending migrations. |
| `resolve <N> --applied \| --rolled-back` | Settles a failed, interrupted or drifted migration after a person has looked at the database. |
| `unlock` | Clears a lock left by a runner that died. |
| `mcp [--allow-apply]` | Serves the tools below to an AI agent over stdio. |

Targets: `--db <id>` (or `HARAKUMO_DB_ID`), or `--local <file>`. Authentication is checked in this order: `--key`, then `HARAKUMO_API_KEY`, then the key that `npx harakumo login` saved in `~/.harakumo/config.json`. Every command takes `--json`.

## How it stays safe

**State is written before and after each migration.** The tool records a migration as `running`, executes its SQL, then marks it `applied`. If a statement fails, it is marked `failed` with the database's error message. If the process dies, the row stays `running` with no lock holder, and `status` reports it as `interrupted`. In all of these cases `up` refuses to continue. You decide with `resolve`, because only a person can tell whether a half-applied `ALTER TABLE` should be undone or kept.

**A lock row keeps two runners apart.** `INSERT OR IGNORE` into a single-row table succeeds for exactly one runner, and every runner then reads back who won. The tool never parses constraint error messages. The lock is released in a `finally` block, and a runner that loses never deletes someone else's lock.

**Checksums catch edited history.** Changing a file after it was applied is reported as `drifted` and blocks `up`. Line endings and BOMs are normalized first, so a Windows checkout and Linux CI agree.

**Retries depend on whether a request can be safely repeated:**

| Response | Bookkeeping queries (idempotent) | Migration SQL |
| --- | --- | --- |
| 429 rate limited | retry with backoff | retry. The platform refused it before running anything |
| 502 / 503, network error | retry with backoff | **no retry.** It may already have run |
| 400 SQL error, 401, 402, 403 | fail | fail, with a hint for each status |

**Forward-only, by design.** On a platform with no restore, a "down" migration is untested code that runs on your worst day. To revert, write a new migration.

## Use it from code

```ts
import { HarakumoExecutor, loadMigrations, Migrator } from 'hk-migrate';

const migrator = new Migrator({
  executor: new HarakumoExecutor({ databaseId: 5, apiKey: process.env.HARAKUMO_API_KEY! }),
  migrations: await loadMigrations('./migrations'),
  onEvent: (e) => console.log(JSON.stringify(e)), // migration-start / -applied / -failed, lock events
});

const status = await migrator.status();
if (status.pending.length) await migrator.up();
```

`Executor` is a two-method interface (`query` and `exec`). `SqliteExecutor` implements it with Node's built-in `node:sqlite`, in the same autocommit, statement-by-statement mode as the edge.

## Use it from an agent (MCP)

```bash
claude mcp add hk-migrate -- npx hk-migrate mcp --db 5
```

| Tool | Notes |
| --- | --- |
| `migrations_status` | read-only |
| `migrations_plan` | read-only; returns pending SQL in order |
| `migration_create` | writes the next numbered file; does **not** apply it |
| `migrations_apply` | only with `--allow-apply`; annotated `destructiveHint` |

The default is read-only on purpose. An agent can turn "add a due date to notes" into a reviewed migration file. A person, or CI, runs `up`.

## CI

```yaml
- run: npx hk-migrate verify --db ${{ vars.HARAKUMO_DB_ID }}   # fail before deploying on drift / failures
- run: npx hk-migrate up --db ${{ vars.HARAKUMO_DB_ID }}
- run: npx harakumo deploy ${{ vars.HARAKUMO_PROJECT_ID }} ./dist
  env:
    HARAKUMO_API_KEY: ${{ secrets.HARAKUMO_API_KEY }}
```

Migrations run before the deploy, so schema changes need to be additive: add the column first, use it in the next release.

## Tests

```bash
npm test                                                       # 45 tests, no network
HARAKUMO_API_KEY=hk_live_… HARAKUMO_TEST_DB_ID=5 npm run test:live
```

The main suite runs real SQL against `node:sqlite` in edge-like autocommit mode. That means the partial-failure test leaves a real half-applied migration behind, as production would. It also covers drift, the lock, interrupted runs, out-of-order files, the CLI's exit codes, and the MCP server through an in-memory MCP client. The live suite runs the same flow against a real Harakumo database. It only uses tables with random names and drops them afterwards.

## Project layout

```
src/migrator.ts         state machine: status, plan, up, resolve, unlock, lock
src/executor.ts         Executor interface + HarakumoExecutor (SDK, retry policy)
src/sqlite-executor.ts  local node:sqlite executor
src/migrations.ts       file loading, naming, checksums
src/cli.ts, bin.ts      CLI (node:util parseArgs, no CLI framework)
src/mcp.ts              MCP server
```

## Notes on the SDK

While building this I found gaps between `@harakumo/sdk@0.1.0`, its type declarations, and the docs. One example: `databases.query` works at runtime but isn't in `index.d.ts`. See [FEEDBACK.md](FEEDBACK.md).

## License

MIT © neonflux-io. This is a community project and is not affiliated with Harakumo.
