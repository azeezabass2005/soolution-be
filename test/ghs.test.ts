import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Fincra is mocked (its pure helpers are real); 1 GHS = ₦100, no markup, 1.5% fee
vi.mock("../src/services/fincra.service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/services/fincra.service")>();
    return {
        ...actual,
        default: {
            ngnPerGhs: vi.fn(async () => 100),
            // Fincra's cost for the exact amount: ₦99/GHS plus a ₦0.50/GHS fee
            quote: vi.fn(async (q: any) => ({ reference: "q-1", sourceAmount: q.amount * 99, destinationAmount: q.amount, amountToCharge: q.amount * 99.5 })),
            ghsMobileMoneyCode: vi.fn(async (network: string) => (network === "MTN" ? "MTN" : "AIRTEL")),
            listBanks: vi.fn(async () => [{ code: "GH-ACCESS", name: "Access Bank Ghana", swiftCode: "ABNGGHAC" }]),
            createPayout: vi.fn(),
            getPayout: vi.fn(async () => null),
            createCheckout: vi.fn(),
            getCheckout: vi.fn(),
            convert: vi.fn(),
            getConversion: vi.fn(),
        },
    };
});
vi.mock("../src/services/transaction-limit.service", () => ({
    default: {
        assertAllowed: vi.fn(async () => ({ ngnValue: 10_000 })),
        assertCanTransact: vi.fn(async () => undefined),
        check: vi.fn(async () => ({ allowed: true, ngnValue: 10_000 })),
        withUserLock: vi.fn(async (_userId: string, fn: () => Promise<unknown>) => fn()),
    },
}));
vi.mock("../src/utils/notification.utils", () => ({
    default: class {
        sendTransactionNotification = vi.fn();
        notifyAdmins = vi.fn();
        sendNotification = vi.fn();
        emailService = { sendNotificationEmail: vi.fn() };
    },
}));

import crypto from "crypto";
import fincraService, { toNgnPerGhs } from "../src/services/fincra.service";
import fincraWebhookService from "../src/services/fincra-webhook.service";
import TransactionService from "../src/services/transaction.service";
import paymentLinkService from "../src/services/payment-link.service";
import transactionRepository from "../src/repositories/transaction.repository";
import { resetTestDatabase, startTestDatabase, stopTestDatabase } from "./helpers/db";
import { TEST_PIN, accountBalance, bootstrapLedger, createUser, fundWallet, walletBalance } from "./helpers/fixtures";
import reconciliationService from "../src/services/reconciliation.service";
import { SYSTEM_ACCOUNT_CODES, fincraCashCode, fincraPayoutInflightCode } from "../src/common/constant";

const fincra = fincraService as unknown as Record<string, ReturnType<typeof vi.fn>>;
const transactionService = new TransactionService();

const send = (userId: string, overrides: Record<string, unknown> = {}) =>
    transactionService.createGhsPayoutTransaction({
        amount: 100,
        fromCurrency: "NGN",
        toCurrency: "GHS",
        destination: { accountType: "momo", accountName: "Kofi Mensah", accountNumber: "0241234567", network: "MTN" },
        pin: TEST_PIN,
        ...overrides,
    } as any, userId);

describe("GHS through Fincra", () => {
    beforeAll(startTestDatabase);
    afterAll(stopTestDatabase);
    beforeEach(async () => {
        vi.clearAllMocks();
        fincra.getPayout.mockResolvedValue(null);
        fincra.quote.mockImplementation(async (q: any) => ({ reference: "q-1", sourceAmount: q.amount * 99, destinationAmount: q.amount, amountToCharge: q.amount * 99.5 }));
        await resetTestDatabase();
        await bootstrapLedger();
    });

    describe("sending to mobile money", () => {
        it("charges NGN at the rate plus the fee, and pays out from the NGN balance at Fincra's quote", async () => {
            const user = await createUser();
            await fundWallet(user.id, 50_000);
            fincra.createPayout.mockResolvedValue({ reference: "FP_GH_1", status: "processing" });

            const transaction: any = await send(user.id);
            expect(transaction.status).toBe("processing");
            // 100 GHS × ₦100 = ₦10,000, plus 1.5% = ₦150
            expect(await walletBalance(user.id)).toBe(39_850);
            expect(fincra.createPayout).toHaveBeenCalledWith(expect.objectContaining({
                customerReference: transaction.reference,
                sourceCurrency: "NGN",
                destinationCurrency: "GHS",
                amount: 9_900, // the quote's NGN source amount
                quoteReference: "q-1",
                paymentDestination: "mobile_money_wallet",
                beneficiary: expect.objectContaining({ accountNumber: "233241234567", mobileMoneyCode: "MTN", firstName: "Kofi", lastName: "Mensah", country: "GH" }),
            }));
            expect(await accountBalance(fincraPayoutInflightCode("GHS"))).toBe(-10_000);
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.FEES_NGN)).toBe(150);

            const success = { event: "payout.successful", data: { customerReference: transaction.reference, reference: "FP_GH_1", status: "successful" } };
            await Promise.all([fincraWebhookService.handle(success), fincraWebhookService.handle(success)]);
            expect((await transactionRepository.findById(transaction.id))?.status).toBe("completed");
            expect(await accountBalance(fincraPayoutInflightCode("GHS"))).toBe(0);
            expect(await accountBalance(fincraCashCode("GHS"))).toBe(0);
            // Fincra took ₦9,950 from the NGN balance; ₦50 of the ₦10,000 is spread
            expect(await accountBalance(fincraCashCode("NGN"))).toBe(50_000 - 9_950);
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.FEES_NGN)).toBe(200);
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("refunds the whole charge once when the payout fails", async () => {
            const user = await createUser();
            await fundWallet(user.id, 50_000);
            fincra.createPayout.mockResolvedValue({ reference: "FP_GH_2", status: "processing" });
            const transaction: any = await send(user.id);

            const failed = { event: "payout.failed", data: { customerReference: transaction.reference, status: "failed", reason: "Wallet not found" } };
            await Promise.all([fincraWebhookService.handle(failed), fincraWebhookService.handle(failed)]);
            expect((await transactionRepository.findById(transaction.id))?.status).toBe("failed");
            expect(await walletBalance(user.id)).toBe(50_000);
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("never refunds a payout Fincra already reported as paid", async () => {
            const user = await createUser();
            await fundWallet(user.id, 50_000);
            fincra.createPayout.mockResolvedValue({ reference: "FP_GH_4", status: "processing" });
            const transaction: any = await send(user.id);

            const event = (status: string) => ({ event: `payout.${status}`, data: { customerReference: transaction.reference, status } });
            await fincraWebhookService.handle(event("successful"));
            await Promise.all([fincraWebhookService.handle(event("failed")), fincraWebhookService.handle(event("successful"))]);
            expect((await transactionRepository.findById(transaction.id))?.status).toBe("completed");
            expect(await walletBalance(user.id)).toBe(39_850);
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("prices with the admin's rate buffer and fees for the pair", async () => {
            const { default: platformSettingsService } = await import("../src/services/platform-settings.service");
            await platformSettingsService.updateSettings({ pricing: { send: { "NGN-GHS": {
                rate: { percent: 2, fixed: 1 },                              // ₦100 → ₦103 per GHS
                providerFee: { percent: 0, fixed: 0, min: 0, cap: 0 },
                platformFee: { percent: 1, fixed: 0.5, min: 0, cap: 2 },     // 1% + GHS 0.50, at most GHS 2
            } } } }, "00000000-0000-4000-8000-000000000001");
            const user = await createUser();
            await fundWallet(user.id, 50_000);
            fincra.createPayout.mockResolvedValue({ reference: "FP_GH_P", status: "processing" });

            await send(user.id);
            // 100 GHS × ₦103 = ₦10,300; fee 1% of GHS 100 + GHS 0.50 = GHS 1.50, at the user's rate ₦154.50
            expect(await walletBalance(user.id)).toBe(50_000 - 10_454.5);
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.FEES_NGN)).toBe(154.5);
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("keeps an older config's fee amounts in NGN", async () => {
            const { default: platformSettingsService } = await import("../src/services/platform-settings.service");
            await platformSettingsService.updateSettings({ pricing: { send: { "NGN-GHS": {
                rate: { percent: 2, fixed: 1 },
                providerFee: { percent: 0, fixed: 0, min: 0, cap: 0 },
                platformFee: { percent: 1, fixed: 50, min: 0, cap: 200 },    // 1% + ₦50, at most ₦200
                feeCurrency: "NGN",
            } } } }, "00000000-0000-4000-8000-000000000001");
            const user = await createUser();
            await fundWallet(user.id, 50_000);
            fincra.createPayout.mockResolvedValue({ reference: "FP_GH_N", status: "processing" });
            await send(user.id);
            // 100 GHS × ₦103 = ₦10,300; fee min(103 + 50, 200) = ₦153
            expect(await walletBalance(user.id)).toBe(50_000 - 10_453);
        });

        it("refuses an amount outside the admin's per-transaction limits, before charging", async () => {
            const { default: platformSettingsService } = await import("../src/services/platform-settings.service");
            await platformSettingsService.updateSettings({ pricing: { send: { "NGN-GHS": { limits: { min: 0, max: 50 } } } } }, "00000000-0000-4000-8000-000000000001");
            const user = await createUser();
            await fundWallet(user.id, 50_000);
            await expect(send(user.id)).rejects.toMatchObject({ response_code: 400, message: "The most you can do in one transaction is GHS 50." });
            expect(fincra.createPayout).not.toHaveBeenCalled();
            expect(await walletBalance(user.id)).toBe(50_000);
        });

        it("refuses before charging when Fincra's cost is above what the user would pay", async () => {
            const user = await createUser();
            await fundWallet(user.id, 50_000);
            fincra.quote.mockResolvedValue({ reference: "q-2", sourceAmount: 10_200, destinationAmount: 100, amountToCharge: 10_250 });
            await expect(send(user.id)).rejects.toMatchObject({ response_code: 409 });
            expect(fincra.createPayout).not.toHaveBeenCalled();
            expect(await walletBalance(user.id)).toBe(50_000);
        });

        it("refunds at once when Fincra refuses the payout", async () => {
            const user = await createUser();
            await fundWallet(user.id, 50_000);
            const { FincraError } = await import("../src/services/fincra.service");
            fincra.createPayout.mockRejectedValue(new FincraError("Insufficient balance", 422));

            await expect(send(user.id)).rejects.toMatchObject({ response_code: 400 });
            expect(await walletBalance(user.id)).toBe(50_000);
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("pays a Ghana bank by Fincra's code and SWIFT code", async () => {
            const user = await createUser();
            await fundWallet(user.id, 50_000);
            fincra.createPayout.mockResolvedValue({ reference: "FP_GH_3", status: "processing" });
            await send(user.id, { destination: { accountType: "bank", accountName: "Ama Owusu", accountNumber: "1234567890123", bank: "ABNGGHAC" } });
            expect(fincra.createPayout).toHaveBeenCalledWith(expect.objectContaining({
                paymentDestination: "bank_account",
                beneficiary: expect.objectContaining({ accountNumber: "1234567890123", bankCode: "GH-ACCESS", bankSwiftCode: "ABNGGHAC" }),
            }));
        });

        it("finds a bank picked from the built-in Ghana list by name", async () => {
            const user = await createUser();
            await fundWallet(user.id, 50_000);
            fincra.createPayout.mockResolvedValue({ reference: "FP_GH_4", status: "processing" });
            await send(user.id, { destination: { accountType: "bank", accountName: "Ama Owusu", accountNumber: "1234567890123", bank: "Access Bank Ghana Limited" } });
            expect(fincra.createPayout).toHaveBeenCalledWith(expect.objectContaining({
                beneficiary: expect.objectContaining({ bankCode: "GH-ACCESS" }),
            }));
        });

        it("offers the built-in Ghana bank list when the provider's is empty or down", async () => {
            const { default: bankDirectory } = await import("../src/services/bank-directory.service");
            fincra.listBanks.mockResolvedValueOnce([]);
            const empty = await bankDirectory.list("GHS");
            expect(empty.banks.length).toBeGreaterThan(20);
            expect(empty.banks.map((b) => b.name)).toContain("GCB Bank");
            (bankDirectory as any).cache.clear();
            fincra.listBanks.mockRejectedValueOnce(new Error("down"));
            expect((await bankDirectory.list("GHS")).banks.length).toBeGreaterThan(20);
            (bankDirectory as any).cache.clear();
        });

        it("checks the number and network before charging anything", async () => {
            const user = await createUser();
            await fundWallet(user.id, 50_000);
            await expect(send(user.id, { destination: { accountType: "momo", accountName: "Kofi", accountNumber: "12", network: "MTN" } })).rejects.toMatchObject({ response_code: 400 });
            expect(fincra.createPayout).not.toHaveBeenCalled();
            expect(await walletBalance(user.id)).toBe(50_000);
        });
    });

    describe("manual GHS sends (from ₦500,000, no fee, paid by ops)", () => {
        const manual = (userId: string, amount: number) => transactionService.createManualGhsSend({
            amount,
            destination: { accountType: "bank", accountName: "Kofi Mensah", accountNumber: "1234567890", bank: "GCB Bank" },
            pin: TEST_PIN,
        }, userId);
        const ADMIN = "00000000-0000-4000-8000-000000000001";
        const setManual = async (manual: Record<string, unknown>) => {
            const { default: platformSettingsService } = await import("../src/services/platform-settings.service");
            await platformSettingsService.updateSettings({ operations: { manual } }, ADMIN);
        };
        // Open around the clock at ₦100 per cedi unless a test says otherwise
        beforeEach(() => setManual({ rates: { GHS: 100 }, days: [0, 1, 2, 3, 4, 5, 6], open: "00:00", close: "23:59", closedDates: [] }));

        it("holds the naira at the admin's manual rate with no fee, and returns it if ops rejects", async () => {
            const { default: walletSendService } = await import("../src/services/wallet-send.service");
            const user = await createUser();
            await fundWallet(user.id, 600_000);
            // 5,000 GHS at ₦100 = ₦500,000, the minimum
            const transaction: any = await manual(user.id, 5_000);
            expect(transaction).toMatchObject({ status: "awaiting_confirmation", amount: 5_000, currency: "GHS", detailType: "bank_transfer" });
            expect(transaction.details).toMatchObject({ fundingCurrency: "NGN", fundingAmount: 500_000, fundingFee: 0, feeAmount: 0 });
            expect(await walletBalance(user.id)).toBe(100_000);
            expect(await accountBalance("MANUAL_PAYOUT_PENDING_NGN")).toBe(500_000);
            expect(fincra.createPayout).not.toHaveBeenCalled();

            await transactionService.rejectManualTransaction(transaction.id, "Recipient bank details were wrong");
            expect(await walletBalance(user.id)).toBe(600_000);
            expect(await accountBalance("MANUAL_PAYOUT_PENDING_NGN")).toBe(0);

            // A second one completed by ops: the naira moves to the NGN position
            const paid: any = await manual(user.id, 5_500);
            await walletSendService.completeManualPayout(paid.id);
            expect(await walletBalance(user.id)).toBe(50_000);
            expect(await accountBalance("MANUAL_PAYOUT_PENDING_NGN")).toBe(0);
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("refuses amounts under ₦500,000, before charging", async () => {
            const user = await createUser();
            await fundWallet(user.id, 600_000);
            await expect(manual(user.id, 4_999)).rejects.toMatchObject({ response_code: 400, message: "Manual payments start at ₦500,000. For smaller amounts, use instant." });
            expect(await walletBalance(user.id)).toBe(600_000);
        });

        it("prices from the admin's manual rate, not Fincra's", async () => {
            await setManual({ rates: { GHS: 110 } });                 // Fincra says ₦100
            const user = await createUser();
            await fundWallet(user.id, 600_000);
            const transaction: any = await manual(user.id, 5_000);
            expect(transaction.details).toMatchObject({ fundingAmount: 550_000, feeAmount: 0 });
            expect(Number(transaction.lockedRate)).toBe(110);
            expect(await walletBalance(user.id)).toBe(50_000);
        });

        it("refuses outside the manual hours, and when no manual rate is set", async () => {
            const user = await createUser();
            await fundWallet(user.id, 600_000);
            await setManual({ days: [] });
            await expect(manual(user.id, 5_000)).rejects.toMatchObject({ response_code: 400, details: { code: "MANUAL_CLOSED" } });
            await setManual({ days: [0, 1, 2, 3, 4, 5, 6], rates: {} });
            await expect(manual(user.id, 5_000)).rejects.toMatchObject({ response_code: 400, details: { code: "MANUAL_UNAVAILABLE" } });
            expect(await walletBalance(user.id)).toBe(600_000);
        });

        it("refuses when the wallet can't cover it", async () => {
            const user = await createUser();
            await fundWallet(user.id, 400_000);
            await expect(manual(user.id, 5_000)).rejects.toBeTruthy();
            expect(await walletBalance(user.id)).toBe(400_000);
        });
    });

    describe("receiving through a payment link", () => {
        const pay = async () => {
            const owner = await createUser();
            const link = await paymentLinkService.create(owner.id, { currency: "GHS", amount: 100, usage: "reusable" });
            fincra.createCheckout.mockResolvedValue({ link: "https://checkout.fincra.com/pay/abc", reference: "fcr-p-1" });
            const payment: any = await paymentLinkService.pay(link.slug, {
                method: "momo", momoNetwork: "MTN Momo", momoNumber: "0241234567", momoName: "Kwame Asante", email: "kwame@example.test",
            });
            return { owner, link, payment };
        };

        it("tops up the user's own wallet: a checkout in their name, priced like a receive, marked as a top-up", async () => {
            const user = await createUser();
            fincra.createCheckout.mockResolvedValue({ link: "https://checkout.fincra.com/pay/top", reference: "fcr-top" });
            const transaction: any = await transactionService.createGhsCollectionTransaction({
                amount: 100, fromCurrency: "GHS", toCurrency: "NGN", topUp: true,
                payer: { name: "Ada Obi", email: user.email },
            }, user.id);
            expect(transaction).toMatchObject({ purpose: "top_up", checkoutUrl: "https://checkout.fincra.com/pay/top", amount: 100 });
            expect(fincra.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ amount: 100, customer: { name: "Ada Obi", email: user.email } }));

            fincra.getCheckout.mockResolvedValue({ status: "success", amount: 100, currency: "GHS" });
            await fincraWebhookService.handle({ event: "charge.successful", data: { status: "success", metadata: { reference: transaction.reference } } });
            // Same as a payment link: 100 GHS × ₦100 less 1.5%
            expect(await walletBalance(user.id)).toBe(9_850);
        });

        it("holds a payer-entered amount to the per-payment range, and tells the pay page the range", async () => {
            const { default: platformSettingsService } = await import("../src/services/platform-settings.service");
            const pricing = await platformSettingsService.getPricing();
            await platformSettingsService.updateSettings({ pricing: { receive: { "GHS-NGN": { ...pricing.receive["GHS-NGN"], limits: { min: 50, max: 1_000 } } } } }, "00000000-0000-4000-8000-000000000001");
            const owner = await createUser();
            const link = await paymentLinkService.create(owner.id, { currency: "GHS", usage: "reusable" });
            expect((await paymentLinkService.getPublic(link.slug)).limits).toEqual({ min: 50, max: 1_000 });
            const payer = { method: "momo", momoNetwork: "MTN Momo", momoNumber: "0241234567", momoName: "Kwame Asante", email: "kwame@example.test" };
            await expect(paymentLinkService.pay(link.slug, { ...payer, amount: 2_000 } as any)).rejects.toMatchObject({ message: "The most this link accepts in one payment is GHS 1,000." });
            await expect(paymentLinkService.pay(link.slug, { ...payer, amount: 10 } as any)).rejects.toMatchObject({ message: "The smallest amount per transaction is GHS 50." });
            expect(fincra.createCheckout).not.toHaveBeenCalled();
        });

        it("hands the payer Fincra's checkout and credits the owner once it's paid", async () => {
            const { owner, link, payment } = await pay();
            expect(payment).toMatchObject({ status: "processing", checkoutUrl: "https://checkout.fincra.com/pay/abc", amount: 100, currency: "GHS" });
            expect(fincra.createCheckout).toHaveBeenCalledWith(expect.objectContaining({
                currency: "GHS",
                amount: 100,
                reference: payment.reference,
                customer: { name: "Kwame Asante", email: "kwame@example.test" },
                redirectUrl: expect.stringContaining(`/pay/${link.slug}`),
            }));

            fincra.getCheckout.mockResolvedValue({ status: "success", amount: 100, currency: "GHS" });
            const charge = { event: "charge.successful", data: { status: "success", metadata: { reference: payment.reference } } };
            await Promise.all([fincraWebhookService.handle(charge), fincraWebhookService.handle(charge)]);

            // 100 GHS × ₦100 = ₦10,000 less 1.5% = ₦9,850
            expect(await walletBalance(owner.id)).toBe(9_850);
            expect(await accountBalance(fincraCashCode("GHS"))).toBe(10_000);
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.FEES_NGN)).toBe(150);
            const status = await paymentLinkService.paymentStatus(link.slug, payment.reference);
            expect(status.status).toBe("completed");
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        describe("converting the received GHS to NGN at Fincra", () => {
            const config = () => import("../src/config/env.config").then((m) => m.default as any);
            beforeEach(async () => { (await config()).FINCRA_AUTO_CONVERT_GHS = true; });
            afterAll(async () => { (await config()).FINCRA_AUTO_CONVERT_GHS = false; });

            it("converts what Fincra settled once the payment is confirmed, and books the difference", async () => {
                const { default: ghsConversionService } = await import("../src/services/ghs-conversion.service");
                const { default: fxConversionRepository } = await import("../src/repositories/fx-conversion.repository");
                const { owner, payment } = await pay();
                fincra.convert.mockResolvedValue({ reference: "cnv-1", quote: { reference: "q-cnv" } });
                fincra.getConversion.mockResolvedValue({ status: "processing" });
                // Fincra kept GHS 1 of the 100 as its fee
                fincra.getCheckout.mockResolvedValue({ status: "success", amount: 100, amountReceived: 99, currency: "GHS" });
                await fincraWebhookService.handle({ event: "charge.successful", data: { metadata: { reference: payment.reference } } });
                expect(await walletBalance(owner.id)).toBe(9_850);

                const transaction = await transactionRepository.findByReference(payment.reference);
                await ghsConversionService.processDue(new Date(Date.now() + 60_000));
                expect(fincra.convert).toHaveBeenCalledWith(expect.objectContaining({ sourceCurrency: "GHS", destinationCurrency: "NGN", amount: 99 }));
                expect(await fxConversionRepository.findByTransaction(transaction!.id)).toMatchObject({ status: "processing", providerReference: "cnv-1", bookedNgn: 10_000 });

                // Fincra finishes: GHS 99 became ₦9,700. The ₦10,000 booked comes off the GHS cash; ₦300 is an FX loss.
                fincra.getConversion.mockResolvedValue({ status: "successful", amountCharged: 99, amountReceived: 9_700 });
                const webhook = { event: "conversion.successful", data: { reference: "cnv-1" } };
                await Promise.all([fincraWebhookService.handle(webhook), fincraWebhookService.handle(webhook)]);
                expect(await accountBalance(fincraCashCode("GHS"))).toBe(0);
                expect(await accountBalance(fincraCashCode("NGN"))).toBe(9_700);
                expect(await accountBalance(SYSTEM_ACCOUNT_CODES.FX_CONVERSION_NGN)).toBe(-300);
                expect(await fxConversionRepository.findByTransaction(transaction!.id)).toMatchObject({ status: "successful", amountReceived: 9_700 });
                expect(fincra.convert).toHaveBeenCalledTimes(1);
                expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
            });

            it("retries later when Fincra can't convert yet (e.g. the GHS isn't settled)", async () => {
                const { default: ghsConversionService } = await import("../src/services/ghs-conversion.service");
                const { default: fxConversionRepository } = await import("../src/repositories/fx-conversion.repository");
                const { FincraError } = await import("../src/services/fincra.service");
                const { payment } = await pay();
                fincra.convert.mockRejectedValue(new FincraError("Insufficient balance", 422));
                fincra.getCheckout.mockResolvedValue({ status: "success", amount: 100, currency: "GHS" });
                await fincraWebhookService.handle({ event: "charge.successful", data: { metadata: { reference: payment.reference } } });
                const transaction = await transactionRepository.findByReference(payment.reference);
                const now = Date.now() + 60_000;
                await ghsConversionService.processDue(new Date(now));
                const waiting = await fxConversionRepository.findByTransaction(transaction!.id);
                expect(waiting).toMatchObject({ status: "pending", lastError: "Insufficient balance" });
                expect(new Date(waiting!.nextAttemptAt).getTime()).toBeGreaterThan(now);

                // Next time it works, with a new reference
                fincra.convert.mockResolvedValue({ reference: "cnv-2", quote: { reference: "q-2" } });
                fincra.getConversion.mockResolvedValue({ status: "successful", amountCharged: 100, amountReceived: 10_050 });
                await ghsConversionService.processDue(new Date(now + 3 * 60 * 60_000));
                const done = await fxConversionRepository.findByTransaction(transaction!.id);
                expect(done).toMatchObject({ status: "successful", amountReceived: 10_050 });
                const references = fincra.convert.mock.calls.map((c: any[]) => c[0].customerReference);
                expect(new Set(references).size).toBe(references.length);
                expect(await accountBalance(SYSTEM_ACCOUNT_CODES.FX_CONVERSION_NGN)).toBe(50);
                expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
            });
        });

        it("credits once however many charge webhooks and status checks race", async () => {
            const { owner, payment } = await pay();
            fincra.getCheckout.mockResolvedValue({ status: "success", amount: 100, currency: "GHS" });
            const charge = { event: "charge.successful", data: { metadata: { reference: payment.reference } } };
            await Promise.all([
                ...[1, 2, 3, 4].map(() => fincraWebhookService.handle(charge)),
                transactionRepository.findByReference(payment.reference).then((t) => transactionService.pollGhsStatus(t!.id)),
            ]);
            await fincraWebhookService.handle(charge);
            expect(await walletBalance(owner.id)).toBe(9_850);
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("credits nothing unless Fincra confirms the full amount", async () => {
            const { owner, payment } = await pay();
            fincra.getCheckout.mockResolvedValue({ status: "success", amount: 40, currency: "GHS" });
            await fincraWebhookService.handle({ event: "charge.successful", data: { metadata: { reference: payment.reference } } });
            expect(await walletBalance(owner.id)).toBe(0);

            fincra.getCheckout.mockResolvedValue({ status: "pending", amount: 100, currency: "GHS" });
            await fincraWebhookService.handle({ event: "charge.successful", data: { metadata: { reference: payment.reference } } });
            expect(await walletBalance(owner.id)).toBe(0);
        });

        it("asks for the details the owner wants, and sends the payer back to their site after paying", async () => {
            const owner = await createUser();
            const link = await paymentLinkService.create(owner.id, {
                currency: "GHS", amount: 100, usage: "reusable",
                redirectUrl: "https://shop.example.test/thanks?order=42", collect: ["name", "email", "phone", "email"],
            });
            expect(link).toMatchObject({ redirectUrl: "https://shop.example.test/thanks?order=42", collect: ["name", "email", "phone"] });
            expect(await paymentLinkService.getPublic(link.slug)).toMatchObject({ collect: ["name", "email", "phone"], redirects: true });

            const momo = { method: "momo", momoNetwork: "MTN Momo", momoNumber: "0241234567", momoName: "Kwame Asante" };
            await expect(paymentLinkService.pay(link.slug, { ...momo, email: "kwame@example.test" }))
                .rejects.toMatchObject({ response_code: 400, details: { issues: expect.arrayContaining([expect.objectContaining({ path: "payerName" }), expect.objectContaining({ path: "payerPhone" })]) } });

            fincra.createCheckout.mockResolvedValue({ link: "https://checkout.fincra.com/pay/abc", reference: "fcr-p-9" });
            const payment: any = await paymentLinkService.pay(link.slug, { ...momo, email: "kwame@example.test", payerName: "Kwame A. Asante", payerPhone: "+233 24 123 4567" });
            const stored = await transactionRepository.findByReference(payment.reference);
            expect(stored?.payer).toMatchObject({ name: "Kwame A. Asante", email: "kwame@example.test", phone: "+233 24 123 4567" });

            // Not until it's paid
            fincra.getCheckout.mockResolvedValue({ status: "pending", amount: 100, currency: "GHS" });
            expect((await paymentLinkService.paymentStatus(link.slug, payment.reference)) as any).not.toHaveProperty("redirectUrl");
            fincra.getCheckout.mockResolvedValue({ status: "success", amount: 100, currency: "GHS" });
            await fincraWebhookService.handle({ event: "charge.successful", data: { metadata: { reference: payment.reference } } });
            const done: any = await paymentLinkService.paymentStatus(link.slug, payment.reference);
            expect(done.status).toBe("completed");
            const back = new URL(done.redirectUrl);
            expect(back.origin + back.pathname).toBe("https://shop.example.test/thanks");
            expect(Object.fromEntries(back.searchParams)).toEqual({ order: "42", reference: payment.reference, status: "completed" });
        });

        it("only redirects to a real web address", async () => {
            const owner = await createUser();
            for (const redirectUrl of ["javascript:alert(1)", "shop.example.test", "http://shop.example.test", "ftp://x.test"]) {
                await expect(paymentLinkService.create(owner.id, { currency: "GHS", usage: "reusable", redirectUrl })).rejects.toMatchObject({ response_code: 400 });
            }
            await expect(paymentLinkService.create(owner.id, { currency: "GHS", usage: "reusable", collect: ["passport"] })).rejects.toMatchObject({ response_code: 400 });
        });

        it("takes whole cedis only", async () => {
            const owner = await createUser();
            await expect(paymentLinkService.create(owner.id, { currency: "GHS", amount: 10.5, usage: "reusable" })).rejects.toMatchObject({ response_code: 400 });
        });
    });

    describe("Fincra helpers", () => {
        it("reads NGN per GHS from a quote either way round", () => {
            expect(toNgnPerGhs({ sourceCurrency: "NGN", sourceAmount: 105_000, destinationAmount: 1000 })).toBe(105);
            expect(toNgnPerGhs({ sourceCurrency: "GHS", sourceAmount: 1000, destinationAmount: 105_000 })).toBe(105);
            expect(toNgnPerGhs({ rate: 0.01 })).toBe(100);
            expect(toNgnPerGhs({ rate: 98 })).toBe(98);
        });

        it("accepts only webhooks signed with the webhook key", async () => {
            const { default: real } = await vi.importActual<typeof import("../src/services/fincra.service")>("../src/services/fincra.service");
            const config = (await import("../src/config/env.config")).default;
            const previous = config.FINCRA_WEBHOOK_SECRET;
            config.FINCRA_WEBHOOK_SECRET = "whsec-test";
            try {
                const body = { event: "collection.successful", data: { reference: "r1" } };
                const raw = JSON.stringify(body);
                const good = crypto.createHmac("sha512", "whsec-test").update(raw).digest("hex");
                expect(real.verifyWebhookSignature(raw, body, good)).toBe(true);
                expect(real.verifyWebhookSignature(raw, body, good.replace(/^./, (c) => (c === "a" ? "b" : "a")))).toBe(false);
                expect(real.verifyWebhookSignature(raw, body, undefined)).toBe(false);
                config.FINCRA_WEBHOOK_SECRET = "";
                expect(real.verifyWebhookSignature(raw, body, good)).toBe(false);
            } finally {
                config.FINCRA_WEBHOOK_SECRET = previous;
            }
        });
    });

    describe("rates shown to users", () => {
        const ADMIN = "00000000-0000-4000-8000-000000000001";
        const listForUsers = async () => {
            const { default: ExchangeRateService } = await import("../src/services/exchange-rate.service");
            return new ExchangeRateService().listForUsers();
        };
        const addAdminRate = async (from: string, to: string, rate: number, isActive = true) => {
            const { default: ExchangeRateService } = await import("../src/services/exchange-rate.service");
            return new ExchangeRateService().create({ from: from as any, to: to as any, rate, isActive });
        };

        it("serves NGN↔GHS from Fincra with each direction's buffer, not the admin's manual rate", async () => {
            const { default: platformSettingsService } = await import("../src/services/platform-settings.service");
            await platformSettingsService.updateSettings({ pricing: {
                send: { "NGN-GHS": { rate: { percent: 2, fixed: 1 }, providerFee: { percent: 0, fixed: 0, min: 0, cap: 0 }, platformFee: { percent: 0, fixed: 0, min: 0, cap: 0 } } },
                receive: { "GHS-NGN": { rate: { percent: 3, fixed: 0 }, providerFee: { percent: 0, fixed: 0, min: 0, cap: 0 }, platformFee: { percent: 0, fixed: 0, min: 0, cap: 0 } } },
            } }, ADMIN);
            await addAdminRate("NGN", "GHS", 121);
            await addAdminRate("GHS", "NGN", 113);
            await addAdminRate("NGN", "RMB", 0.005);

            const rates = await listForUsers();
            const pair = (from: string, to: string) => rates.find((r) => r.from === from && r.to === to);
            // Fincra says ₦100 per GHS: sends pay ₦100 + 2% + ₦1 per cedi, receives get ₦100 − 3%.
            // Rates are units of `to` per 1 `from`, so NGN→GHS is cedis per naira
            expect(pair("NGN", "GHS")?.source).toBe("fincra");
            expect(pair("NGN", "GHS")?.rate).toBeCloseTo(1 / 103, 8);
            expect(pair("GHS", "NGN")).toMatchObject({ rate: 97, source: "fincra" });
            // Fincra doesn't price RMB, so the admin's rate stands
            expect(pair("NGN", "RMB")).toMatchObject({ rate: 0.005, source: "admin" });
        });

        it("shows live GHS rates even with no admin row, and hides a pair the admin switched off", async () => {
            await addAdminRate("GHS", "NGN", 113, false);
            const rates = await listForUsers();
            expect(rates.find((r) => r.from === "NGN" && r.to === "GHS")?.source).toBe("fincra");
            expect(rates.find((r) => r.from === "GHS" && r.to === "NGN")).toBeUndefined();
        });

        it("falls back to the admin's rate when Fincra can't be reached", async () => {
            fincra.ngnPerGhs.mockRejectedValueOnce(new Error("Fincra is down")).mockRejectedValueOnce(new Error("Fincra is down"));
            await addAdminRate("NGN", "GHS", 121);
            const rates = await listForUsers();
            expect(rates.find((r) => r.from === "NGN" && r.to === "GHS")).toMatchObject({ rate: 121, source: "admin" });
            expect(rates.find((r) => r.from === "GHS" && r.to === "NGN")).toBeUndefined();
        });
    });
});
