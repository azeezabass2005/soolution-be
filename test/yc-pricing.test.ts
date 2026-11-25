import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/yellowcard.service", () => ({
    default: {
        // ₦1,500 (buy) / ₦1,480 (sell) per USD; KES 150 (sell) / 152 (buy) per USD
        getRates: vi.fn(async () => ({ rates: [{ code: "NGN", buy: 1500, sell: 1480 }, { code: "KES", buy: 152, sell: 150 }] })),
        getCountryConfig: vi.fn(async (_c: string, currency: string) => ({ currency, send: true, receive: true, sendMin: 0, sendMax: 0, receiveMin: 0, receiveMax: 0, channelTypes: ["momo"] })),
        getNetworks: vi.fn(async () => ({ networks: [{ id: "net-1", name: "Mpesa", status: "active", accountNumberType: "phone" }] })),
        submitPaymentRequest: vi.fn(),
        flowCurrencies: vi.fn(async () => ({ send: ["KES"], receive: ["KES"], markets: { send: [{ currency: "KES", country: "KE" }], receive: [{ currency: "KES", country: "KE" }] }, unavailable: {} })),
    },
}));
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
import { bootstrapLedger, createUser, fundWallet, TEST_PIN } from "./helpers/fixtures";
import ycRateService from "../src/services/yc-rate.service";
import platformSettingsService from "../src/services/platform-settings.service";
import currencyAccessService from "../src/services/currency-access.service";
import TransactionService from "../src/services/transaction.service";
import adminProfitService from "../src/services/admin-profit.service";
import userRepository from "../src/repositories/user.repository";
import { exec } from "../src/repositories/utils";
import { eq } from "drizzle-orm";
import { transactionDetails, transactions } from "../src/db/schema";

const ADMIN = "00000000-0000-4000-8000-000000000001";
const ZERO = { percent: 0, fixed: 0, min: 0, cap: 0 };

describe("YellowCard currencies priced like GHS", () => {
    beforeAll(startTestDatabase);
    afterAll(stopTestDatabase);
    beforeEach(async () => {
        await resetTestDatabase();
        await bootstrapLedger();
        platformSettingsService.clearCache();
        ycRateService.clearCache();
    });

    it("bridges through USD the way YellowCard quotes, both ways", async () => {
        const send = await ycRateService.providerRate("send", "KES");
        const receive = await ycRateService.providerRate("receive", "KES");
        // Send: we buy USD at ₦1,500 and YellowCard pays KES 150 per USD → ₦10 per KES
        expect(send).toMatchObject({ rate: 10, ngnPerUsd: 1500, usdSource: "yellowcard" });
        // Receive: KES 152 per USD collected, sold at ₦1,480 → ₦9.7368 per KES
        expect(receive.rate).toBeCloseTo(1480 / 152, 6);
    });

    it("keeps today's prices (the global markup and fees) until someone saves the currency", async () => {
        await platformSettingsService.updateSettings({ rateMarkupPercent: 2, additionalFeePercent: 1, providerBaseFeePercent: { yellowcard: 0.5 } }, ADMIN);
        const price = await ycRateService.price("send", "KES", 100);
        expect(price.userRate).toBeCloseTo(10.2, 6);
        expect(price.subtotalNgn).toBe(1020);
        // 1.5% of the subtotal, as computeFee("yellowcard") charged
        expect(price.feeAmount).toBeCloseTo(15.3, 2);
        expect(await platformSettingsService.inheritedYellowCardPairs()).toContainEqual({ op: "send", pair: "NGN-KES" });
    });

    it("uses the pair's own buffer, fees and limits once saved, and our USD rate when switched on", async () => {
        await platformSettingsService.updateSettings({
            pricing: {
                send: { "NGN-KES": { rate: { percent: 0, fixed: 0.5 }, providerFee: ZERO, platformFee: { ...ZERO, fixed: 10 }, feeCurrency: "KES", limits: { min: 50, max: 10_000 } } },
                usd: { mode: "ours", buyNgn: 1600, sellNgn: 1450 },
            },
        }, ADMIN);
        const price = await ycRateService.price("send", "KES", 100);
        // Our ₦1,600 per USD / KES 150 = ₦10.6667, plus a ₦0.50 buffer
        expect(price.providerRate).toBeCloseTo(1600 / 150, 6);
        expect(price.userRate).toBeCloseTo(1600 / 150 + 0.5, 6);
        expect(price.usdSource).toBe("ours");
        // KES 10 fee at the user's rate
        expect(price.feeAmount).toBeCloseTo(10 * (1600 / 150 + 0.5), 2);
        await expect(ycRateService.assertWithinLimits("send", "KES", 20)).rejects.toThrow("The smallest amount per transaction is KES 50.");
        expect(await platformSettingsService.inheritedYellowCardPairs()).not.toContainEqual({ op: "send", pair: "NGN-KES" });
        // Receives use our selling rate
        expect((await ycRateService.providerRate("receive", "KES")).rate).toBeCloseTo(1450 / 152, 6);
    });

    it("applies a pair's minimum fee to small amounts and gives the fee in both currencies", async () => {
        await platformSettingsService.updateSettings({
            pricing: { send: { "NGN-KES": { rate: { percent: 0, fixed: 0 }, providerFee: ZERO, platformFee: { percent: 1, fixed: 0, min: 20, cap: 0 }, feeCurrency: "KES", limits: { min: 0, max: 0 } } } },
        }, ADMIN);
        const small = await ycRateService.price("send", "KES", 100);
        // 1% of KES 100 is KES 1, raised to the KES 20 minimum
        expect(small.feeInCurrency).toBe(20);
        expect(small.feeAmount).toBeCloseTo(20 * small.userRate, 2);
        const large = await ycRateService.price("send", "KES", 5_000);
        expect(large.feeInCurrency).toBe(50);
    });

    it("refuses our USD mode without both rates", async () => {
        await expect(platformSettingsService.updateSettings({ pricing: { usd: { mode: "ours", buyNgn: 1600 } } }, ADMIN)).rejects.toThrow("Enter both of our USD rates");
    });

    it("charges a send at the pair's price and books the provider rate for profit", async () => {
        const service = new TransactionService();
        const user = await createUser();
        await fundWallet(user.id, 50_000);
        const yc: any = (await import("../src/services/yellowcard.service")).default;
        yc.submitPaymentRequest.mockResolvedValue({ id: "pay-1", status: "processing" });
        const tx: any = await service.createYellowCardTransaction({
            amount: 100, fromCurrency: "NGN", toCurrency: "KES", pin: TEST_PIN, reason: "gift",
            destination: { accountName: "Wanjiru", accountNumber: "+254712345678", accountType: "momo", country: "KE", network: "Mpesa" },
        } as any, user.id);
        const [d] = await exec().select().from(transactionDetails).where((await import("drizzle-orm")).eq(transactionDetails.transactionId, tx.id ?? tx._id));
        expect(Number(d.providerRate)).toBe(10);
        expect(Number(d.fromAmount)).toBe(1000);

        // Completed: profit is what the user paid less what YellowCard charged (KES 100 × ₦10)
        await exec().update(transactions).set({ status: "completed" as any }).where((await import("drizzle-orm")).eq(transactions.id, d.transactionId));
        const [row] = await adminProfitService.rows({ userId: user.id, kinds: ["send"] });
        expect(row).toMatchObject({ profitNgn: 0, volumeNgn: 1000, profitPercent: 0, userRate: 10, providerRate: 10 });
    });

    it("counts YellowCard's own fee: on top of a send, and out of a collection before it's converted", async () => {
        const { ycFeeUnits } = await import("../src/services/admin-profit.service");
        expect(ycFeeUnits({ serviceFeeAmountLocal: 2, networkFeeAmountLocal: "0.5" })).toBe(2.5);
        expect(ycFeeUnits({ rate: 10 })).toBeNull();
        expect(ycFeeUnits(null)).toBeNull();

        const service = new TransactionService();
        const user = await createUser();
        await fundWallet(user.id, 50_000);
        const yc: any = (await import("../src/services/yellowcard.service")).default;
        yc.submitPaymentRequest.mockResolvedValue({ id: "pay-fee", status: "processing" });
        const tx: any = await service.createYellowCardTransaction({
            amount: 100, fromCurrency: "NGN", toCurrency: "KES", pin: TEST_PIN, reason: "gift",
            destination: { accountName: "Wanjiru", accountNumber: "+254712345678", accountType: "momo", country: "KE", network: "Mpesa" },
        } as any, user.id);
        const id = tx.id ?? tx._id;
        // YellowCard reports KES 3 of fees: we paid for 103 KES at ₦10, the user paid ₦1000
        await exec().update(transactionDetails).set({ ycRawPayload: { serviceFeeAmountLocal: 3, networkFeeAmountLocal: 0 } }).where(eq(transactionDetails.transactionId, id));
        await exec().update(transactions).set({ status: "completed" as any }).where(eq(transactions.id, id));
        const [row] = await adminProfitService.rows({ userId: user.id, kinds: ["send"] });
        expect(row).toMatchObject({ profitNgn: -30, providerRate: 10 });
    });

    it("converts only the cedis Fincra settled (its fee taken first), so the rate is per cedi converted", async () => {
        const { settledGhsFromCheckout } = await import("../src/services/ghs-conversion.service");
        // Fincra says what it kept or settled: that wins
        expect(settledGhsFromCheckout({ amount: 10, amountReceived: 9.77 }, 10, 2.3)).toBe(9.77);
        expect(settledGhsFromCheckout({ amount: 10, fee: 0.23 }, 10, 2.3)).toBeCloseTo(9.77, 2);
        // Silent payload: the amount less Fincra's fee, not the full 10
        expect(settledGhsFromCheckout({ amount: 10 }, 10, 2.3)).toBe(9.77);
        expect(settledGhsFromCheckout({ amount: 10 }, 10)).toBe(10);
    });

    it("holds a YellowCard send over the approval limit and only asks YellowCard once approved", async () => {
        const { default: approvalService } = await import("../src/services/approval.service");
        await platformSettingsService.updateSettings({ operations: { approvals: { thresholdNgn: 500 } } }, ADMIN);
        const service = new TransactionService();
        const user = await createUser();
        await fundWallet(user.id, 50_000);
        const yc: any = (await import("../src/services/yellowcard.service")).default;
        yc.submitPaymentRequest.mockClear();
        yc.submitPaymentRequest.mockResolvedValue({ id: "pay-h", channelId: "ch-1", status: "processing" });
        const held: any = await service.createYellowCardTransaction({
            amount: 100, fromCurrency: "NGN", toCurrency: "KES", pin: TEST_PIN, reason: "gift",
            destination: { accountName: "Wanjiru", accountNumber: "+254712345678", accountType: "momo", country: "KE", network: "Mpesa" },
        } as any, user.id);
        expect(held.status).toBe("awaiting_approval");
        expect(yc.submitPaymentRequest).not.toHaveBeenCalled();
        const [hold] = await approvalService.list("pending");
        expect(await approvalService.approve(hold.id, ADMIN)).toMatchObject({ outcome: "approved" });
        expect(yc.submitPaymentRequest).toHaveBeenCalledWith(expect.objectContaining({ sequenceId: held.reference, localAmount: 100, currency: "KES" }));
        const [tx] = await exec().select().from(transactions).where((await import("drizzle-orm")).eq(transactions.id, held.id));
        expect(tx.status).toBe("processing");
    });

    it("turns currencies off for everyone or one user, and hides them from the user", async () => {
        const user = await createUser();
        await currencyAccessService.assertOn(user.id, "KES");
        await userRepository.update(user.id, { disabledCurrencies: ["KES"] });
        await expect(currencyAccessService.assertOn(user.id, "NGN", "KES")).rejects.toMatchObject({ response_code: 403 });
        const other = await createUser();
        await currencyAccessService.assertOn(other.id, "KES");
        await platformSettingsService.updateSettings({ operations: { currencies: { off: ["ghs"] } } }, ADMIN);
        await expect(currencyAccessService.assertOn(other.id, "GHS")).rejects.toMatchObject({ details: { code: "CURRENCY_OFF", currency: "GHS" } });
        expect([...(await currencyAccessService.offFor(user.id))].sort()).toEqual(["GHS", "KES"]);
        // Naira can't be turned off
        await expect(platformSettingsService.updateSettings({ operations: { currencies: { off: ["NGN"] } } }, ADMIN)).rejects.toThrow("Naira can't be turned off");
    });

    it("averages profit per day, week and month", () => {
        const at = (iso: string) => new Date(iso);
        const row = (iso: string, profit: number, volume: number) => ({ id: iso, kind: "send" as const, userId: "u", userName: "", userEmail: "", reference: iso, at: at(iso), amount: 0, currency: "GHS", feeNgn: 0, spreadNgn: 0, profitNgn: profit, volumeNgn: volume });
        const totals = adminProfitService.totals([
            row("2026-11-02T10:00:00Z", 100, 1000), // Monday, week 1
            row("2026-11-03T10:00:00Z", 300, 2000), // Tuesday, week 1
            row("2026-11-10T10:00:00Z", 200, 4000), // Monday, week 2
        ]);
        expect(totals).toMatchObject({ profitNgn: 600, volumeNgn: 7000 });
        expect(totals.profitPercent).toBeCloseTo(8.57, 2);
        expect(totals.averages.daily).toMatchObject({ periods: 3, profitNgn: 200 });
        // Days: 10%, 15%, 5% → 10%
        expect(totals.averages.daily.profitPercent).toBe(10);
        expect(totals.averages.weekly).toMatchObject({ periods: 2, profitNgn: 300 });
        expect(totals.averages.monthly).toMatchObject({ periods: 1, profitNgn: 600 });
    });

    it("shows on the public rates feed (the landing page calculator) the exact rate a wallet exchange quote charges", async () => {
        const { default: exchangeRateService } = await import("../src/services/exchange-rate.service").then((m) => ({ default: new (m.default as any)() }));
        const { default: fxExchangeService } = await import("../src/services/fx-exchange.service");
        const { wallets } = await import("../src/db/schema");
        const user = await createUser();
        await fundWallet(user.id, 100_000);
        const [ngnWallet] = await exec().select().from(wallets).where(eq(wallets.user, user.id));
        await exec().insert(wallets).values({ ...ngnWallet, id: undefined, currency: "KES", balance: 500, createdAt: undefined, updatedAt: undefined } as any);

        const feed = await exchangeRateService.listForUsers();
        const buy = feed.find((r: any) => r.from === "NGN" && r.to === "KES");
        const sell = feed.find((r: any) => r.from === "KES" && r.to === "NGN");
        expect(buy?.source).toBe("live");

        const buying = await fxExchangeService.quote(user.id, { fromCurrency: "NGN", toCurrency: "KES", amount: 10_000, side: "from" } as any);
        const selling = await fxExchangeService.quote(user.id, { fromCurrency: "KES", toCurrency: "NGN", amount: 100, side: "from" } as any);
        // Feed rows are `to` per 1 `from`; quotes are naira per KES
        expect(1 / buy!.rate).toBeCloseTo(buying.rate, 4);
        expect(sell!.rate).toBeCloseTo(selling.rate, 4);
    });

    it("needs a reason on a send from YellowCard's list, keeps the user's note, and tells YellowCard the reason", async () => {
        const service = new TransactionService();
        const user = await createUser();
        await fundWallet(user.id, 50_000);
        const yc: any = (await import("../src/services/yellowcard.service")).default;
        yc.submitPaymentRequest.mockClear();
        yc.submitPaymentRequest.mockResolvedValue({ id: "pay-r", status: "processing" });
        const send = (extra: Record<string, unknown>) => service.createYellowCardTransaction({
            amount: 100, fromCurrency: "NGN", toCurrency: "KES", pin: TEST_PIN, ...extra,
            destination: { accountName: "Wanjiru", accountNumber: "+254712345678", accountType: "momo", country: "KE", network: "Mpesa" },
        } as any, user.id);

        await expect(send({})).rejects.toMatchObject({ response_code: 400, message: "Choose a reason for this payment" });
        await expect(send({ reason: "rent" })).rejects.toMatchObject({ response_code: 400 });
        expect(yc.submitPaymentRequest).not.toHaveBeenCalled();

        const tx: any = await send({ reason: "school-fees", narration: "  Term 2 <b>fees</b>  " });
        expect(yc.submitPaymentRequest).toHaveBeenCalledWith(expect.objectContaining({ reason: "school-fees" }));
        const [row] = await exec().select().from(transactions).where((await import("drizzle-orm")).eq(transactions.id, tx.id ?? tx._id));
        expect(row).toMatchObject({ reason: "school-fees", narration: "Term 2 fees" });
    });

    it("counts an exchange's spread in profit, and a send paid from the KES wallet only for its wallet fee", async () => {
        const { default: fxExchangeService } = await import("../src/services/fx-exchange.service");
        const { wallets } = await import("../src/db/schema");
        const { eq } = await import("drizzle-orm");
        // Our rates over YellowCard's: +5% when we sell KES, so there's a spread to count
        await platformSettingsService.updateSettings({ pricing: { send: { "NGN-KES": { rate: { percent: 5, fixed: 0 }, providerFee: { percent: 0, fixed: 0, min: 0, cap: 0 }, platformFee: { percent: 0, fixed: 0, min: 0, cap: 0 } } } } }, ADMIN);
        ycRateService.clearCache();
        const user = await createUser();
        await fundWallet(user.id, 100_000);
        const [ngnWallet] = await exec().select().from(wallets).where(eq(wallets.user, user.id));
        await exec().insert(wallets).values({ ...ngnWallet, id: undefined, currency: "KES", balance: 0, createdAt: undefined, updatedAt: undefined } as any);

        const quote: any = await fxExchangeService.quote(user.id, { fromCurrency: "NGN", toCurrency: "KES", amount: 500, side: "to" } as any);
        await fxExchangeService.execute(user.id, quote.id, TEST_PIN);
        const [row] = await adminProfitService.rows({ userId: user.id, kinds: ["exchange"] });
        // KES 500 at ₦10.50 (₦10 + 5%) costs ₦5,250; it cost us ₦5,000 at YellowCard
        expect(row).toMatchObject({ kind: "exchange", amount: 500, currency: "KES", providerRate: 10, volumeNgn: 5250, profitNgn: 250, spreadNgn: 250 });
        expect(row.userRate).toBeCloseTo(10.5, 4);

        // Paying KES 100 from that KES wallet: no conversion, so no spread on the send
        const yc: any = (await import("../src/services/yellowcard.service")).default;
        yc.submitPaymentRequest.mockResolvedValue({ id: "pay-w", status: "processing" });
        const tx: any = await new TransactionService().createYellowCardTransaction({
            amount: 100, fromCurrency: "NGN", toCurrency: "KES", pin: TEST_PIN, reason: "gift", walletCurrency: "KES",
            destination: { accountName: "Wanjiru", accountNumber: "+254712345678", accountType: "momo", country: "KE", network: "Mpesa" },
        } as any, user.id);
        await exec().update(transactions).set({ status: "completed" as any }).where(eq(transactions.id, tx.id ?? tx._id));
        const [send] = await adminProfitService.rows({ userId: user.id, kinds: ["send"] });
        expect(send).toMatchObject({ spreadNgn: 0, userRate: null, providerRate: 10, note: "Paid from KES wallet: no conversion" });
    });
});
