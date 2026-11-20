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
import WalletService from "../src/services/wallet.service";

describe("NGN wallet history: top-ups and withdrawals only", () => {
    beforeAll(async () => {
        await startTestDatabase();
        await bootstrapLedger();
    });
    afterAll(stopTestDatabase);

    it("keeps bank fundings, own GHS top-ups and withdrawals, and leaves out GHS receipts, sends and exchanges", async () => {
        const user = await createUser();
        const [wallet] = await exec().select().from(wallets).where(eq(wallets.user, user.id));
        const tx = async (purpose?: "top_up") => (await exec().insert(transactions).values({
            user: user.id, reference: `T-${Math.random().toString(36).slice(2)}`, amount: 100, currency: "NGN", fromCurrency: "GHS",
            detailType: "fincra" as any, status: "completed" as any, ...(purpose ? { purpose } : {}),
        }).returning())[0].id;
        const entry = (type: string, description: string, transactionId?: string) => exec().insert(walletTransactions).values({
            wallet: wallet.id, user: user.id, type: type as any, status: "successful", amount: 10, description,
            reference: `W-${Math.random().toString(36).slice(2)}`, balanceBefore: 0, balanceAfter: 0, currency: "NGN",
            ...(transactionId ? { transactionId } : {}),
        });
        await entry("funding", "bank transfer");
        await entry("funding", "own GHS top-up", await tx("top_up"));
        await entry("funding", "GHS received from a payer", await tx());
        await entry("withdrawal", "withdrawal");
        await entry("transfer", "send");
        await entry("exchange", "exchange");

        const service = new WalletService();
        const view = await service.getTransactionHistory(user.id, { page: 1, limit: 20, currency: "NGN", topUpsAndWithdrawals: true });
        expect((view as any).data.map((r: any) => r.description).sort()).toEqual(["bank transfer", "own GHS top-up", "withdrawal"]);
        const all = await service.getTransactionHistory(user.id, { page: 1, limit: 20, currency: "NGN" });
        expect((all as any).data).toHaveLength(6);
    });
});
