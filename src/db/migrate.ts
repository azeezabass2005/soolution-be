/**
 * Applies pending SQL migrations from ./drizzle to MIGRATION_DATABASE_URL
 * (falls back to DATABASE_URL). Use a separate migration URL when the app's
 * own database role isn't allowed to change the schema.
 *
 *   npm run db:migrate          (after `npm run build`)
 *
 * Safe to run from several instances at once: a Postgres advisory lock makes
 * the others wait, then find nothing left to do. Uses only runtime
 * dependencies, so it works on a server installed with `npm ci --omit=dev`.
 */
import path from "path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import config from "../config/env.config";

const MIGRATION_LOCK_ID = 727_001; // arbitrary, unique to this app

async function run(): Promise<void> {
    const migrationsFolder = path.resolve(__dirname, "../../drizzle");
    // One connection, so the advisory lock and the migrations share a session
    const pool = new Pool({
        connectionString: process.env.MIGRATION_DATABASE_URL || config.DATABASE_URL,
        max: 1,
        ssl: config.DATABASE_SSL ? { rejectUnauthorized: config.DATABASE_SSL_REJECT_UNAUTHORIZED } : undefined,
        application_name: "solution-pay-migrate",
    });
    try {
        await pool.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
        try {
            await migrate(drizzle(pool), { migrationsFolder });
            console.log(`Migrations applied from ${migrationsFolder}`);
        } finally {
            await pool.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
        }
    } finally {
        await pool.end();
    }
}

run().catch((error) => {
    // Show the underlying Postgres error (Drizzle wraps it); migrations carry no secrets
    const cause = (error as { cause?: { message?: string; code?: string } })?.cause;
    console.error("Migration failed:", cause?.message ? `${cause.message} (${cause.code})` : error instanceof Error ? error.message : error);
    process.exit(1);
});
