# Feedback on @harakumo/sdk 0.1.0 and @harakumo/cli 0.1.0

I wrote these notes while building hk-migrate. Each item is checked against the published packages or the live docs at `/api/docs/*`, and ordered by how likely it is to cost a developer time.

## 1. Sixteen methods work at runtime but are missing from `index.d.ts`

TypeScript users get a compile error on working code. The most visible case is the one on the homepage:

```ts
await hk.databases.query(db, 'SELECT * FROM orders'); // TS2339: Property 'query' does not exist
```

Present in `index.js`, absent from `index.d.ts` (found by diffing the two programmatically):

```
databases.query      vectors.get       vectors.upsert    vectors.query
ai.embed             storage.deleteObject                functions.update
domains.add          domains.list      deployments.create
deployments.get      deployments.delete
auth.login           auth.verifyToken  auth.listUsers    auth.deleteUser
```

hk-migrate works around this with a narrow `DatabasesApi` interface and a cast. **Fix:** generate `index.d.ts` from the implementation, or write the SDK in TypeScript. A CI step that diffs the runtime keys against the declared keys would stop this from recurring. It's about 30 lines.

## 2. Declared types disagree with the API

| Where | Declared | Actual (docs) |
| --- | --- | --- |
| `databases.create` `engine` | `'postgres' \| 'mysql' \| 'redis'` | only `'sqlite'` works; the others return 501. The official CLI passes `'sqlite'`, which the types reject. |
| `vectors.create` `dimensions` | `384 \| 768 \| 1536 \| 3072` | 384, 768, 1024, 1536. 1024 (bge-large) is missing, and 3072 is refused. |
| `projects.list()` return | `{ projects }` | also returns `org`, which the CLI's `login` and `whoami` read |
| `databases.query` return | (undeclared) | `{ results, statements, meta }` |

## 3. Docs describe SDK methods that 0.1.0 doesn't have

The AI Gateway docs use `hk.ai.chat()`, `hk.ai.stream()` and `hk.ai.models()`. Version 0.1.0 only has `ai.generate()`, which posts to `/api/ai/playground`, and `ai.embed()`. A developer who copies the documented example gets `hk.ai.chat is not a function`. **Fix:** publish 0.2.0, or label those examples with the version that adds them.

## 4. `HarakumoError` drops what a caller needs to recover

- **`Retry-After` is lost.** The docs say to wait `Retry-After` seconds on a 429, but the error doesn't keep the response headers. hk-migrate has to fall back to blind exponential backoff.
- **`code` is buried.** The docs say errors often carry a machine-readable `code` (`usage_limit`, `ai_rate_limited`, …), but it's only reachable as `(err.body as any).code`.

**Fix:** add `err.code` and `err.retryAfter` (in seconds). Also consider built-in retry for 429, which is always safe because the platform refused the request before running it.

## 5. No batch method for SQL

`POST /api/databases/:id { batch: [...] }` counts once toward the 600 per 5 minutes rate limit, and the docs recommend it for bulk work. The SDK can't send it ("the SDK sends single statements"). Suggested signature:

```ts
hk.databases.batch(dbId, [{ sql, params }, …]): Promise<{ batch: { results, meta }[] }>
```

## 6. CLI

- `harakumo db query <id> "<sql>"` can't pass `params`, so the CLI encourages string-built SQL, which the database docs warn against. A `--param` flag that can be repeated would fix this.
- The hand-written argument parser treats any value starting with `--` as a flag, so `harakumo ai "--help me"` loses the prompt. `node:util` `parseArgs` handles this and adds no dependency.

## What I would build next

- **`harakumo db migrate` in the official CLI**, using this design: state rows, a lock, and checksums.
- **A server-side migration endpoint.** With the database's own transaction scope, a migration plus its history row could commit atomically. The `failed` and `interrupted` states would then go away entirely.
- **A Migrations tab** on the database page, showing history, drift, and who holds the lock.
- **`migrations_*` tools on harakumo.com/mcp**, so the hosted connector can make schema changes with a human approval step.
