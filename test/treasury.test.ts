import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/yellowcard.service", () => ({
    default: {
        getRates: vi.fn(async () => ({ rates: [{ code: "NGN", buy: 1500, sell: 1480 }, { code: "KES", buy: 150, sell: 150 }] })),
        getAccount: vi.fn(async () => ({ accounts: [{ currency: "USD", available: 0 }, { currency: "NGN", available: 1_000_000 }] })),
    },
}));
vi.mock("../src/services/fincra.service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/services/fincra.service")>();
    return { ...actual, default: { getBalances: vi.fn(async () => [{ currency: "NGN", available: 200_000 }, { currency: "GHS", available: 0 }]) } };
});
const alerts = vi.hoisted(() => [] as any[]);
vi.mock("../src/utils/notification.utils", () => ({
    default: class {
        emailService = { sendNotificationEmail: vi.fn(), verifyConnection: vi.fn(async () => true) };
        sendTransactionNotification = vi.fn();
        notifyAdmins = vi.fn(async (_e: string, cfg: any) => { alerts.push(cfg); });
        sendNotification = vi.fn();
        initializeWhatsApp = vi.fn();
    },
}));

import { resetTestDatabase, startTestDatabase, stopTestDatabase } from "./helpers/db";
import { bootstrapLedger, createUser } from "./helpers/fixtures";
import treasuryService from "../src/services/treasury.service";
import platformSettingsService from "../src/services/platform-settings.service";
import ycRateService from "../src/services/yc-rate.service";
import { exec } from "../src/repositories/utils";
import { transactionDetails, transactions, walletTransactions, wallets } from "../src/db/schema";
import { eq } from "drizzle-orm";

const ADMIN = "00000000-0000-4000-8000-000000000001";

describe("treasury", () => {
    beforeAll(startTestDatabase);
    afterAll(stopTestDatabase);
    beforeEach(async () => {
        await resetTestDatabase();
        await bootstrapLedger();
        platformSettingsService.clearCache();
        ycRateService.clearCache();
        alerts.length = 0;
    });

    it("splits revenue into fees and spread, gross after provider fees, net after recorded expenses", async () => {
        const row = (fee: number, spread: number | null, profit: number | null, volume: number) => ({ id: String(Math.random()), kind: "send" as const, userId: "u", userName: "", userEmail: "", reference: "r", at: new Date(), amount: 0, currency: "GHS", feeNgn: fee, spreadNgn: spread, profitNgn: profit, volumeNgn: volume });
        // Fee ₦150 of which the provider kept ₦30, spread ₦400 → keeps ₦520
        const summary = treasuryService.summarize([row(150, 400, 520, 10_000), row(50, null, null, 0)], 120);
        expect(summary).toMatchObject({ revenueNgn: 550, feesNgn: 150, spreadNgn: 400, providerFeesNgn: 30, grossProfitNgn: 520, expensesNgn: 120, netProfitNgn: 400, amountTransactedNgn: 10_000, notKnownYet: 1 });

        const e = await treasuryService.addExpense({ amountNgn: 2500, category: "Rebalancing", occurredOn: "2026-11-20", note: "Moved NGN to YellowCard" }, ADMIN);
        await treasuryService.addExpense({ amountNgn: "800", category: "Bank charges", occurredOn: "2026-11-22" }, ADMIN);
        expect((await treasuryService.expenses("2026-11-20", "2026-11-21")).map((x) => Number(x.amountNgn))).toEqual([2500]);
        await expect(treasuryService.addExpense({ amountNgn: -5, category: "x", occurredOn: "2026-11-20" }, ADMIN)).rejects.toMatchObject({ response_code: 400 });
        await treasuryService.removeExpense(e.id, ADMIN);
        expect(await treasuryService.expenses()).toHaveLength(1);
    });

    it("projects balances after money in motion, and alerts once when one is running low", async () => {
        const user = await createUser();
        // A ₦30,000 YellowCard send on its way (YellowCard settles in naira) and a ₦50,000 withdrawal in flight
        const [send] = await exec().insert(transactions).values({ user: user.id, reference: "YC-OUT", amount: 200, currency: "KES", fromCurrency: "NGN", detailType: "yellowcard" as any, status: "processing" as any }).returning();
        await exec().insert(transactionDetails).values({ transactionId: send.id, type: "yellowcard" as any, fromAmount: 30_300, feeAmount: 300 });
        const [wallet] = await exec().select().from(wallets).where(eq(wallets.user, user.id));
        await exec().insert(walletTransactions).values({ wallet: wallet.id, user: user.id, type: "withdrawal" as any, status: "processing" as any, amount: 50_000, currency: "NGN", reference: "WDR-1", balanceBefore: 0, balanceAfter: 0 });

        await platformSettingsService.updateSettings({ operations: { liquidity: { yellowcardNgnMin: 990_000, fincraNgnMin: 100_000 } } }, ADMIN);
        const [yc, fincra] = await treasuryService.liquidity();
        expect(yc).toMatchObject({ provider: "yellowcard", currency: "NGN", live: 1_000_000, committedOut: 30_000, projected: 970_000, minimum: 990_000 });
        expect(yc.low).toBe(true);
        expect(fincra).toMatchObject({ live: 200_000, committedOut: 50_000, projected: 150_000, low: false });

        expect(await treasuryService.checkLiquidity()).toBe(1);
        expect(alerts[0]).toMatchObject({ type: "liquidity.low", permission: "profit_balances", title: "YellowCard NGN balance is running low" });
        // Not again within six hours
        expect(await treasuryService.checkLiquidity()).toBe(0);
    });

    it("shows figures in USD at our selling rate when set, else YellowCard's", async () => {
        expect(await treasuryService.ngnPerUsd()).toEqual({ rate: 1480, source: "yellowcard" });
        await platformSettingsService.updateSettings({ pricing: { usd: { mode: "ours", buyNgn: 1600, sellNgn: 1550 } } }, ADMIN);
        expect(await treasuryService.ngnPerUsd()).toEqual({ rate: 1550, source: "ours" });
    });
});
