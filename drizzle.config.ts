import "dotenv/config";
import { defineConfig } from "drizzle-kit";

/**
 * Migrations are generated from src/db/schema into ./drizzle and committed.
 *   npm run db:generate   – write a new migration after changing the schema
 *   npm run db:migrate    – apply pending migrations (uses DATABASE_URL)
 */
export default defineConfig({
    dialect: "postgresql",
    schema: "./src/db/schema/index.ts",
    out: "./drizzle",
    dbCredentials: {
        url: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/solution_pay",
    },
    strict: true,
    verbose: true,
});
