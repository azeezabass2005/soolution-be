import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Payment providers are mocked: these tests are about our database logic
vi.mock("../src/services/paystack.service", () => ({
    default: {
        createTransferRecipient: vi.fn(),
        initiateTransfer: vi.fn(),
        verifyTransfer: vi.fn(),
        createCustomer: vi.fn(),
        createDedicatedAccount: vi.fn(),
        listBanks: vi.fn(async () => []),
        resolveAccountNumber: vi.fn(),
    },
}));
vi.mock("../src/services/fx-rate.service", () => ({
    default: { ngnPerUnit: vi.fn(async () => ({ rate: 100, providerRate: 98, source: "yellowcard" })) },
}));

import paystackService from "../src/services/paystack.service";
import { resetTestDatabase, startTestDatabase, stopTestDatabase } from "./helpers/db";
import { TEST_PIN, accountBalance, bootstrapLedger, createUser, fundWallet, walletBalance } from "./helpers/fixtures";
import WalletService from "../src/services/wallet.service";
import fxExchangeService from "../src/services/fx-exchange.service";
import walletTransactionRepository from "../src/repositories/wallet-transaction.repository";
import walletRepository from "../src/repositories/wallet.repository";
import reconciliationService from "../src/services/reconciliation.service";
import { SYSTEM_ACCOUNT_CODES, userWalletAccountCode } from "../src/common/constant";
import { WALLET_LIMITS } from "../src/config/wallet-limits.config";

const paystack = paystackService as unknown as Record<string, ReturnType<typeof vi.fn>>;
const walletService = new WalletService();

describe("WalletService", () => {
    beforeAll(startTestDatabase);
    afterAll(stopTestDatabase);
    beforeEach(async () => {
        vi.clearAllMocks();
        await resetTestDatabase();
        await bootstrapLedger();
    });

    describe("funding (Paystack charge.success)", () => {
        it("credits the wallet, the ledger and the history once, however often the webhook arrives", async () => {
            const user = await createUser();
            const wallet = await walletRepository.findByUserAndCurrency(user.id, "NGN");
            await walletRepository.update(wallet!.id, { paystackCustomerCode: "CUS_1" });

            const payload = { customer: { customer_code: "CUS_1" } };
            const first = await walletService.processFunding("ps-ref-1", 500_000, payload); // ₦5,000
            const repeat = await walletService.processFunding("ps-ref-1", 500_000, payload);

            expect(first?.amount).toBe(5000);
            expect(first?.balanceBefore).toBe(0);
            expect(first?.balanceAfter).toBe(5000);
            expect(repeat).toBeNull();
            expect(await walletBalance(user.id)).toBe(5000);
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.CASH_PAYSTACK_NGN)).toBe(5000);
            expect(await accountBalance(userWalletAccountCode(user.id, "NGN"))).toBe(5000);
        });

        it("credits once when duplicate webhooks arrive at the same time", async () => {
            const user = await createUser();
            const wallet = await walletRepository.findByUserAndCurrency(user.id, "NGN");
            await walletRepository.update(wallet!.id, { dvaAccountNumber: "0123456789" });
            const payload = { authorization: { receiver_bank_account_number: "0123456789" } };

            const results = await Promise.all([
                walletService.processFunding("ps-race", 100_000, payload),
                walletService.processFunding("ps-race", 100_000, payload),
                walletService.processFunding("ps-race", 100_000, payload),
            ]);
            expect(results.filter(Boolean)).toHaveLength(1);
            expect(await walletBalance(user.id)).toBe(1000);
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("holds unmatched money in suspense instead of dropping it", async () => {
            const result = await walletService.processFunding("ps-orphan", 250_000, { customer: { customer_code: "UNKNOWN" } });
            expect(result).toBeNull();
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.SUSPENSE_NGN)).toBe(2500);
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.CASH_PAYSTACK_NGN)).toBe(2500);
        });
    });

    describe("withdrawals", () => {
        it("debits, then settles once on transfer.success", async () => {
            const user = await createUser();
            await fundWallet(user.id, 10_000);
            paystack.createTransferRecipient.mockResolvedValue({ recipient_code: "RCP_1" });
            paystack.initiateTransfer.mockResolvedValue({ transfer_code: "TRF_1" });

            const withdrawal = await walletService.initiateWithdrawal(user.id, 4000, "058", "0123456789", "Ada Lovelace", TEST_PIN);
            expect(await walletBalance(user.id)).toBe(6000);
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.PAYSTACK_TRANSFER_INFLIGHT_NGN)).toBe(-4000);
            const processing = await walletTransactionRepository.findById(withdrawal.id);
            expect(processing?.status).toBe("processing");
            expect(processing?.paystackTransferCode).toBe("TRF_1");

            await Promise.all([
                walletService.processWithdrawalSuccess("TRF_1", withdrawal.reference),
                walletService.processWithdrawalSuccess("TRF_1", withdrawal.reference),
            ]);
            expect((await walletTransactionRepository.findById(withdrawal.id))?.status).toBe("successful");
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.PAYSTACK_TRANSFER_INFLIGHT_NGN)).toBe(0);
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.CASH_PAYSTACK_NGN)).toBe(6000);
            const wallet = await walletRepository.findByUserAndCurrency(user.id, "NGN");
            expect(wallet?.ledgerBalance).toBe(6000);
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("refunds once on transfer.failed", async () => {
            const user = await createUser();
            await fundWallet(user.id, 10_000);
            paystack.createTransferRecipient.mockResolvedValue({ recipient_code: "RCP_1" });
            paystack.initiateTransfer.mockResolvedValue({ transfer_code: "TRF_2" });

            const withdrawal = await walletService.initiateWithdrawal(user.id, 3000, "058", "0123456789", "Ada", TEST_PIN);
            await Promise.all([
                walletService.processWithdrawalFailure("TRF_2", withdrawal.reference, "Account closed"),
                walletService.processWithdrawalFailure("TRF_2", withdrawal.reference, "Account closed"),
            ]);
            expect(await walletBalance(user.id)).toBe(10_000);
            expect((await walletTransactionRepository.findById(withdrawal.id))?.status).toBe("failed");
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.PAYSTACK_TRANSFER_INFLIGHT_NGN)).toBe(0);
            const history = await walletService.getTransactionHistory(user.id, { page: 1, limit: 10, type: "reversal" });
            expect(history.data).toHaveLength(1);
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("reverses the debit when Paystack refuses the transfer", async () => {
            const user = await createUser();
            await fundWallet(user.id, 10_000);
            paystack.createTransferRecipient.mockRejectedValue(Object.assign(new Error("bad"), { response: { data: { message: "Cannot resolve account" } } }));

            await expect(walletService.initiateWithdrawal(user.id, 2000, "058", "0123456789", "Ada", TEST_PIN)).rejects.toMatchObject({ response_code: 400 });
            expect(await walletBalance(user.id)).toBe(10_000);
            const history = await walletService.getTransactionHistory(user.id, { page: 1, limit: 10, type: "withdrawal" });
            expect(history.data[0].status).toBe("failed");
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("refuses to withdraw more than the balance", async () => {
            const user = await createUser();
            await fundWallet(user.id, 1500);
            await expect(walletService.initiateWithdrawal(user.id, 2000, "058", "0123456789", "Ada", TEST_PIN)).rejects.toMatchObject({ response_code: 400 });
            expect(paystack.initiateTransfer).not.toHaveBeenCalled();
            expect(await walletBalance(user.id)).toBe(1500);
        });

        it("rejects a wrong PIN and locks after too many attempts", async () => {
            const user = await createUser();
            await fundWallet(user.id, 5000);
            for (let i = 0; i < WALLET_LIMITS.MAX_PIN_ATTEMPTS; i++) {
                await expect(walletService.initiateWithdrawal(user.id, 1000, "058", "0123456789", "Ada", "9999")).rejects.toMatchObject({ response_code: 401 });
            }
            // Locked now, even with the right PIN
            await expect(walletService.initiateWithdrawal(user.id, 1000, "058", "0123456789", "Ada", TEST_PIN)).rejects.toMatchObject({ response_code: 429 });
        });
    });

    describe("debit guard", () => {
        it("never lets concurrent debits overdraw a wallet", async () => {
            const user = await createUser();
            await fundWallet(user.id, 1000);
            const wallet = await walletRepository.findByUserAndCurrency(user.id, "NGN");
            const results = await Promise.allSettled(Array.from({ length: 5 }, () => walletService.debitBalance(wallet!.id, 400)));
            expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
            expect(await walletBalance(user.id)).toBe(200);
        });
    });

    describe("FX exchange", () => {
        it("quotes, executes once, and books both currencies", async () => {
            const user = await createUser();
            await fundWallet(user.id, 50_000);

            const quote = await fxExchangeService.quote(user.id, { fromCurrency: "NGN", toCurrency: "GHS", amount: 10_000 });
            expect(quote).toMatchObject({ fromAmount: 10_000, toAmount: 100, rate: 100 });

            const result = await fxExchangeService.execute(user.id, quote.id, TEST_PIN);
            expect(result.fromWallet.balance).toBe(40_000);
            expect(result.toWallet.balance).toBe(100);
            expect(result.transactions).toHaveLength(2);
            expect(result.transactions[0].reference.endsWith("-OUT")).toBe(true);

            await expect(fxExchangeService.execute(user.id, quote.id, TEST_PIN)).rejects.toMatchObject({ response_code: 409 });
            expect(await walletBalance(user.id, "GHS")).toBe(100);
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("rolls back (and releases the quote) when the balance is short", async () => {
            const user = await createUser();
            await fundWallet(user.id, 5000);
            const quote = await fxExchangeService.quote(user.id, { fromCurrency: "NGN", toCurrency: "GHS", amount: 10_000 });

            await expect(fxExchangeService.execute(user.id, quote.id, TEST_PIN)).rejects.toMatchObject({ response_code: 400 });
            expect(await walletBalance(user.id)).toBe(5000);
            expect(await walletBalance(user.id, "GHS")).toBe(0);

            // The quote was not consumed: once funded, the same quote works
            await fundWallet(user.id, 5000);
            await expect(fxExchangeService.execute(user.id, quote.id, TEST_PIN)).resolves.toMatchObject({ toAmount: 100 });
        });
    });
});
