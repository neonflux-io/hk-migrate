# Example: notes app schema

Three migrations for a small notes app: a table with an index, a many-to-many tag table, and an additive column.

```bash
# locally
npx hk-migrate status --local dev.db --dir examples/notes/migrations
npx hk-migrate up     --local dev.db --dir examples/notes/migrations

# on Harakumo
npx harakumo db create <projectId> notes --engine sqlite
npx hk-migrate up --db <databaseId> --dir examples/notes/migrations
npx harakumo db query <databaseId> "SELECT version, name, state, duration_ms FROM _hk_migrations"
```

[deploy.yml](deploy.yml) shows the deploy order for a GitHub Actions pipeline: verify, migrate, then deploy.
