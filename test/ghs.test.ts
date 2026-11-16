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
        },
    };
});
vi.mock("../src/services/transaction-limit.service", () => ({
    default: {
        assertAllowed: vi.fn(async () => ({ usdValue: 10 })),
        assertCanTransact: vi.fn(async () => undefined),
        check: vi.fn(async () => ({ allowed: true, usdValue: 10 })),
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

        it("checks the number and network before charging anything", async () => {
            const user = await createUser();
            await fundWallet(user.id, 50_000);
            await expect(send(user.id, { destination: { accountType: "momo", accountName: "Kofi", accountNumber: "12", network: "MTN" } })).rejects.toMatchObject({ response_code: 400 });
            expect(fincra.createPayout).not.toHaveBeenCalled();
            expect(await walletBalance(user.id)).toBe(50_000);
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
});
