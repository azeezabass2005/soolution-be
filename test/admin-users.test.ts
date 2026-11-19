import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/notification.utils", () => ({
    default: class {
        emailService = { sendNotificationEmail: vi.fn(), sendWelcomeEmail: vi.fn(), verifyConnection: vi.fn(async () => true) };
        sendTransactionNotification = vi.fn();
        notifyAdmins = vi.fn();
        sendNotification = vi.fn();
        initializeWhatsApp = vi.fn();
    },
}));

import { resetTestDatabase, startTestDatabase, stopTestDatabase } from "./helpers/db";
import { bootstrapLedger, createUser, fundWallet } from "./helpers/fixtures";
import adminUsersService from "../src/services/admin-users.service";
import userRepository from "../src/repositories/user.repository";
import transactionLimitService from "../src/services/transaction-limit.service";
import { exec } from "../src/repositories/utils";
import { fxConversions, transactionDetails, transactions, walletTransactions, wallets } from "../src/db/schema";
import adminProfitService from "../src/services/admin-profit.service";
import { eq } from "drizzle-orm";

const ADMIN = "00000000-0000-4000-8000-000000000001";

/** A successful entry in the user's NGN wallet */
const entry = async (userId: string, type: string, amount: number, transactionId?: string) => {
    const [wallet] = await exec().select().from(wallets).where(eq(wallets.user, userId));
    await exec().insert(walletTransactions).values({
        wallet: wallet.id, user: userId, type: type as any, status: "successful", amount,
        reference: `T-${Math.random().toString(36).slice(2)}`, balanceBefore: 0, balanceAfter: 0, currency: "NGN",
        ...(transactionId ? { transactionId } : {}),
    });
};
const ghsTx = async (userId: string, amount: number, purpose?: "top_up") => {
    const [row] = await exec().insert(transactions).values({
        user: userId, reference: `GHS-${Math.random().toString(36).slice(2)}`, amount, currency: "NGN", fromCurrency: "GHS",
        detailType: "fincra" as any, status: "completed" as any, ...(purpose ? { purpose } : {}),
    }).returning();
    return row.id;
};

describe("admin view of users", () => {
    beforeAll(startTestDatabase);
    afterAll(stopTestDatabase);
    beforeEach(async () => {
        await resetTestDatabase();
        await bootstrapLedger();
    });

    it("splits a user's naira into funded, received, topped up, sent and withdrawn", async () => {
        const user = await createUser();
        await fundWallet(user.id, 1_000);
        await entry(user.id, "funding", 50_000);                                   // bank transfer in
        await entry(user.id, "funding", 9_850, await ghsTx(user.id, 100));          // a customer paid a link
        await entry(user.id, "funding", 19_700, await ghsTx(user.id, 200, "top_up")); // they topped up themselves
        await entry(user.id, "transfer", 30_000);
        await entry(user.id, "withdrawal", 5_000);

        const stats = (await adminUsersService.moneyStats([user.id])).get(user.id)!;
        expect(stats).toMatchObject({ fundedNgn: 50_000, receivedNgn: 9_850, toppedUpNgn: 19_700, toppedUpGhs: 200, sentNgn: 30_000, withdrawnNgn: 5_000 });
        expect(stats.balanceNgn).toBeGreaterThan(0);
    });

    it("flags accounts with the same phone number, or the same name and date of birth", async () => {
        const a = await createUser({ firstName: "Ada", lastName: "Obi", phoneNumber: "+2348031234567" });
        const b = await createUser({ firstName: "Ada", lastName: "Obi", phoneNumber: "08031234567" });
        const c = await createUser({ firstName: "ada", lastName: "OBI", identityDob: "1990-01-01" } as any);
        const d = await createUser({ firstName: "Ada", lastName: "Obi", identityDob: "1990-01-01" } as any);
        const e = await createUser({ firstName: "Someone", lastName: "Else" });
        const index = adminUsersService.duplicateIndex(await userRepository.listAll());
        expect(index.get(a.id)?.map((m) => m.userId)).toEqual([b.id]);
        expect(index.get(a.id)?.[0].reasons).toEqual(["Same phone number"]);
        expect(index.get(c.id)?.[0]).toMatchObject({ userId: d.id, reasons: ["Same name and date of birth"] });
        expect(index.get(e.id)).toBeUndefined();
    });

    it("suspends (ending sessions), freezes, and sets a personal daily limit", async () => {
        const user = await createUser();
        await adminUsersService.updateControls(user.id, { status: "suspended" }, ADMIN);
        let saved = await userRepository.findById(user.id);
        expect(saved).toMatchObject({ status: "suspended" });
        expect(saved?.sessionsValidAfter).toBeTruthy();

        await adminUsersService.updateControls(user.id, { status: "active", freeze: "balance", freezeReason: "Chargeback under review" }, ADMIN);
        saved = await userRepository.findById(user.id);
        expect(saved).toMatchObject({ status: "active", freeze: "balance", freezeReason: "Chargeback under review" });
        await adminUsersService.updateControls(user.id, { freeze: "none" }, ADMIN);
        expect((await userRepository.findById(user.id))?.freezeReason).toBeUndefined();

        const before = await transactionLimitService.getStatus(user.id);
        await adminUsersService.updateControls(user.id, { dailyLimitOverrideNgn: 75_000_000 }, ADMIN);
        expect((await transactionLimitService.getStatus(user.id)).limitNgn).toBe(75_000_000);
        await adminUsersService.updateControls(user.id, { dailyLimitOverrideNgn: null }, ADMIN);
        expect((await transactionLimitService.getStatus(user.id)).limitNgn).toBe(before.limitNgn);

        await expect(adminUsersService.updateControls(user.id, { freeze: "everything" }, ADMIN)).rejects.toMatchObject({ response_code: 400 });
    });

    it("gives one user's overview", async () => {
        const user = await createUser();
        await fundWallet(user.id, 2_000);
        const overview = await adminUsersService.overview(user.id);
        expect(overview.user).toMatchObject({ id: user.id, freeze: "none", status: "active" });
        expect(overview.wallets.find((w) => w.currency === "NGN")?.balance).toBe(2_000);
        expect(overview.duplicates).toEqual([]);
    });

    it("works out profit per transaction, and per user flow", async () => {
        const user = await createUser({ firstName: "Kemi", lastName: "Balogun" });
        await fundWallet(user.id, 100);
        const mk = async (fromCurrency: string, currency: string, amount: number, details: Record<string, unknown>) => {
            const [t] = await exec().insert(transactions).values({
                user: user.id, reference: `R-${Math.random().toString(36).slice(2)}`, amount, currency, fromCurrency,
                detailType: "fincra" as any, status: "completed" as any,
            }).returning();
            await exec().insert(transactionDetails).values({ transactionId: t.id, type: "fincra" as any, ...details } as any);
            return t.id;
        };
        // Send 100 GHS: user paid ₦12,050 (₦12,000 + ₦50 fee, 0.25% of it Fincra's); Fincra charged ₦11,500
        await mk("NGN", "GHS", 100, { fromAmount: 12_050, feeAmount: 50, providerFeePercent: 0.25, providerCost: 11_500 });
        // Receive 100 GHS: user credited ₦11,000 after a ₦100 fee (1% of the gross was Fincra's); converted for ₦11,600
        const received = await mk("GHS", "NGN", 100, { fromAmount: 11_000, feeAmount: 100, providerFeePercent: 1 });
        await exec().insert(fxConversions).values({ transactionId: received, provider: "fincra", sourceCurrency: "GHS", destinationCurrency: "NGN", sourceAmount: 100, bookedNgn: 11_100, status: "successful", amountReceived: 11_600 } as any);
        // Another receive not converted yet: profit unknown
        await mk("GHS", "NGN", 50, { fromAmount: 5_500, feeAmount: 50, providerFeePercent: 1 });
        // A bank deposit with ₦200 SolutionPay fee
        const [wallet] = await exec().select().from(wallets).where(eq(wallets.user, user.id));
        await exec().insert(walletTransactions).values({ wallet: wallet.id, user: user.id, type: "funding", status: "successful", amount: 49_800, fee: 200, reference: "DEP-1", balanceBefore: 0, balanceAfter: 0, currency: "NGN" } as any);

        const rows = await adminProfitService.rows({ userId: user.id });
        const send = rows.find((r) => r.kind === "send")!;
        // Profit ₦12,050 − ₦11,500 = ₦550; our fee part ₦50 − ₦30 (0.25% of ₦12,000) = ₦20; spread ₦530
        expect(send).toMatchObject({ profitNgn: 550, feeNgn: 50, spreadNgn: 530, userName: "Kemi Balogun" });
        const receives = rows.filter((r) => r.kind === "receive");
        // Profit ₦11,600 − ₦11,000 = ₦600; our fee part ₦100 − ₦111 (1% of ₦11,100) = −₦11; spread ₦611
        expect(receives.find((r) => r.profitNgn !== null)).toMatchObject({ profitNgn: 600, spreadNgn: 611 });
        expect(receives.find((r) => r.profitNgn === null)?.note).toBe("Not converted to naira");
        expect(rows.find((r) => r.kind === "fund")).toMatchObject({ profitNgn: 200, feeNgn: 200 });

        const flows = adminProfitService.flows(rows);
        expect(flows.find((f) => f.flow === "fund_send")).toMatchObject({ count: 2, profitNgn: 750 });
        expect(flows.find((f) => f.flow === "receive_withdraw")).toMatchObject({ count: 2, profitNgn: 600, pending: 1 });
        expect(adminProfitService.totals(rows)).toMatchObject({ count: 4, profitNgn: 1_350, pending: 1 });

        expect((await adminProfitService.rows({ userId: user.id, kinds: ["send"] })).every((r) => r.kind === "send")).toBe(true);
    });

    it("puts provider balances next to our books, and copes with a provider being unreachable", async () => {
        const { default: fincraService } = await import("../src/services/fincra.service");
        const { default: yellowCardService } = await import("../src/services/yellowcard.service");
        const { default: adminBalancesService } = await import("../src/services/admin-balances.service");
        const fincraSpy = vi.spyOn(fincraService, "getBalances").mockResolvedValue([{ currency: "NGN", available: 1_000, ledger: 1_000 }, { currency: "GHS", available: 25, ledger: 25 }]);
        const ycSpy = vi.spyOn(yellowCardService, "getAccount").mockRejectedValue(new Error("YellowCard is off"));
        try {
            const report = await adminBalancesService.report();
            const fincra = report.providers.find((p) => p.provider === "fincra")!;
            expect(fincra.live).toEqual([{ currency: "NGN", available: 1_000 }, { currency: "GHS", available: 25 }]);
            expect(fincra.books.map((b) => b.currency).sort()).toEqual(expect.arrayContaining(["NGN", "GHS"]));
            const yc = report.providers.find((p) => p.provider === "yellowcard")!;
            expect(yc.live).toBeNull();
            expect(yc.error).toBe("YellowCard is off");
            const ngn = report.total.find((t) => t.currency === "NGN")!;
            expect(ngn.live).toBe(1_000);
            expect(ngn.difference).toBe(ngn.live - ngn.books);
        } finally {
            fincraSpy.mockRestore();
            ycSpy.mockRestore();
        }
    });
});
