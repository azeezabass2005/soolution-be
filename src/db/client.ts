import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type Schema = typeof schema;

/**
 * Anything that can run queries: the pooled database or an open transaction.
 * Repositories take one of these so the same method works inside and outside
 * a transaction.
 */
export type Database = PgDatabase<PgQueryResultHKT, Schema>;
export type Executor = Database;

export interface DatabaseOptions {
    url: string;
    ssl?: boolean;
    sslRejectUnauthorized?: boolean;
    poolMax?: number;
    statementTimeoutMs?: number;
}

let pool: Pool | null = null;
let current: Database | null = null;

/** Opens the connection pool and verifies it can reach the server */
export async function connectDatabase(options: DatabaseOptions): Promise<Database> {
    if (current) return current;
    pool = new Pool({
        connectionString: options.url,
        max: options.poolMax ?? 10,
        ssl: options.ssl ? { rejectUnauthorized: options.sslRejectUnauthorized ?? true } : undefined,
        statement_timeout: options.statementTimeoutMs,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        application_name: "solution-pay-api",
    });
    const client = await pool.connect();
    try {
        await client.query("select 1");
    } finally {
        client.release();
    }
    current = drizzle(pool, { schema }) as unknown as Database;
    return current;
}

export function getPool(): Pool | null {
    return pool;
}

/** The active database. Throws if nothing has connected yet. */
export function getDb(): Database {
    if (!current) {
        throw new Error("Database is not connected. Call connectDatabase() during startup (or setDatabase() in tests).");
    }
    return current;
}

/** Swap the database (tests use an in-memory Postgres) */
export function setDatabase(db: Database | null): void {
    current = db;
}

export async function closeDatabase(): Promise<void> {
    current = null;
    if (pool) {
        const closing = pool;
        pool = null;
        await closing.end();
    }
}

export function isDatabaseConnected(): boolean {
    return current !== null;
}

export { schema };
