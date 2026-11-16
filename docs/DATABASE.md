# Database (PostgreSQL)

The API stores everything in PostgreSQL through [Drizzle ORM](https://orm.drizzle.team) and the `pg` driver.

## How the code is layered

```
routes → controllers → services → repositories → PostgreSQL
```

| Layer | Where | Rule |
|---|---|---|
| Schema | `src/db/schema/*.ts` | One file per area. Column names are explicit snake_case. |
| Migrations | `drizzle/*.sql` | Generated from the schema and committed. Never edit an applied migration. |
| DB plumbing | `src/db/` | `client.ts` (pool), `transaction.ts` (`withTransaction`), `errors.ts` (Postgres error codes), `pagination.ts`, `migrate.ts` |
| Repositories | `src/repositories/*.repository.ts` | **All SQL lives here.** Methods take an optional `tx` so they work inside or outside a transaction. They return entities (`src/types/entities.ts`): NULL columns come back as missing fields, as Mongo did. |
| Services | `src/services/*.service.ts` | Business logic. They call repositories, never Drizzle directly. |
| Controllers | `src/controllers/**` | HTTP only. They call services, never repositories. |

### Money and transactions

- Amounts and rates are `numeric` (exact decimals) and read back as JS numbers. Increments happen in SQL (`balance = balance + x`), so they're atomic and exact.
- Anything that writes more than one row goes through `withTransaction(async (tx) => …)`. Pass `tx` to every repository call and to `ledgerService.post({ …, tx })` so everything commits or rolls back together.
- `withTransaction` retries on deadlock or serialization failure, which re-runs the callback. **Never put HTTP calls, emails or other side effects inside it.** Call providers before or after.
- Races are settled by the database, not by read-then-write checks:
  - wallet debits are conditional updates (`… where balance >= amount`), plus a `CHECK (balance >= 0)`
  - webhook/poll settlement uses `updateIfStatus` / `claim` (only one caller moves a status)
  - a Paystack reference can fund a wallet only once (partial unique index)
  - refresh tokens, idempotency keys, FX quotes and suspense attribution are claimed atomically
- Postgres has no TTL indexes. `jobs/cleanup.job.ts` deletes expired idempotency keys, FX quotes and limit locks every hour.

### API compatibility

Ids are UUIDs. Every JSON response object with an `id` also gets an `_id` alias (`src/utils/json.utils.ts`), and list endpoints keep the `{ data, paginator: { itemsCount, perPage, … } }` shape. The frontend needs no changes.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/solution_pay` | Connection string for the app |
| `MIGRATION_DATABASE_URL` | `DATABASE_URL` | Optional: a schema-owner role for `npm run db:migrate` (see roles below) |
| `DATABASE_SSL` | `false` | `true` for managed databases or any connection leaving the machine |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | `true` | Set `false` only for self-signed certificates |
| `DATABASE_POOL_MAX` | `10` | Connections per app instance |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `30000` | Aborts runaway queries |

`MONGODB_URI` is no longer used.

## Local development

```bash
# 1. Postgres 16 or 17, any way you like, e.g.
docker run -d --name solution-pay-pg -e POSTGRES_USER=solution -e POSTGRES_PASSWORD=solution \
  -e POSTGRES_DB=solution_pay -p 5432:5432 postgres:17
#    (Docker needs your user in the docker group: `sudo usermod -aG docker $USER`, then log in again)

# 2. .env
DATABASE_URL=postgres://solution:solution@localhost:5432/solution_pay

# 3. Create the tables, then run the app
npm run build && npm run db:migrate
npm run dev
```

The app creates the system ledger accounts on startup.

## Changing the schema

1. Edit `src/db/schema/*.ts`.
2. `npm run db:generate -- --name short_description`. This writes `drizzle/NNNN_short_description.sql`.
3. Read the generated SQL (renames can come out as drop + add; fix those by hand before committing).
4. `npm run build && npm run db:migrate` locally, then `npm test`.
5. Commit the schema change and the migration together.

## Tests

```bash
npm test                     # in-memory Postgres (PGlite); nothing to install
npm run typecheck            # app + tests

# Against a real PostgreSQL server (same driver as production; real concurrency)
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/solution_pay_test npm run test:pg
```

`TEST_DATABASE_URL` must point at a throwaway database: the tests truncate every table.

## Deploying (staging and production)

Every deploy runs the same steps:

```bash
npm ci
npm run build
npm run db:migrate      # applies any new migrations; safe to run every time
# restart the app (pm2 / systemd / docker)
```

- Ship the `drizzle/` folder with the build: `db:migrate` reads it at runtime.
- `db:migrate` takes an advisory lock, so two servers deploying at once can't run migrations twice.
- Migrate **before** starting the new code. Keep migrations backwards compatible (add columns as nullable or with defaults, drop columns only once no running code uses them), so the old version keeps working during the rollout.
- **Background jobs run inside every app process.** Run one instance, or set `DISABLE_JOBS=true` on all but one (for example with PM2 cluster mode). Otherwise the sweeper and reconciliation run once per process.

### Database roles (recommended)

Run migrations as a schema owner and the app as a role that can only read and write data:

```sql
-- as a superuser / admin
CREATE ROLE solution_owner LOGIN PASSWORD '<strong password>';
CREATE ROLE solution_app   LOGIN PASSWORD '<strong password>';
CREATE DATABASE solution_pay OWNER solution_owner;

-- connected to solution_pay
REVOKE ALL ON DATABASE solution_pay FROM PUBLIC;
GRANT CONNECT ON DATABASE solution_pay TO solution_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO solution_owner;
GRANT USAGE ON SCHEMA public TO solution_app;
ALTER DEFAULT PRIVILEGES FOR ROLE solution_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO solution_app;
ALTER DEFAULT PRIVILEGES FOR ROLE solution_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO solution_app;
```

Then `MIGRATION_DATABASE_URL` uses `solution_owner` and `DATABASE_URL` uses `solution_app`. This setup was tested on PostgreSQL 17: the app role can read and write rows but cannot create or drop tables.

### Connections

`instances × DATABASE_POOL_MAX` (+ a few for admin and migrations) must stay below the server's `max_connections` (100 by default). With more instances than that allows, put PgBouncer (transaction mode) in front.

### Backups

- Managed Postgres: turn on daily backups **and** point-in-time recovery (PITR).
- Self-hosted: WAL archiving with pgBackRest or WAL-G to off-server storage (S3/R2) for PITR, plus a nightly `pg_dump -Fc` copied off the server.
- Test a restore into a scratch database before going live, then every quarter. A backup you haven't restored isn't a backup.
