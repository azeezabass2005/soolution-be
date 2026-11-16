import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// External providers and notifications are mocked; everything database-side is real
vi.mock("../src/services/yellowcard.service", () => ({
    default: {
        getRates: vi.fn(async () => ({
            rates: [
                { code: "NGN", buy: 1500, sell: 1500 },
                { code: "KES", buy: 130, sell: 130 },
                { code: "GHS", buy: 15, sell: 15 },
            ],
        })),
        getImpliedRate: vi.fn(async () => 10),
        getCountryConfig: vi.fn(async (_country: string, currency: string) => ({
            currency, send: true, receive: true, sendMin: 0, sendMax: 0, receiveMin: 0, receiveMax: 0, channelTypes: ["momo", "bank"],
        })),
        getNetworks: vi.fn(async () => ({ networks: [{ id: "net-1", name: "Mpesa", status: "active", accountNumberType: "phone" }] })),
        submitPaymentRequest: vi.fn(),
        lookupPaymentBySequenceId: vi.fn(),
        submitCollectionRequest: vi.fn(),
        lookupCollection: vi.fn(),
        lookupCollectionBySequenceId: vi.fn(),
    },
}));
vi.mock("../src/services/ogateway.service", () => ({
    default: {
        getUserFacingRate: vi.fn(async () => ({ providerRate: 100, userRate: 100 })),
        payoutMobileMoney: vi.fn(),
        payoutBank: vi.fn(),
        collectMobileMoney: vi.fn(),
        getTransactionStatus: vi.fn(),
    },
}));
vi.mock("../src/utils/notification.utils", () => ({
    default: class {
        emailService = { sendNotificationEmail: vi.fn(), sendWelcomeEmail: vi.fn(), sendPasswordResetEmail: vi.fn() };
        sendTransactionNotification = vi.fn();
        notifyAdmins = vi.fn();
        sendNotification = vi.fn();
    },
}));

import yellowCardService from "../src/services/yellowcard.service";
import ogatewayService from "../src/services/ogateway.service";
import { resetTestDatabase, startTestDatabase, stopTestDatabase } from "./helpers/db";
import { TEST_PIN, accountBalance, bootstrapLedger, createUser, fundWallet, walletBalance } from "./helpers/fixtures";
import TransactionService from "../src/services/transaction.service";
import walletSendService from "../src/services/wallet-send.service";
import BankAccountDetailsService from "../src/services/bank-account-details.service";
import exchangeRateRepository from "../src/repositories/exchange-rate.repository";
import transactionRepository from "../src/repositories/transaction.repository";
import walletTransactionRepository from "../src/repositories/wallet-transaction.repository";
import reconciliationService from "../src/services/reconciliation.service";
import { SYSTEM_ACCOUNT_CODES, ogPaymentInflightCode } from "../src/common/constant";
import { manualPayoutPendingCode } from "../src/common/wallet.constants";

const yc = yellowCardService as unknown as Record<string, ReturnType<typeof vi.fn>>;
const og = ogatewayService as unknown as Record<string, ReturnType<typeof vi.fn>>;
const transactionService = new TransactionService();

const expectLedgerClean = async () => {
    const report = await reconciliationService.runFullReconciliation();
    expect(report.status, JSON.stringify({ wallet: report.walletProof, account: report.accountProof, ledger: report.ledgerProof })).toBe("clean");
};

describe("TransactionService", () => {
    beforeAll(startTestDatabase);
    afterAll(stopTestDatabase);
    beforeEach(async () => {
        vi.clearAllMocks();
        await resetTestDatabase();
        await bootstrapLedger();
    });

    describe("YellowCard send", () => {
        const send = (userId: string) =>
            transactionService.createYellowCardTransaction(
                {
                    amount: 1000, // KES
                    fromCurrency: "NGN",
                    toCurrency: "KES",
                    destination: { accountName: "Jane Doe", accountNumber: "+254700000000", accountType: "momo", country: "KE" },
                    pin: TEST_PIN,
                },
                userId
            );

        it("debits the wallet and completes exactly once when polls race", async () => {
            const user = await createUser();
            await fundWallet(user.id, 50_000);
            yc.submitPaymentRequest.mockResolvedValue({ id: "pay-1", channelId: "ch-1", status: "processing" });

            const created: any = await send(user.id);
            expect(created.status).toBe("processing");
            expect(created.details.ycPaymentId).toBe("pay-1");
            expect(await walletBalance(user.id)).toBe(40_000); // 1000 KES × 10

            yc.lookupPaymentBySequenceId.mockResolvedValue({ status: "complete" });
            await Promise.all([
                transactionService.pollYellowCardStatus(created.id),
                transactionService.pollYellowCardStatus(created.id),
            ]);

            const tx = await transactionRepository.findById(created.id);
            expect(tx?.status).toBe("completed");
            const walletTx = await walletTransactionRepository.findByPaystackReference(created.reference, "transfer");
            expect(walletTx?.status).toBe("successful");
            expect(walletTx?.transactionId).toBe(created.id);
            const view = await transactionService.findView(created.id);
            expect(typeof view?.user === "object" && view.user.email).toBe(user.email);
            await expectLedgerClean();
        });

        it("refunds the wallet when YellowCard rejects the payment", async () => {
            const user = await createUser();
            await fundWallet(user.id, 50_000);
            yc.submitPaymentRequest.mockRejectedValue(Object.assign(new Error("rejected"), { ycError: { message: "invalid account" } }));

            await expect(send(user.id)).rejects.toMatchObject({ response_code: 400 });
            expect(await walletBalance(user.id)).toBe(50_000);
            const page = await transactionService.listTransactions({ user: user.id }, {});
            expect(page.data).toHaveLength(1);
            expect(page.data[0].status).toBe("failed");
            await expectLedgerClean();
        });

        it("refunds once when the payment later fails and webhooks repeat", async () => {
            const user = await createUser();
            await fundWallet(user.id, 50_000);
            yc.submitPaymentRequest.mockResolvedValue({ id: "pay-2", status: "processing" });
            const created: any = await send(user.id);

            yc.lookupPaymentBySequenceId.mockResolvedValue({ status: "failed" });
            await Promise.all([
                transactionService.handleYellowCardWebhook({ event: "PAYMENT.FAILED", sequenceId: created.reference }),
                transactionService.handleYellowCardWebhook({ event: "PAYMENT.FAILED", sequenceId: created.reference }),
            ]);
            expect(await walletBalance(user.id)).toBe(50_000);
            expect((await transactionRepository.findById(created.id))?.status).toBe("failed");
            await expectLedgerClean();
        });

        it("returns the same transaction for a repeated idempotency key", async () => {
            const user = await createUser();
            await fundWallet(user.id, 50_000);
            yc.submitPaymentRequest.mockResolvedValue({ id: "pay-3", status: "processing" });
            const params = {
                amount: 100,
                fromCurrency: "NGN",
                toCurrency: "KES",
                destination: { accountName: "Jane", accountNumber: "+254700000000", accountType: "momo", country: "KE" },
                pin: TEST_PIN,
                idempotencyKey: "idem-1",
            };
            const first: any = await transactionService.createYellowCardTransaction(params, user.id);
            const second: any = await transactionService.createYellowCardTransaction(params, user.id);
            expect(second.id).toBe(first.id);
            expect(yc.submitPaymentRequest).toHaveBeenCalledTimes(1);
            expect(await walletBalance(user.id)).toBe(49_000);
        });
    });

    describe("YellowCard collection", () => {
        it("credits the wallet once when the collection completes", async () => {
            const user = await createUser();
            yc.submitCollectionRequest.mockResolvedValue({ id: "col-1", status: "processing" });
            const created: any = await transactionService.createYellowCardCollectionTransaction(
                { amount: 2000, fromCurrency: "KES", toCurrency: "NGN", sender: { country: "KE" }, destination: { accountType: "momo", network: "Mpesa" } },
                user.id
            );
            expect(created.details.fromAmount).toBe(20_000);

            yc.lookupCollection.mockResolvedValue({ status: "complete" });
            await Promise.all([
                transactionService.pollYellowCardCollectionStatus(created.id),
                transactionService.pollYellowCardCollectionStatus(created.id),
                transactionService.pollYellowCardCollectionStatus(created.id),
            ]);
            expect(await walletBalance(user.id)).toBe(20_000);
            expect((await transactionRepository.findById(created.id))?.status).toBe("completed");
            // Asset: YellowCard now holds the naira it collected for us
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.YC_FLOAT_NGN)).toBe(20_000);
            await expectLedgerClean();
        });
    });

    describe("OGateway", () => {
        it("settles a payout once even if the webhook and the sweeper race", async () => {
            const user = await createUser();
            await fundWallet(user.id, 100_000);
            og.payoutMobileMoney.mockResolvedValue([{ id: "og-1", status: "PENDING" }]);

            const created: any = await transactionService.createOGatewayPayoutTransaction(
                {
                    amount: 100, // GHS
                    fromCurrency: "NGN",
                    toCurrency: "GHS",
                    destination: { accountType: "momo", accountName: "Kofi", accountNumber: "0240000000", network: "MTN" },
                    pin: TEST_PIN,
                },
                user.id
            );
            // 100 GHS × 100 = ₦10,000 + 1.5% OGateway fee
            expect(await walletBalance(user.id)).toBe(100_000 - 10_150);
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.FEES_NGN)).toBe(150);

            const webhook = { reference_business: created.reference, id: "og-1", status: "COMPLETED" };
            await Promise.all([transactionService.handleOGatewayWebhook(webhook), transactionService.handleOGatewayWebhook(webhook)]);

            expect((await transactionRepository.findById(created.id))?.status).toBe("completed");
            expect(await accountBalance(ogPaymentInflightCode("GHS"))).toBe(0);
            const walletTx = await walletTransactionRepository.findByPaystackReference(created.reference, "transfer");
            expect(walletTx?.status).toBe("successful");
            await expectLedgerClean();
        });

        it("credits a collection once", async () => {
            const user = await createUser();
            og.collectMobileMoney.mockResolvedValue({ id: "og-c1", status: "PENDING" });
            const created: any = await transactionService.createOGatewayCollectionTransaction(
                { amount: 100, fromCurrency: "GHS", toCurrency: "NGN", sender: { accountName: "Ama", accountNumber: "0240000001", network: "MTN" } },
                user.id
            );
            const webhook = { reference_business: created.reference, id: "og-c1", status: "COMPLETED" };
            await Promise.all([transactionService.handleOGatewayWebhook(webhook), transactionService.handleOGatewayWebhook(webhook)]);

            // ₦10,000 gross less the 1.5% fee
            expect(await walletBalance(user.id)).toBe(9850);
            await expectLedgerClean();
        });
    });

    describe("manual payouts paid from a wallet", () => {
        it("holds the money, and refunds once when an admin rejects it", async () => {
            const user = await createUser();
            await fundWallet(user.id, 1000, "GHS");
            await exchangeRateRepository.create({ from: "NGN", to: "GHS", rate: 0.01, isActive: true });

            const created: any = await transactionService.createBankTransferTransaction(
                {
                    amount: 200,
                    fromCurrency: "NGN",
                    toCurrency: "GHS",
                    paymentMethod: "mobile_money",
                    institutionType: "momo",
                    momoNetwork: "MTN",
                    momoNumber: "0240000000",
                    momoName: "Kofi",
                    transactionType: "send",
                    walletCurrency: "GHS",
                    pin: TEST_PIN,
                },
                user.id
            );
            expect(created.status).toBe("awaiting_confirmation");
            expect(created.details.fundingCurrency).toBe("GHS");
            expect(await walletBalance(user.id, "GHS")).toBe(800);
            expect(await accountBalance(manualPayoutPendingCode("GHS"))).toBe(200);

            const rejected = await transactionService.rejectManualTransaction(created.id, "Wrong number");
            expect(rejected.refundedToWallet).toBe(true);
            expect(await walletBalance(user.id, "GHS")).toBe(1000);
            await expect(transactionService.rejectManualTransaction(created.id, "again")).rejects.toBeDefined();
            expect(await walletBalance(user.id, "GHS")).toBe(1000);
            await expectLedgerClean();
        });

        it("moves held money to the FX position on completion", async () => {
            const user = await createUser();
            await fundWallet(user.id, 500, "GHS");
            await exchangeRateRepository.create({ from: "NGN", to: "GHS", rate: 0.01, isActive: true });
            const created: any = await transactionService.createBankTransferTransaction(
                {
                    amount: 150, fromCurrency: "NGN", toCurrency: "GHS", paymentMethod: "mobile_money", institutionType: "momo",
                    momoNetwork: "MTN", momoNumber: "0240000000", momoName: "Kofi", transactionType: "send", walletCurrency: "GHS", pin: TEST_PIN,
                },
                user.id
            );
            await Promise.all([walletSendService.completeManualPayout(created.id), walletSendService.completeManualPayout(created.id)]);
            expect(await accountBalance(manualPayoutPendingCode("GHS"))).toBe(0);
            expect(await walletBalance(user.id, "GHS")).toBe(350);
            await expectLedgerClean();
        });
    });

    describe("bank transfer paid by the customer", () => {
        it("shows the company's default account and lists the transaction with details and owner", async () => {
            const user = await createUser();
            const banks = new BankAccountDetailsService();
            await banks.createAccountDetails({ currency: "NGN", accountNumber: "0011223344", accountName: "Solution Pay", bankName: "Zenith" });
            await exchangeRateRepository.create({ from: "NGN", to: "KES", rate: 0.1, isActive: true });

            const created: any = await transactionService.createBankTransferTransaction(
                {
                    amount: 500, fromCurrency: "NGN", toCurrency: "KES", paymentMethod: "bank_transfer", institutionType: "bank",
                    bankName: "KCB", accountNumber: "123456", accountName: "Wanjiku", transactionType: "send", pin: TEST_PIN,
                },
                user.id
            );
            expect(created.status).toBe("pending_input");
            expect(created.details.bankAccountDetails.accountNumber).toBe("0011223344");
            expect(created.details.fromAmount).toBe(5000);

            const page = await transactionService.listTransactions({ user: user.id, currency: ["KES", "GHS"] }, { page: 1, limit: 10 }, created.reference.slice(0, 8));
            expect(page.paginator.itemsCount).toBe(1);
            expect(page.data[0].details?.accountName).toBe("Wanjiku");
            expect((page.data[0].user as any).firstName).toBe("Ada");
        });
    });
});
