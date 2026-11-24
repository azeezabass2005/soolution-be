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
import dashboardService from "../src/services/dashboard.service";
import { lagosDayRange } from "../src/utils/date-range.utils";
import { exec } from "../src/repositories/utils";
import { transactionDetails, transactions, walletTransactions, wallets } from "../src/db/schema";

/** The admin dashboard's money: what moved through wallets, manual payments, and what's still open */
describe("admin dashboard", () => {
    beforeAll(async () => {
        await startTestDatabase();
        await bootstrapLedger();
        const user = await createUser();
        const [wallet] = await exec().select().from(wallets).where(eq(wallets.user, user.id));
        const entry = (type: string, amount: number, iso: string, status = "successful", transactionId?: string) => exec().insert(walletTransactions).values({
            wallet: wallet.id, user: user.id, type: type as any, status: status as any, amount, currency: "NGN",
            reference: `W-${Math.random().toString(36).slice(2)}`, balanceBefore: 0, balanceAfter: 0, createdAt: new Date(iso),
            ...(transactionId ? { transactionId } : {}),
        });
        const tx = async (iso: string, status: string, detailType: string, fromAmount?: number) => {
            const [t] = await exec().insert(transactions).values({
                user: user.id, reference: `T-${Math.random().toString(36).slice(2)}`, amount: 100, currency: "GHS", fromCurrency: "NGN",
                detailType: detailType as any, status: status as any, createdAt: new Date(iso),
            }).returning();
            if (fromAmount) await exec().insert(transactionDetails).values({ transactionId: t.id, type: detailType as any, fromAmount });
            return t.id;
        };

        // The 20th (Lagos): a ₦50,000 deposit (00:30 Lagos is still the 19th in UTC) and a ₦12,000 send from the wallet
        await entry("funding", 50_000, "2026-11-19T23:30:00Z");
        const send = await tx("2026-11-20T10:00:00Z", "completed", "fincra");
        await entry("transfer", 12_000, "2026-11-20T10:00:00Z", "successful", send);
        // The 21st: ₦8,000 received, ₦20,000 withdrawn, a failed deposit (not counted)
        const receive = await tx("2026-11-21T09:00:00Z", "completed", "yellowcard");
        await entry("funding", 8_000, "2026-11-21T09:00:00Z", "successful", receive);
        await entry("withdrawal", 20_000, "2026-11-21T11:00:00Z");
        await entry("funding", 99_999, "2026-11-21T12:00:00Z", "failed");
        // A manual Alipay payment paid by bank transfer (no wallet entry), and one waiting on us
        await tx("2026-11-21T13:00:00Z", "completed", "alipay", 30_000);
        await tx("2026-11-18T13:00:00Z", "awaiting_confirmation", "bank_transfer", 5_000);
    });
    afterAll(stopTestDatabase);

    it("adds up what moved through wallets, funding included, and counts every movement", async () => {
        const all = await dashboardService.getAdminDashboard();
        expect(all.flows).toMatchObject({ fundedNgn: 50_000, receivedNgn: 8_000, sentNgn: 12_000, paidOutNgn: 20_000 });
        expect(all.amountTransactedNgn).toBe(90_000);
        // Four wallet movements plus the manual payment made outside the wallet
        expect(all.transactionsCount).toBe(5);
        expect(all.manual).toEqual({ count: 1, volumeNgn: 30_000 });
        expect(all.pending).toMatchObject({ count: 1, manual: 1, awaitingConfirmation: 1 });
    });

    it("narrows to the dates picked, in Lagos days; pending stays what's open now", async () => {
        const day20 = await dashboardService.getAdminDashboard(lagosDayRange("2026-11-20", "2026-11-20"));
        expect(day20.flows).toMatchObject({ fundedNgn: 50_000, sentNgn: 12_000, receivedNgn: 0, paidOutNgn: 0 });
        expect(day20.transactionsCount).toBe(2);
        expect(day20.recentTransactions).toHaveLength(1);
        expect(day20.pending.count).toBe(1);
        // The user signed up today, so nobody signed up on the 20th
        expect(day20.totalUsers).toBe(0);

        const day21 = await dashboardService.getAdminDashboard(lagosDayRange("2026-11-21", "2026-11-21"));
        expect(day21.flows).toMatchObject({ fundedNgn: 0, receivedNgn: 8_000, paidOutNgn: 20_000 });
        expect(day21.manual).toEqual({ count: 1, volumeNgn: 30_000 });
        expect(day21.amountTransactedNgn).toBe(28_000);
    });
});
