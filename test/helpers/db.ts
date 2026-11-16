import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import { schema, setDatabase, type Database } from "../../src/db/client";
import platformSettingsService from "../../src/services/platform-settings.service";

const migrationsFolder = path.resolve(__dirname, "../../drizzle");

let pglite: PGlite | null = null;
let pool: Pool | null = null;
let db: Database | null = null;

/**
 * A database with every migration applied, installed as the app's database.
 *
 * By default an in-memory Postgres (PGlite) per test file. Set
 * TEST_DATABASE_URL to run against a real PostgreSQL server through the same
 * node-postgres driver production uses (run with --no-file-parallelism, since
 * the files then share one database).
 */
export async function startTestDatabase(): Promise<Database> {
    const url = process.env.TEST_DATABASE_URL;
    if (url) {
        pool = new Pool({ connectionString: url, max: 10 });
        const instance = drizzlePg(pool, { schema });
        await migratePg(instance, { migrationsFolder });
        db = instance as unknown as Database;
    } else {
        pglite = new PGlite();
        const instance = drizzlePglite(pglite, { schema });
        await migratePglite(instance, { migrationsFolder });
        db = instance as unknown as Database;
    }
    setDatabase(db);
    await resetTestDatabase();
    return db;
}

/** Empties every table (between tests) */
export async function resetTestDatabase(): Promise<void> {
    if (!db) throw new Error("Test database not started");
    const result: any = await db.execute(sql`select tablename from pg_tables where schemaname = 'public'`);
    const names: string[] = (result.rows ?? result).map((row: { tablename: string }) => row.tablename);
    if (!names.length) return;
    await db.execute(sql.raw(`truncate table ${names.map((name) => `"${name}"`).join(", ")} restart identity cascade`));
    platformSettingsService.clearCache();
}

export async function stopTestDatabase(): Promise<void> {
    setDatabase(null);
    db = null;
    if (pglite) {
        await pglite.close();
        pglite = null;
    }
    if (pool) {
        await pool.end();
        pool = null;
    }
}
