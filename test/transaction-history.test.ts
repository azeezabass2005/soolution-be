import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/notification.utils", () => ({
    default: class {
        emailService = { sendNotificationEmail: vi.fn(), sendWelcomeEmail: vi.fn(), verifyConnection: vi.fn(async () => true) };
        sendTransactionNotification = vi.fn();
        notifyAdmins = vi.fn();
        sendNotification = vi.fn();
        initializeWhatsApp = vi.fn();
    },
}));

import { eq } from "drizzle-orm";
import { startTestDatabase, stopTestDatabase } from "./helpers/db";
import { bootstrapLedger, createUser } from "./helpers/fixtures";
import { exec } from "../src/repositories/utils";
import { transactions, walletTransactions, wallets } from "../src/db/schema";
import transactionRepository from "../src/repositories/transaction.repository";

/** The history page: transactions and wallet fundings paged together, newest first */
describe("transaction history with wallet fundings", () => {
    let user: string;
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 12, minute));

    beforeAll(async () => {
        await startTestDatabase();
        await bootstrapLedger();
        user = (await createUser()).id;
        const other = (await createUser()).id;
        const [wallet] = await exec().select().from(wallets).where(eq(wallets.user, user));
        const tx = async (minute: number, currency: string, status = "completed", owner = user) => (await exec().insert(transactions).values({
            user: owner, reference: `T${minute}`, amount: 100, currency, fromCurrency: "NGN",
            detailType: "bank" as any, status: status as any, createdAt: at(minute),
        }).returning())[0].id;
        const funding = (minute: number, status: string, transactionId?: string) => exec().insert(walletTransactions).values({
            wallet: wallet.id, user, type: "funding", status: status as any, amount: 5000, fee: 50, description: "Bank transfer",
            reference: `W${minute}`, balanceBefore: 0, balanceAfter: 4950, currency: "NGN", createdAt: at(minute),
            ...(transactionId ? { transactionId } : {}),
        });
        await tx(1, "RMB");
        await funding(2, "successful");
        await tx(3, "GHS", "failed");
        await funding(4, "successful", await tx(5, "NGN"));   // a top-up's funding: its transaction is already listed
        await funding(6, "pending");
        await tx(7, "KES");
        await tx(8, "NGN", "completed", other);
    });
    afterAll(stopTestDatabase);

    it("interleaves fundings with transactions by date and pages them together", async () => {
        const first = await transactionRepository.paginateHistory({ user }, { page: 1, limit: 3 });
        const second = await transactionRepository.paginateHistory({ user }, { page: 2, limit: 3 });
        expect(first.data.map((r: any) => r.reference)).toEqual(["T7", "W6", "T5"]);
        expect(second.data.map((r: any) => r.reference)).toEqual(["T3", "W2", "T1"]);
        expect(first.paginator.itemsCount).toBe(6);
        const w2: any = second.data[1];
        expect(w2).toMatchObject({ isFunding: true, detailType: "funding", status: "completed", amount: 5000, currency: "NGN" });
        expect(w2.details).toMatchObject({ type: "funding", fee: 50, balanceAfter: 4950 });
    });

    it("applies the status filter and search to fundings too", async () => {
        const done = await transactionRepository.paginateHistory({ user, status: "completed" }, { page: 1, limit: 20 });
        expect(done.data.map((r: any) => r.reference)).toEqual(["T7", "T5", "W2", "T1"]);
        const waiting = await transactionRepository.paginateHistory({ user, status: "in_progress" }, { page: 1, limit: 20 });
        expect(waiting.data.map((r: any) => r.reference)).toEqual(["W6"]);
        const found = await transactionRepository.paginateHistory({ user, search: "w2" }, { page: 1, limit: 20 });
        expect(found.data.map((r: any) => r.reference)).toEqual(["W2"]);
    });
});
