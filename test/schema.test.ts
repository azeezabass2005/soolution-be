import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { startTestDatabase, stopTestDatabase } from "./helpers/db";
import type { Database } from "../src/db/client";

describe("migrations", () => {
    let db: Database;
    beforeAll(async () => { db = await startTestDatabase(); });
    afterAll(stopTestDatabase);

    it("creates every table", async () => {
        // 28 + admin_roles and admin_invites (staff roles) + notifications + payout_holds + support_tickets and support_messages + treasury_expenses + admin_activity
        const result: any = await db.execute(sql`select count(*)::int as n from pg_tables where schemaname = 'public'`);
        const rows = result.rows ?? result;
        expect(rows[0].n).toBe(36);
    });
});
