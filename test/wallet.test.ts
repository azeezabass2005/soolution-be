import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Payment providers are mocked: these tests are about our database logic
vi.mock("../src/services/fincra.service", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/services/fincra.service")>();
    return {
        ...actual,
        default: {
            createVirtualAccount: vi.fn(),
            getVirtualAccount: vi.fn(),
            createPayout: vi.fn(),
            getPayout: vi.fn(async () => null),
            listBanks: vi.fn(async () => []),
            resolveAccount: vi.fn(),
        },
    };
});
vi.mock("../src/services/fx-rate.service", () => ({
    default: { ngnPerUnit: vi.fn(async () => ({ rate: 100, providerRate: 98, source: "yellowcard" })) },
}));

import fincraService, { FincraError } from "../src/services/fincra.service";
import fincraWebhookService from "../src/services/fincra-webhook.service";
import { resetTestDatabase, startTestDatabase, stopTestDatabase } from "./helpers/db";
import { TEST_PIN, accountBalance, bootstrapLedger, createUser, fundWallet, walletBalance } from "./helpers/fixtures";
import WalletService from "../src/services/wallet.service";
import platformSettingsService from "../src/services/platform-settings.service";
import fxExchangeService from "../src/services/fx-exchange.service";
import walletTransactionRepository from "../src/repositories/wallet-transaction.repository";
import walletRepository from "../src/repositories/wallet.repository";
import userRepository from "../src/repositories/user.repository";
import reconciliationService from "../src/services/reconciliation.service";
import { SYSTEM_ACCOUNT_CODES, fincraCashCode, fincraPayoutInflightCode, userWalletAccountCode } from "../src/common/constant";
import { WALLET_LIMITS } from "../src/config/wallet-limits.config";
import { encryptIdentity } from "../src/utils/identity-crypto.utils";

const fincra = fincraService as unknown as Record<string, ReturnType<typeof vi.fn>>;
const walletService = new WalletService();
const NGN_CASH = fincraCashCode("NGN");
const NGN_INFLIGHT = fincraPayoutInflightCode("NGN");

/** A user whose NGN wallet has Fincra virtual account `vaId` */
async function userWithAccount(vaId: string) {
    const user = await createUser();
    const wallet = await walletRepository.findByUserAndCurrency(user.id, "NGN");
    await walletRepository.update(wallet!.id, { dvaProvider: "fincra", dvaExternalId: vaId, dvaAccountNumber: "9900112233", isDVAProvisioned: true });
    return user;
}

const deposit = (reference: string, virtualAccount: string, amountReceived: number, fee = 0) => ({
    event: "collection.successful",
    data: { reference, virtualAccount, sourceAmount: amountReceived + fee, amountReceived, fee, destinationCurrency: "NGN", status: "successful" },
});

describe("WalletService", () => {
    beforeAll(startTestDatabase);
    afterAll(stopTestDatabase);
    beforeEach(async () => {
        vi.clearAllMocks();
        fincra.getPayout.mockResolvedValue(null);
        await resetTestDatabase();
        await bootstrapLedger();
    });

    describe("NGN account (Fincra virtual account)", () => {
        it("opens one for a verified user, keyed by the wallet", async () => {
            const user = await createUser();
            await userRepository.updateIdentity(user.id, { bvnEnc: encryptIdentity("22212345678"), status: "verified" } as any);
            fincra.createVirtualAccount.mockResolvedValue({
                _id: "65f0a1b2c3d4e5f6a7b8c9d0",
                status: "approved",
                accountInformation: { accountNumber: "9012345678", bankName: "Wema Bank", accountName: "Ada Lovelace" },
            });
            const wallet = await walletRepository.findByUserAndCurrency(user.id, "NGN");

            const provisioned = await walletService.provisionDVA(wallet!.id, { id: user.id });
            expect(provisioned).toMatchObject({ isDVAProvisioned: true, dvaAccountNumber: "9012345678", dvaBankName: "Wema Bank", dvaProvider: "fincra" });
            expect(fincra.createVirtualAccount).toHaveBeenCalledWith(expect.objectContaining({ bvn: "22212345678", firstName: "Ada", lastName: "Lovelace", channel: "moniepoint", merchantReference: `sp-va-${wallet!.id}` }));

            // Asking again doesn't open another
            await walletService.provisionDVA(wallet!.id, { id: user.id });
            expect(fincra.createVirtualAccount).toHaveBeenCalledTimes(1);
        });

        it("falls back to Fincra's default bank when it refuses Moniepoint", async () => {
            const user = await createUser();
            await userRepository.updateIdentity(user.id, { bvnEnc: encryptIdentity("22212345678"), status: "verified" } as any);
            fincra.createVirtualAccount
                .mockRejectedValueOnce(new FincraError("channel not enabled", 422))
                .mockResolvedValueOnce({ _id: "65f0a1b2c3d4e5f6a7b8c9d2", status: "approved", accountInformation: { accountNumber: "9012345670", bankName: "Globus Bank" } });
            const wallet = await walletRepository.findByUserAndCurrency(user.id, "NGN");

            const provisioned = await walletService.provisionDVA(wallet!.id, { id: user.id });
            expect(provisioned).toMatchObject({ isDVAProvisioned: true, dvaBankName: "Globus Bank" });
            expect(fincra.createVirtualAccount).toHaveBeenLastCalledWith(expect.not.objectContaining({ channel: expect.anything() }));
        });

        it("waits for Fincra's approval webhook when the account is pending", async () => {
            const user = await createUser();
            await userRepository.updateIdentity(user.id, { bvnEnc: encryptIdentity("22212345678"), status: "verified" } as any);
            fincra.createVirtualAccount.mockResolvedValue({ _id: "65f0a1b2c3d4e5f6a7b8c9d1", status: "pending" });
            const wallet = await walletRepository.findByUserAndCurrency(user.id, "NGN");

            const pending = await walletService.provisionDVA(wallet!.id, { id: user.id });
            expect(pending).toMatchObject({ isDVAProvisioned: false, dvaStatus: "pending" });

            await fincraWebhookService.handle({
                event: "virtualaccount.approved",
                data: { id: "65f0a1b2c3d4e5f6a7b8c9d1", status: "approved", accountInformation: { accountNumber: "9012345679", bankName: "Globus Bank" } },
            });
            expect(await walletRepository.findById(wallet!.id)).toMatchObject({ isDVAProvisioned: true, dvaAccountNumber: "9012345679" });
        });

        it("asks unverified users to verify first", async () => {
            const user = await createUser({ identityStatus: "unverified" } as any);
            const wallet = await walletRepository.findByUserAndCurrency(user.id, "NGN");
            await expect(walletService.provisionDVA(wallet!.id, { id: user.id })).rejects.toMatchObject({ response_code: 403 });
            expect(fincra.createVirtualAccount).not.toHaveBeenCalled();
        });
    });

    describe("funding (Fincra collection.successful)", () => {
        it("credits what Fincra settled, once, however often the webhook arrives", async () => {
            const user = await userWithAccount("va-1");
            // ₦5,000 sent; Fincra kept its 1% (₦50), the whole default 1% fee, so nothing more is taken
            await fincraWebhookService.handle(deposit("fc-ref-1", "va-1", 4950, 50));
            await fincraWebhookService.handle(deposit("fc-ref-1", "va-1", 4950, 50));

            expect(await walletBalance(user.id)).toBe(4950);
            expect(await accountBalance(NGN_CASH)).toBe(4950);
            expect(await accountBalance(userWalletAccountCode(user.id, "NGN"))).toBe(4950);
            const history = await walletService.getTransactionHistory(user.id, { page: 1, limit: 10, type: "funding" });
            expect(history.data).toHaveLength(1);
        });

        it("credits once when duplicate webhooks arrive at the same time", async () => {
            const user = await userWithAccount("va-2");
            const results = await Promise.all([1, 2, 3].map(() => walletService.processFunding(deposit("fc-race", "va-2", 990, 10).data)));
            expect(results.filter(Boolean)).toHaveLength(1);
            expect(await walletBalance(user.id)).toBe(990);
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("holds unmatched money in suspense once instead of dropping it", async () => {
            await fincraWebhookService.handle(deposit("fc-orphan", "unknown-va", 2500));
            await fincraWebhookService.handle(deposit("fc-orphan", "unknown-va", 2500));
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.SUSPENSE_NGN)).toBe(2500);
            expect(await accountBalance(NGN_CASH)).toBe(2500);
        });

        it("holds unmatched money once when retries arrive at the same time", async () => {
            await Promise.all([1, 2, 3].map(() => fincraWebhookService.handle(deposit("fc-orphan-race", "unknown-va", 700))));
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.SUSPENSE_NGN)).toBe(700);
            expect(await accountBalance(NGN_CASH)).toBe(700);
        });

        it("never credits a deposit that is already held in suspense", async () => {
            const user = await userWithAccount("va-3");
            const wallet = await walletRepository.findByUserAndCurrency(user.id, "NGN");
            await walletRepository.update(wallet!.id, { status: "frozen" } as any);
            await fincraWebhookService.handle(deposit("fc-held", "va-3", 900)); // held: wallet frozen
            await walletRepository.update(wallet!.id, { status: "active" } as any);
            await fincraWebhookService.handle(deposit("fc-held", "va-3", 900)); // Fincra's retry
            expect(await walletBalance(user.id)).toBe(0);
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.SUSPENSE_NGN)).toBe(900);
            expect(await accountBalance(NGN_CASH)).toBe(900);
        });
    });

    describe("withdrawals (Fincra NGN payouts)", () => {
        it("debits, pays out with our reference, then settles once on payout.successful", async () => {
            const user = await createUser();
            await fundWallet(user.id, 10_000);
            fincra.createPayout.mockResolvedValue({ reference: "FP_1", status: "processing" });

            const withdrawal = await walletService.initiateWithdrawal(user.id, 4000, "058", "0123456789", "Ada Lovelace", TEST_PIN);
            expect(fincra.createPayout).toHaveBeenCalledWith(expect.objectContaining({
                customerReference: withdrawal.reference,
                sourceCurrency: "NGN",
                destinationCurrency: "NGN",
                amount: 4000,
                paymentDestination: "bank_account",
                beneficiary: expect.objectContaining({ firstName: "Ada", lastName: "Lovelace", accountNumber: "0123456789", bankCode: "058", country: "NG" }),
            }));
            expect(await walletBalance(user.id)).toBe(6000);
            expect(await accountBalance(NGN_INFLIGHT)).toBe(-4000);
            const processing = await walletTransactionRepository.findById(withdrawal.id);
            expect(processing?.status).toBe("processing");

            const success = { event: "payout.successful", data: { customerReference: withdrawal.reference, reference: "FP_1", status: "successful" } };
            await Promise.all([fincraWebhookService.handle(success), fincraWebhookService.handle(success)]);
            expect((await walletTransactionRepository.findById(withdrawal.id))?.status).toBe("successful");
            expect(await accountBalance(NGN_INFLIGHT)).toBe(0);
            expect(await accountBalance(NGN_CASH)).toBe(6000);
            const wallet = await walletRepository.findByUserAndCurrency(user.id, "NGN");
            expect(wallet?.ledgerBalance).toBe(6000);
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("refunds once on payout.failed", async () => {
            const user = await createUser();
            await fundWallet(user.id, 10_000);
            fincra.createPayout.mockResolvedValue({ reference: "FP_2", status: "processing" });

            const withdrawal = await walletService.initiateWithdrawal(user.id, 3000, "058", "0123456789", "Ada", TEST_PIN);
            const failed = { event: "payout.failed", data: { customerReference: withdrawal.reference, reference: "FP_2", status: "failed", reason: "Account closed" } };
            await Promise.all([fincraWebhookService.handle(failed), fincraWebhookService.handle(failed)]);
            expect(await walletBalance(user.id)).toBe(10_000);
            expect((await walletTransactionRepository.findById(withdrawal.id))?.status).toBe("failed");
            expect(await accountBalance(NGN_INFLIGHT)).toBe(0);
            const history = await walletService.getTransactionHistory(user.id, { page: 1, limit: 10, type: "reversal" });
            expect(history.data).toHaveLength(1);
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("never refunds a paid withdrawal, nor settles a refunded one, whatever arrives later", async () => {
            const user = await createUser();
            await fundWallet(user.id, 10_000);
            fincra.createPayout.mockResolvedValue({ reference: "FP_4", status: "processing" });
            const paid = await walletService.initiateWithdrawal(user.id, 1000, "058", "0123456789", "Ada", TEST_PIN);
            const refunded = await walletService.initiateWithdrawal(user.id, 2000, "058", "0123456789", "Ada", TEST_PIN);

            const ev = (event: string, ref: string) => ({ event, data: { customerReference: ref, reference: "FP_4", status: event.split(".")[1] } });
            await fincraWebhookService.handle(ev("payout.successful", paid.reference));
            await fincraWebhookService.handle(ev("payout.failed", paid.reference));
            await fincraWebhookService.handle(ev("payout.failed", refunded.reference));
            await fincraWebhookService.handle(ev("payout.successful", refunded.reference));

            expect((await walletTransactionRepository.findById(paid.id))?.status).toBe("successful");
            expect((await walletTransactionRepository.findById(refunded.id))?.status).toBe("failed");
            expect(await walletBalance(user.id)).toBe(9000);
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("reverses the debit when Fincra refuses the payout", async () => {
            const user = await createUser();
            await fundWallet(user.id, 10_000);
            fincra.createPayout.mockRejectedValue(new FincraError("Invalid account number", 422));

            await expect(walletService.initiateWithdrawal(user.id, 2000, "058", "0123456789", "Ada", TEST_PIN)).rejects.toMatchObject({ response_code: 400 });
            expect(await walletBalance(user.id)).toBe(10_000);
            const history = await walletService.getTransactionHistory(user.id, { page: 1, limit: 10, type: "withdrawal" });
            expect(history.data[0].status).toBe("failed");
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("keeps the debit when Fincra times out but has the payout", async () => {
            const user = await createUser();
            await fundWallet(user.id, 10_000);
            fincra.createPayout.mockRejectedValue(new FincraError("Fincra unreachable: timeout", 504));
            fincra.getPayout.mockResolvedValue({ reference: "FP_3", status: "processing" });

            const withdrawal = await walletService.initiateWithdrawal(user.id, 2000, "058", "0123456789", "Ada", TEST_PIN);
            expect(await walletBalance(user.id)).toBe(8000);
            expect((await walletTransactionRepository.findById(withdrawal.id))?.status).toBe("processing");

            // The status check later finds it paid
            fincra.getPayout.mockResolvedValue({ reference: "FP_3", status: "successful" });
            await walletService.verifyAndUpdateTransfer(user.id, withdrawal.id);
            expect((await walletTransactionRepository.findById(withdrawal.id))?.status).toBe("successful");
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("refuses to withdraw more than the balance", async () => {
            const user = await createUser();
            await fundWallet(user.id, 1500);
            await expect(walletService.initiateWithdrawal(user.id, 2000, "058", "0123456789", "Ada", TEST_PIN)).rejects.toMatchObject({ response_code: 400 });
            expect(fincra.createPayout).not.toHaveBeenCalled();
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

    describe("admin pricing", () => {
        const admin = "00000000-0000-4000-8000-000000000001";

        it("charges 1% capped at ₦500 in total: Fincra's part (capped at ₦300) plus SolutionPay's, once", async () => {
            await platformSettingsService.updateSettings({ pricing: { funding: { NGN: {
                providerFee: { percent: 1, fixed: 0, min: 0, cap: 300 },
                customerFee: { percent: 1, fixed: 0, min: 0, cap: 500 },
            } } } }, admin);
            const user = await userWithAccount("va-fee");
            // ₦100,000 sent: 1% is ₦1,000, capped at ₦500 in total. Fincra kept ₦300, SolutionPay takes ₦200.
            await fincraWebhookService.handle(deposit("fc-fee", "va-fee", 99_700, 300));
            await fincraWebhookService.handle(deposit("fc-fee", "va-fee", 99_700, 300));
            expect(await walletBalance(user.id)).toBe(99_500);
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.FEES_NGN)).toBe(200);
            expect(await accountBalance(NGN_CASH)).toBe(99_700);
            const [row] = (await walletService.getTransactionHistory(user.id, { page: 1, limit: 5, type: "funding" })).data;
            expect(row).toMatchObject({ amount: 99_500, fee: 200 });

            // ₦20,000 sent: 1% is ₦200, all Fincra's (under its ₦300 cap): nothing more is taken
            await fincraWebhookService.handle(deposit("fc-fee-2", "va-fee", 19_800, 200));
            expect(await walletBalance(user.id)).toBe(99_500 + 19_800);
            // ₦40,000 sent: 1% is ₦400; Fincra stops at ₦300, SolutionPay takes the other ₦100
            await fincraWebhookService.handle(deposit("fc-fee-3", "va-fee", 39_700, 300));
            expect(await walletBalance(user.id)).toBe(99_500 + 19_800 + 39_600);
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.FEES_NGN)).toBe(300);
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("charges the withdrawal fee on top, keeps it on success, refunds it on failure", async () => {
            // Fincra's ₦50 passed on, plus SolutionPay's 1% held between ₦100 and ₦500
            await platformSettingsService.updateSettings({ pricing: { withdrawal: { NGN: {
                providerFee: { percent: 0, fixed: 50, min: 0, cap: 0 },
                platformFee: { percent: 1, fixed: 0, min: 100, cap: 500 },
            } } } }, admin);
            const user = await createUser();
            await fundWallet(user.id, 100_000);
            fincra.createPayout.mockResolvedValue({ reference: "FP_FEE", status: "processing" });

            const paid = await walletService.initiateWithdrawal(user.id, 5_000, "058", "0123456789", "Ada", TEST_PIN); // fee 50 + 100
            const failed = await walletService.initiateWithdrawal(user.id, 80_000, "058", "0123456789", "Ada", TEST_PIN); // fee 50 + 500 (capped)
            expect(fincra.createPayout).toHaveBeenCalledWith(expect.objectContaining({ amount: 5_000 }));
            expect(await walletBalance(user.id)).toBe(100_000 - 5_150 - 80_550);
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.FEES_NGN)).toBe(700);

            await fincraWebhookService.handle({ event: "payout.successful", data: { customerReference: paid.reference, status: "successful" } });
            await fincraWebhookService.handle({ event: "payout.failed", data: { customerReference: failed.reference, status: "failed" } });
            expect(await walletBalance(user.id)).toBe(100_000 - 5_150);
            expect(await accountBalance(SYSTEM_ACCOUNT_CODES.FEES_NGN)).toBe(150);
            expect(await accountBalance(NGN_INFLIGHT)).toBe(0);
            expect((await walletRepository.findByUserAndCurrency(user.id, "NGN"))?.ledgerBalance).toBe(100_000 - 5_150);
            expect((await reconciliationService.runFullReconciliation()).status).toBe("clean");
        });

        it("refuses a withdrawal the balance can't cover with its fee", async () => {
            await platformSettingsService.updateSettings({ pricing: { withdrawal: { NGN: { platformFee: { percent: 0, fixed: 100, min: 0, cap: 0 } } } } }, admin);
            const user = await createUser();
            await fundWallet(user.id, 5_000);
            await expect(walletService.initiateWithdrawal(user.id, 5_000, "058", "0123456789", "Ada", TEST_PIN)).rejects.toMatchObject({ response_code: 400 });
            expect(fincra.createPayout).not.toHaveBeenCalled();
        });
    });

    describe("FX exchange", () => {
        it("quotes, executes once, and books both currencies", async () => {
            const user = await createUser();
            await fundWallet(user.id, 50_000);
            await walletService.getOrCreateWallet(user.id, "GHS"); // opened before wallets were switched off

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
            await walletService.getOrCreateWallet(user.id, "GHS");
            const quote = await fxExchangeService.quote(user.id, { fromCurrency: "NGN", toCurrency: "GHS", amount: 10_000 });

            await expect(fxExchangeService.execute(user.id, quote.id, TEST_PIN)).rejects.toMatchObject({ response_code: 400 });
            expect(await walletBalance(user.id)).toBe(5000);
            expect(await walletBalance(user.id, "GHS")).toBe(0);

            // The quote was not consumed: once funded, the same quote works
            await fundWallet(user.id, 5000);
            await expect(fxExchangeService.execute(user.id, quote.id, TEST_PIN)).resolves.toMatchObject({ toAmount: 100 });
        });

        it("won't open another wallet while only NGN is offered", async () => {
            const user = await createUser();
            await fundWallet(user.id, 50_000);
            await expect(walletService.createWallet(user.id, "GHS")).rejects.toMatchObject({ response_code: 403 });
            await expect(fxExchangeService.quote(user.id, { fromCurrency: "NGN", toCurrency: "GHS", amount: 10_000 })).rejects.toMatchObject({ response_code: 403 });
            expect(await walletRepository.findByUserAndCurrency(user.id, "GHS")).toBeUndefined();
        });
    });
});
