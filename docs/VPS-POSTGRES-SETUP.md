# PostgreSQL on the VPS with Coolify: production + staging

Coolify runs everything as Docker containers, so PostgreSQL is set up as a **Coolify database resource**, not installed on the host. Plan:

- One Coolify **project** ("Solution Pay") with two **environments**: `production` and `staging`.
- Each environment has its **own PostgreSQL 17 container** and its own API app. They're fully separate: different passwords, volumes and backups, and staging can be wiped without touching production.
- The API reaches its database over Coolify's internal Docker network. **The database is never exposed to the internet.**
- Backups: Coolify's scheduled backups uploaded to Cloudflare R2.

Coolify's menu labels change a little between versions; if a label here doesn't match exactly, look for the nearest equivalent.

---

## 1. Firewall (on the VPS host)

```bash
sudo ufw default deny incoming
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 8000/tcp     # Coolify dashboard (better: give it a domain and close 8000)
sudo ufw enable
```

> **Important:** Docker publishes ports **around** UFW. If you switch on Coolify's **"Make it publicly available"** for a database, port 5432 is exposed to the internet even though UFW doesn't list it. Leave that switch **off** for both databases.

## 2. Project and environments

1. Coolify → **Projects → + Add** → name it `Solution Pay`.
2. In the project it creates `production`. Add a second environment, `staging`.

## 3. Create the two databases

Do this once in `production` and once in `staging`.

1. Open the environment → **+ New → Database → PostgreSQL**.
2. Settings, before the first start:

   | Field | Production | Staging |
   |---|---|---|
   | Name | `solution-pay-db-production` | `solution-pay-db-staging` |
   | Image | `postgres:17-alpine` | `postgres:17-alpine` |
   | Username | `solution_owner` | `solution_owner` |
   | Password | `openssl rand -hex 24` | a **different** `openssl rand -hex 24` |
   | Initial database | `solution_pay` | `solution_pay` |
   | Make it publicly available | **off** | **off** |

   Hex passwords never need escaping in a URL. Save them in your password manager.
3. **Resource limits** (database → Resource Limits): give production a memory limit, e.g. **1–2 GB** on a 4 GB VPS, and staging **512 MB**, so staging can't starve production.
4. **Start** both. Then copy the **Internal URL** shown on each database's page. It looks like:

   ```
   postgres://solution_owner:<password>@<container-name>:5432/solution_pay
   ```

   `<container-name>` is how the API container reaches the database on Coolify's network.

## 4. Create the app role (least privilege)

`solution_owner` is the container's superuser, so use it **only for migrations**. The API itself connects as `solution_app`, which can read and write rows but can't change tables.

Open each database → **Terminal** in Coolify (or on the host: `docker exec -it <container-name> psql -U solution_owner -d solution_pay`), run `psql -U solution_owner -d solution_pay`, then paste this, with a new password per environment:

```sql
CREATE ROLE solution_app LOGIN PASSWORD '<openssl rand -hex 24>' CONNECTION LIMIT 40;

REVOKE ALL ON DATABASE solution_pay FROM PUBLIC;
GRANT CONNECT ON DATABASE solution_pay TO solution_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO solution_app;
ALTER DEFAULT PRIVILEGES FOR ROLE solution_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO solution_app;
ALTER DEFAULT PRIVILEGES FOR ROLE solution_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO solution_app;
```

(Use `CONNECTION LIMIT 15` on staging.) This is the same setup I tested on PostgreSQL 17. Check it once the tables exist (after step 7):

```sql
-- connect as the app role: psql -U solution_app -d solution_pay
SELECT count(*) FROM accounts;      -- works
CREATE TABLE x (id int);            -- must fail: permission denied
```

## 5. Tune PostgreSQL

Coolify keeps the data directory on a volume, so settings made with `ALTER SYSTEM` survive restarts and redeploys. Run as `solution_owner` in each database's terminal. These values are for a 2 GB memory limit; scale `shared_buffers` (~25% of the limit) and `effective_cache_size` (~60%):

```sql
ALTER SYSTEM SET shared_buffers = '512MB';
ALTER SYSTEM SET effective_cache_size = '1200MB';
ALTER SYSTEM SET work_mem = '8MB';
ALTER SYSTEM SET maintenance_work_mem = '128MB';
ALTER SYSTEM SET max_connections = 100;
ALTER SYSTEM SET timezone = 'UTC';
ALTER SYSTEM SET log_min_duration_statement = '500ms';
ALTER SYSTEM SET log_lock_waits = on;
ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements';
```

Then **Restart** the database in Coolify and run:

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
SHOW shared_buffers;   -- confirms the settings applied
```

For staging (512 MB limit), use `shared_buffers = '128MB'` and `effective_cache_size = '300MB'`.

## 6. The API apps

In each environment: **+ New → Application → your GitHub repo** (`soolution-be`). Use the `main` branch for production and your staging branch (e.g. `dev`) for staging.

### Build and start

| Setting | Value |
|---|---|
| Build pack | Nixpacks |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Start command | `node dist/db/migrate.js && node dist/index.js` |
| Port (exposes) | `3500` |
| Health check path | `/health` |
| Domain | `https://api.solutionpay.co` (prod) / `https://api-staging.solutionpay.co` (staging) |

The start command **runs the migrations on every deploy before the API starts**. It's safe: it only applies new migrations and holds a lock, so two containers starting at once can't apply them twice. If a migration fails, the new container doesn't start and Coolify keeps the old one running.

### Environment variables

Set these in each app's **Environment Variables** tab. Use the internal hostname from step 3 and the matching environment's passwords.

```env
NODE_ENV=production
PORT=3500
DATABASE_URL=postgres://solution_app:<app password>@<container-name>:5432/solution_pay
MIGRATION_DATABASE_URL=postgres://solution_owner:<owner password>@<container-name>:5432/solution_pay
DATABASE_SSL=false
DATABASE_POOL_MAX=10          # 5 on staging
DATABASE_STATEMENT_TIMEOUT_MS=30000
```

- **Uncheck "Build Variable" on `NODE_ENV`** (make it runtime only). With `NODE_ENV=production` at build time, `npm ci` skips devDependencies, so `typescript` is missing and `npm run build` fails.
- **Use `NODE_ENV=production` on staging too.** The code only turns on secure cookies and hides internal errors when it's exactly `production`. Staging and production are told apart by their variables, not `NODE_ENV`.
- `DATABASE_SSL=false` is correct: the traffic stays inside the VPS's Docker network.
- Remove `MONGODB_URI`.
- Staging gets **different secrets** (`JWT_SECRET`, `IDENTITY_HASH_SECRET`, `IDENTITY_ENCRYPTION_KEY`) and **sandbox provider keys** (Paystack `sk_test_`, YellowCard sandbox, …). Staging must never be able to move real money.
- Copy the rest of your current `.env` (mail, R2, providers, …) into each environment.

### Other app settings

- **Replicas: 1.** Background jobs (sweeper, reconciliation, cleanup) run in every container. If you ever scale to more than one, set `DISABLE_JOBS=true` on all but one.
- **Persistent storage:** add a volume for `/app/.wwebjs_auth` (WhatsApp session) and `/app/logs`, or they're lost on every redeploy. (Check the app's working directory in the container; Nixpacks uses `/app`.)
- WhatsApp (`whatsapp-web.js`) needs Chromium in the container, which a plain Nixpacks Node image doesn't include. The app logs the failure and keeps running, but WhatsApp notifications won't work until you add Chromium (for example with a Dockerfile). This is separate from the database.

## 7. First deploy

1. Deploy **staging** first. Watch the deployment log for `Migrations applied` and then `Server started`.
2. Check:

   ```bash
   curl -s https://api-staging.solutionpay.co/health     # "database": true
   ```

   In the database terminal: `SELECT count(*) FROM accounts;` (60+ rows: the app creates the system ledger accounts on start). Then run the role check from step 4.
3. Register a test user on staging and try a wallet flow with sandbox keys.
4. Repeat for **production**.

## 8. Backups to Cloudflare R2

1. In Cloudflare, create a private R2 bucket (e.g. `solution-pay-db-backups`) and an R2 API token limited to that bucket.
2. Coolify → **Storages → + Add** (S3-compatible):
   - Endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
   - Region: `auto`
   - Bucket, access key and secret from the token.
   Click **Validate**.
3. Each database → **Backups → + Add scheduled backup**:

   | | Production | Staging |
   |---|---|---|
   | Frequency (cron) | `0 * * * *` (hourly) | `0 3 * * *` (daily) |
   | Save to S3 | on, the R2 storage | on |
   | Keep locally / in S3 | e.g. 48 / 30 days | 3 / 7 days |

   Click **Backup now** once and confirm the file appears in R2.

**What these backups are:** full `pg_dump` snapshots. If the server dies you lose at most the time since the last backup (up to one hour with the schedule above). There's no "restore to any second" (point-in-time recovery) in this setup. For a payments business, once you have real volume, consider moving production to a managed Postgres that includes point-in-time recovery (Neon, Supabase, DigitalOcean, AWS RDS). The app only needs a new `DATABASE_URL`.

### Test a restore (before going live, then every quarter)

Never test on the production database. Restore into a scratch database inside the **staging** container:

```bash
# on the VPS host: download a production dump from R2 (or use one Coolify kept locally), then
docker exec -i <staging-container> createdb -U solution_owner restore_check
docker exec -i <staging-container> pg_restore -U solution_owner -d restore_check --no-owner < backup-file
docker exec -it <staging-container> psql -U solution_owner -d restore_check -c "select count(*) from users;"
docker exec -it <staging-container> dropdb -U solution_owner restore_check
```

If `pg_restore` says the file isn't an archive, it's a plain SQL dump: use `psql -U solution_owner -d restore_check < backup-file` instead. Drop `restore_check` afterwards: it holds production personal data.

## 9. Admin access and monitoring

**Quick queries:** the database's **Terminal** tab in Coolify, or `docker exec -it <container-name> psql -U solution_owner -d solution_pay` on the host.

**GUI client (TablePlus, DBeaver) from your laptop**, without exposing the port:

```bash
# on the VPS: find the container's IP
docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' <container-name>
# on your laptop
ssh -N -L 5433:<that-ip>:5432 you@your-vps
# then connect to localhost:5433
```

**Useful checks:**

```sql
-- connections by role
SELECT usename, count(*) FROM pg_stat_activity GROUP BY 1;
-- slowest queries
SELECT round(mean_exec_time) AS ms, calls, left(query, 80) FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;
-- size
SELECT pg_size_pretty(pg_database_size('solution_pay'));
```

On the host, watch disk space with `df -h`. Docker volumes and local backups grow; a full disk stops Postgres.

Also watch the app's hourly reconciliation report and its alerts (admin dashboard); it's the money-level health check.

## 10. Rules for staging

- **Never copy production data into staging.** It contains encrypted BVN/NIN numbers and personal data. Create test users on staging.
- Point each provider's **sandbox** webhooks at the staging domain and **live** webhooks only at production.
- To reset staging: stop the staging app, then in the staging DB terminal run `DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;`, re-run the grants from step 4, and redeploy (migrations recreate everything).

## 11. Go-live checklist

- [ ] Both databases have "Make it publicly available" **off**
- [ ] Production and staging use different database passwords, app secrets and provider keys
- [ ] `NODE_ENV` is a runtime-only variable (not a build variable)
- [ ] Staging deploy log shows `Migrations applied` and `/health` reports `"database": true`
- [ ] App role can read and write but `CREATE TABLE` fails
- [ ] R2 storage validated; a manual backup reached R2; a restore was tested
- [ ] App replicas = 1 (or `DISABLE_JOBS=true` on extras)
- [ ] Before switching off Mongo: in-flight transactions finished and wallet balances paid out or announced (the new database starts empty). Deposits into old Paystack virtual accounts will show up in Admin → Suspense for manual attribution.
- [ ] Saved in the password manager: 4 database passwords, R2 token
