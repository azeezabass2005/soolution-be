import type { Executor } from "../db/client";
import { withTransaction } from "../db/transaction";
import { isUniqueViolation } from "../db/errors";
import walletRepository from "../repositories/wallet.repository";
import walletTransactionRepository from "../repositories/wallet-transaction.repository";
import accountRepository from "../repositories/account.repository";
import type { Wallet, WalletTransaction } from "../types/entities";
import WalletTransactionService from "./wallet-transaction.service";
import paystackService from "./paystack.service";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import {
    WALLET_STATUS,
    WALLET_TRANSACTION_TYPE,
    WALLET_TRANSACTION_STATUS,
    ACCOUNT_TYPE,
    JOURNAL_DIRECTION,
    JOURNAL_SOURCE,
    SYSTEM_ACCOUNT_CODES,
    WEBHOOK_PROVIDER,
    userWalletAccountCode,
} from "../common/constant";
import { WALLET_LIMITS } from "../config/wallet-limits.config";
import { BASE_WALLET_CURRENCY, WALLET_CURRENCIES, WalletCurrency, isWalletCurrency } from "../common/wallet.constants";
import config from "../config/env.config";
import logger from "../utils/logger.utils";
import PinService from "./pin.service";
import ledgerService from "./ledger.service";
import AuditLogService from "./audit-log.service";
import { withoutProviderName } from "../utils/provider-names.utils";
import type { PageRequest } from "../db/pagination";

const auditLogService = new AuditLogService();
const round2 = (n: number) => Math.round(n * 100) / 100;

/** What a profile/DVA owner needs to have for Paystack */
interface DvaOwner {
    email: string;
    firstName: string;
    lastName: string;
    phoneNumber?: string;
}

class WalletService {
    private walletTransactionService: WalletTransactionService;
    private pinService: PinService;

    constructor() {
        this.walletTransactionService = new WalletTransactionService();
        this.pinService = new PinService();
    }

    // ===================== WALLET MANAGEMENT =====================

    /**
     * Get or create one of a user's wallets (NGN unless another currency is
     * given). Also ensures the wallet's ledger account
     * (USER_WALLET_{CUR}:{userId}) exists so postings have a target ready.
     */
    async getOrCreateWallet(userId: string, currency: WalletCurrency = BASE_WALLET_CURRENCY, tx?: Executor): Promise<Wallet> {
        const { wallet } = await walletRepository.findOrCreate(userId, currency, tx);
        await this.ensureUserLedgerAccount(userId, wallet, tx);
        return wallet;
    }

    /** One of the user's wallets, if it exists */
    async findWallet(userId: string, currency: string, tx?: Executor): Promise<Wallet | undefined> {
        return walletRepository.findByUserAndCurrency(userId, currency, tx);
    }

    /** The user's NGN wallet if it exists (funding, withdrawals and NGN sends use it) */
    async findBaseWallet(userId: string, tx?: Executor): Promise<Wallet | undefined> {
        return walletRepository.findByUserAndCurrency(userId, BASE_WALLET_CURRENCY, tx);
    }

    async findById(walletId: string): Promise<Wallet | undefined> {
        return walletRepository.findById(walletId);
    }

    /** All of a user's wallets, NGN first then in the order they were opened */
    async listWallets(userId: string) {
        await this.getOrCreateWallet(userId);
        const wallets = await walletRepository.listByUser(userId);
        return wallets
            .map((w) => ({
                id: w.id,
                currency: w.currency,
                balance: w.balance,
                ledgerBalance: w.ledgerBalance,
                status: w.status,
                isDVAProvisioned: w.isDVAProvisioned,
                dvaBankName: w.dvaBankName,
                dvaAccountNumber: w.dvaAccountNumber,
                dvaAccountName: w.dvaAccountName,
                createdAt: w.createdAt,
            }))
            .sort((a, b) => Number(b.currency === BASE_WALLET_CURRENCY) - Number(a.currency === BASE_WALLET_CURRENCY));
    }

    /** Open a wallet in another currency */
    async createWallet(userId: string, currency: unknown): Promise<Wallet> {
        const code = typeof currency === "string" ? currency.trim().toUpperCase() : currency;
        if (!isWalletCurrency(code)) {
            throw errorResponseMessage.createError(400, "Choose a currency we support for wallets", ErrorSeverity.LOW, {
                supported: WALLET_CURRENCIES,
            });
        }
        const existing = await walletRepository.findByUserAndCurrency(userId, code);
        if (existing) {
            throw errorResponseMessage.createError(409, `You already have a ${code} wallet`, ErrorSeverity.LOW, {
                walletId: existing.id,
            });
        }
        const wallet = await this.getOrCreateWallet(userId, code);
        logger.info("Wallet opened", { userId, currency: code });
        return wallet;
    }

    /**
     * Idempotently create the user's per-currency ledger liability account.
     * Called from getOrCreateWallet so any path that touches a wallet has the
     * matching ledger account in place.
     */
    private async ensureUserLedgerAccount(userId: string, wallet: Wallet, tx?: Executor): Promise<void> {
        await accountRepository.createIfMissing(
            {
                code: userWalletAccountCode(userId, wallet.currency),
                type: ACCOUNT_TYPE.LIABILITY,
                currency: wallet.currency,
                name: `User wallet ${wallet.currency} — ${userId}`,
                ownerUser: userId,
                ownerWallet: wallet.id,
                balance: 0,
                isSystem: false,
            },
            tx
        );
    }

    /** Provision a Paystack DVA for a wallet (lazy — called on first access) */
    async provisionDVA(walletId: string, user: DvaOwner): Promise<Wallet> {
        const wallet = await walletRepository.findById(walletId);
        if (!wallet) throw errorResponseMessage.resourceNotFound("Wallet");

        if (wallet.isDVAProvisioned) return wallet;

        const customer = await paystackService.createCustomer({
            email: user.email,
            first_name: user.firstName,
            last_name: user.lastName,
            phone: user.phoneNumber,
        });

        const dva = await paystackService.createDedicatedAccount(customer.customer_code);

        const updated = await walletRepository.update(walletId, {
            paystackCustomerCode: customer.customer_code,
            paystackCustomerId: customer.id,
            dvaBankName: dva.bank?.name,
            dvaAccountNumber: dva.account_number,
            dvaAccountName: dva.account_name,
            dvaBankId: dva.bank?.id,
            dvaId: dva.id,
            isDVAProvisioned: true,
        });

        if (!updated) throw errorResponseMessage.resourceNotFound("Wallet");

        logger.info("Wallet DVA provisioned", { walletId, accountNumber: dva.account_number });
        return updated;
    }

    // ===================== PIN MANAGEMENT =====================
    // The PIN lives on the user and is managed by PinService. These keep the
    // wallet-scoped API that wallet.controller.ts uses.

    async setPin(userId: string, pin: string): Promise<void> {
        await this.pinService.setPin(userId, pin);
    }

    async changePin(userId: string, oldPin: string, newPin: string): Promise<void> {
        await this.pinService.changePin(userId, oldPin, newPin);
    }

    async verifyPin(userId: string, pin: string): Promise<void> {
        await this.pinService.verifyPin(userId, pin);
    }

    // ===================== FUNDING (Webhook-driven) =====================

    /**
     * Process wallet funding from Paystack webhook (charge.success).
     * Idempotent on the Paystack reference: a unique index on funding rows means
     * a duplicate (or concurrent) webhook can never credit twice.
     */
    async processFunding(paystackReference: string, amountInKobo: number, webhookData?: any): Promise<WalletTransaction | null> {
        const amount = Math.round(amountInKobo) / 100; // kobo → NGN

        const existing = await walletTransactionRepository.findByPaystackReference(paystackReference);
        if (existing) {
            logger.info("Wallet funding already processed (idempotent)", { paystackReference });
            return null;
        }

        // Paystack sends: data.customer.customer_code and data.authorization.receiver_bank_account_number
        const customerCode = webhookData?.customer?.customer_code;
        const dvaAccountNumber = webhookData?.authorization?.receiver_bank_account_number;

        logger.info("Processing funding", { paystackReference, customerCode, dvaAccountNumber, amount });

        let wallet = customerCode ? await walletRepository.findByPaystackCustomerCode(customerCode) : undefined;
        if (!wallet && dvaAccountNumber) {
            wallet = await walletRepository.findByDvaAccountNumber(dvaAccountNumber);
        }

        // No matching wallet — instead of silently dropping the money, post a
        // suspense entry so the funds are captured in the ledger and can be
        // attributed manually by an admin later.
        if (!wallet) {
            logger.error("Wallet not found for funding — routing to SUSPENSE", { paystackReference, customerCode, dvaAccountNumber });
            await this.recordSuspenseFunding({ paystackReference, amount, customerCode, dvaAccountNumber, webhookData });
            return null;
        }

        if (wallet.status !== WALLET_STATUS.ACTIVE) {
            logger.warn("Funding attempted on non-active wallet — routing to SUSPENSE", { walletId: wallet.id, status: wallet.status });
            await this.recordSuspenseFunding({
                paystackReference,
                amount,
                customerCode,
                dvaAccountNumber,
                webhookData,
                note: `wallet status is ${wallet.status}`,
            });
            return null;
        }

        await this.ensureUserLedgerAccount(wallet.user, wallet);
        const target = wallet;

        let walletTransaction: WalletTransaction;
        try {
            walletTransaction = await withTransaction(async (tx) => {
                const reference = this.walletTransactionService.generateReference("FND");

                // Money entered the platform via Paystack (CASH_PAYSTACK_NGN) and
                // we now owe the user (USER_WALLET_NGN:{userId}).
                await ledgerService.post({
                    legs: [
                        { accountCode: SYSTEM_ACCOUNT_CODES.CASH_PAYSTACK_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount },
                        { accountCode: userWalletAccountCode(target.user, target.currency), direction: JOURNAL_DIRECTION.CREDIT, amount },
                    ],
                    source: JOURNAL_SOURCE.FUNDING,
                    reference,
                    description: `Wallet funding via Paystack DVA (${paystackReference})`,
                    externalRef: { provider: WEBHOOK_PROVIDER.PAYSTACK, id: paystackReference },
                    metadata: { customerCode, dvaAccountNumber },
                    tx,
                });

                const updated = await walletRepository.credit(target.id, amount, tx, { alsoLedger: true, requireActive: true });
                if (!updated) {
                    throw errorResponseMessage.createError(500, "Failed to update wallet balance", ErrorSeverity.CRITICAL);
                }

                return walletTransactionRepository.create(
                    {
                        wallet: target.id,
                        user: target.user,
                        type: WALLET_TRANSACTION_TYPE.FUNDING,
                        status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                        amount,
                        reference,
                        balanceBefore: round2(updated.balance - amount),
                        balanceAfter: updated.balance,
                        description: `Wallet funding via bank transfer`,
                        currency: target.currency,
                        paystackReference,
                    },
                    tx
                );
            });
        } catch (error) {
            if (isUniqueViolation(error, "wallet_transactions_funding_reference_key")) {
                // A concurrent delivery of the same webhook credited it first
                logger.info("Wallet funding already processed (concurrent duplicate)", { paystackReference });
                return null;
            }
            logger.error("Wallet funding failed", { paystackReference, error: error instanceof Error ? error.message : String(error) });
            throw error;
        }

        logger.info("Wallet funded successfully", { walletId: target.id, amount, reference: walletTransaction.reference });

        // Best-effort: a logging failure does NOT block the funding result.
        try {
            await auditLogService.logAction(
                undefined,
                target.user,
                "funding_received",
                undefined,
                { amount, reference: walletTransaction.reference, paystackReference },
                undefined,
                undefined,
                { customerCode, dvaAccountNumber, walletId: target.id }
            );
        } catch (auditError) {
            logger.warn("Audit log write failed (funding_received)", {
                paystackReference,
                error: auditError instanceof Error ? auditError.message : String(auditError),
            });
        }

        return walletTransaction;
    }

    /**
     * Capture an unmatched funding event in the SUSPENSE ledger so the funds
     * are tracked until an admin attributes them.
     */
    private async recordSuspenseFunding(opts: {
        paystackReference: string;
        amount: number;
        customerCode?: string;
        dvaAccountNumber?: string;
        webhookData?: any;
        note?: string;
    }): Promise<void> {
        try {
            await ledgerService.postStandalone({
                legs: [
                    { accountCode: SYSTEM_ACCOUNT_CODES.CASH_PAYSTACK_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: opts.amount },
                    { accountCode: SYSTEM_ACCOUNT_CODES.SUSPENSE_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: opts.amount },
                ],
                source: JOURNAL_SOURCE.FUNDING,
                reference: opts.paystackReference,
                description: `Unmatched Paystack funding held in suspense${opts.note ? ` — ${opts.note}` : ""}`,
                externalRef: { provider: WEBHOOK_PROVIDER.PAYSTACK, id: opts.paystackReference },
                metadata: {
                    customerCode: opts.customerCode,
                    dvaAccountNumber: opts.dvaAccountNumber,
                    webhookData: opts.webhookData,
                    note: opts.note,
                },
            });

            try {
                await auditLogService.logAction(
                    undefined,
                    undefined,
                    "funding_suspense_held",
                    undefined,
                    { amount: opts.amount, paystackReference: opts.paystackReference },
                    undefined,
                    undefined,
                    { customerCode: opts.customerCode, dvaAccountNumber: opts.dvaAccountNumber, note: opts.note }
                );
            } catch (auditError) {
                logger.warn("Audit log write failed (funding_suspense_held)", {
                    paystackReference: opts.paystackReference,
                    error: auditError instanceof Error ? auditError.message : String(auditError),
                });
            }
        } catch (error) {
            logger.error("Failed to record suspense funding entry", {
                paystackReference: opts.paystackReference,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    // ===================== WITHDRAWAL =====================

    /** Initiate a withdrawal from the NGN wallet */
    async initiateWithdrawal(
        userId: string,
        amount: number,
        bankCode: string,
        accountNumber: string,
        accountName: string,
        pin: string
    ): Promise<WalletTransaction> {
        await this.verifyPin(userId, pin);

        if (amount < WALLET_LIMITS.MIN_WITHDRAWAL) {
            throw errorResponseMessage.createError(400, `Minimum withdrawal is ₦${WALLET_LIMITS.MIN_WITHDRAWAL.toLocaleString()}`, ErrorSeverity.MEDIUM);
        }
        if (amount > WALLET_LIMITS.MAX_WITHDRAWAL) {
            throw errorResponseMessage.createError(400, `Maximum withdrawal is ₦${WALLET_LIMITS.MAX_WITHDRAWAL.toLocaleString()}`, ErrorSeverity.MEDIUM);
        }

        const dailyTotal = await this.walletTransactionService.getDailyWithdrawalTotal(userId);
        if (dailyTotal + amount > WALLET_LIMITS.DAILY_WITHDRAWAL_LIMIT) {
            throw errorResponseMessage.createError(
                400,
                `Daily withdrawal limit of ₦${WALLET_LIMITS.DAILY_WITHDRAWAL_LIMIT.toLocaleString()} would be exceeded.`,
                ErrorSeverity.MEDIUM
            );
        }

        const wallet = await this.findBaseWallet(userId);
        if (!wallet) throw errorResponseMessage.resourceNotFound("Wallet");

        if (wallet.status !== WALLET_STATUS.ACTIVE) {
            throw errorResponseMessage.createError(400, "Wallet is not active", ErrorSeverity.HIGH);
        }
        if (wallet.balance < amount) {
            throw errorResponseMessage.createError(400, "Insufficient wallet balance", ErrorSeverity.MEDIUM);
        }

        await this.ensureUserLedgerAccount(userId, wallet);

        const reference = this.walletTransactionService.generateReference("WDR");
        const userAccountCode = userWalletAccountCode(userId, wallet.currency);

        // Debit + journal + record commit together; Paystack is called after
        const { walletTransaction, initTxGroupId } = await withTransaction(async (tx) => {
            const updated = await walletRepository.debit(wallet.id, amount, tx);
            if (!updated) {
                throw errorResponseMessage.createError(400, "Insufficient balance or wallet unavailable", ErrorSeverity.HIGH);
            }

            // The user's wallet liability decreases; the money sits in flight until Paystack settles.
            const post = await ledgerService.post({
                legs: [
                    { accountCode: userAccountCode, direction: JOURNAL_DIRECTION.DEBIT, amount },
                    { accountCode: SYSTEM_ACCOUNT_CODES.PAYSTACK_TRANSFER_INFLIGHT_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount },
                ],
                source: JOURNAL_SOURCE.WITHDRAWAL,
                reference,
                description: `Withdrawal initiated to ${accountName} (${accountNumber})`,
                metadata: { bankCode, accountNumber },
                tx,
            });

            const created = await walletTransactionRepository.create(
                {
                    wallet: wallet.id,
                    user: userId,
                    type: WALLET_TRANSACTION_TYPE.WITHDRAWAL,
                    status: WALLET_TRANSACTION_STATUS.PENDING,
                    amount,
                    reference,
                    balanceBefore: round2(updated.balance + amount),
                    balanceAfter: updated.balance,
                    description: `Withdrawal to ${accountName} (${accountNumber})`,
                    currency: wallet.currency,
                    paystackReference: reference,
                    recipientBankCode: bankCode,
                    recipientAccountNumber: accountNumber,
                    recipientAccountName: accountName,
                },
                tx
            );
            return { walletTransaction: created, initTxGroupId: post.txGroupId };
        });

        // Paystack is called OUTSIDE the transaction — the balance is already debited.
        // If it fails, the debit is reversed and the record marked failed.
        try {
            const createRecipient = (bank_code: string) =>
                paystackService.createTransferRecipient({ name: accountName, account_number: accountNumber, bank_code });

            // Use the bank the account was resolved against. Only if Paystack's
            // Test Bank (001) is refused in test mode, retry with Zenith (057).
            let recipient;
            try {
                recipient = await createRecipient(bankCode);
            } catch (recipientError) {
                if (bankCode !== "001" || !config.PAYSTACK_SECRET_KEY?.startsWith("sk_test_")) throw recipientError;
                logger.warn("Paystack: Test Bank recipient refused, retrying with 057", {
                    reference,
                    error: (recipientError as any)?.response?.data || (recipientError as any)?.message,
                });
                recipient = await createRecipient("057");
            }

            const transfer = await paystackService.initiateTransfer({
                amount: Math.round(amount * 100), // kobo
                recipient: recipient.recipient_code,
                reason: `Wallet withdrawal - ${reference}`,
                reference,
            });

            await walletTransactionRepository.update(walletTransaction.id, {
                status: WALLET_TRANSACTION_STATUS.PROCESSING,
                paystackTransferCode: transfer.transfer_code,
                paystackRecipientCode: recipient.recipient_code,
            });
        } catch (paystackError: any) {
            logger.error("Paystack transfer failed, reversing balance", {
                reference,
                error: paystackError?.response?.data || paystackError?.message,
            });

            try {
                await withTransaction(async (tx) => {
                    await walletRepository.credit(wallet.id, amount, tx);
                    await ledgerService.post({
                        legs: [
                            { accountCode: SYSTEM_ACCOUNT_CODES.PAYSTACK_TRANSFER_INFLIGHT_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount },
                            { accountCode: userAccountCode, direction: JOURNAL_DIRECTION.CREDIT, amount },
                        ],
                        source: JOURNAL_SOURCE.REVERSAL,
                        reference,
                        description: `Reversal — Paystack transfer initiation failed`,
                        metadata: { reverses: initTxGroupId },
                        tx,
                    });
                    await walletTransactionRepository.update(
                        walletTransaction.id,
                        {
                            status: WALLET_TRANSACTION_STATUS.FAILED,
                            failureReason: withoutProviderName(paystackError?.response?.data?.message, "Transfer initiation failed"),
                        },
                        tx
                    );
                });
            } catch (reverseError) {
                logger.error("Reversal of failed Paystack initiation also failed", { reference, error: (reverseError as any)?.message });
                throw reverseError;
            }

            const providerMessage: string = paystackError?.response?.data?.message || "";
            if (/resolve account|invalid account|account number/i.test(providerMessage)) {
                throw errorResponseMessage.createError(
                    400,
                    "The bank couldn't confirm this account. Check the account number and bank, then try again. Your balance has not been charged.",
                    ErrorSeverity.MEDIUM
                );
            }
            throw errorResponseMessage.createError(500, providerMessage || "Failed to initiate transfer with payment provider", ErrorSeverity.HIGH);
        }

        logger.info("Withdrawal initiated", { walletId: wallet.id, amount, reference });

        try {
            await auditLogService.logAction(
                undefined,
                userId,
                "withdrawal_initiated",
                undefined,
                { amount, reference, accountNumber, bankCode },
                undefined,
                undefined,
                { walletId: wallet.id }
            );
        } catch (auditError) {
            logger.warn("Audit log write failed (withdrawal_initiated)", {
                reference,
                error: auditError instanceof Error ? auditError.message : String(auditError),
            });
        }

        return walletTransaction;
    }

    /**
     * Process successful withdrawal (from Paystack webhook: transfer.success).
     * Settles the in-flight balance against Paystack cash. Idempotent: the
     * wallet transaction is claimed in the same database transaction, so a
     * webhook and a status poll can't both settle it.
     */
    async processWithdrawalSuccess(transferCode: string, reference: string): Promise<void> {
        const walletTx = await walletTransactionRepository.findByTransferCodeOrReference(transferCode, reference);

        if (!walletTx) {
            logger.warn("Withdrawal success webhook: transaction not found", { transferCode, reference });
            return;
        }
        if (walletTx.status === WALLET_TRANSACTION_STATUS.SUCCESSFUL) {
            logger.info("Withdrawal already marked successful (idempotent)", { reference });
            return;
        }

        try {
            const settled = await withTransaction(async (tx) => {
                const claimed = await walletTransactionRepository.claim(
                    walletTx.id,
                    [WALLET_TRANSACTION_STATUS.SUCCESSFUL as "successful"],
                    { status: WALLET_TRANSACTION_STATUS.SUCCESSFUL as "successful" },
                    tx
                );
                if (!claimed) return false;

                // Both are assets: in-flight goes down, cash at Paystack goes down (money left Paystack).
                await ledgerService.post({
                    legs: [
                        { accountCode: SYSTEM_ACCOUNT_CODES.PAYSTACK_TRANSFER_INFLIGHT_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: claimed.amount },
                        { accountCode: SYSTEM_ACCOUNT_CODES.CASH_PAYSTACK_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: claimed.amount },
                    ],
                    source: JOURNAL_SOURCE.WITHDRAWAL,
                    reference: claimed.reference,
                    description: `Withdrawal settled at Paystack (${reference})`,
                    externalRef: { provider: WEBHOOK_PROVIDER.PAYSTACK, id: transferCode || reference },
                    tx,
                });

                // The balance was debited at initiation; the ledger balance follows on settlement
                await walletRepository.adjustLedgerBalance(claimed.wallet, -claimed.amount, tx);
                return true;
            });

            if (!settled) {
                logger.info("Withdrawal already marked successful (idempotent)", { reference });
                return;
            }
            logger.info("Withdrawal completed successfully", { reference, amount: walletTx.amount });
        } catch (error) {
            logger.error("Withdrawal success processing failed", { reference, error: (error as any)?.message });
            throw error;
        }

        try {
            await auditLogService.logAction(
                undefined,
                walletTx.user,
                "withdrawal_settled",
                undefined,
                { amount: walletTx.amount, reference, transferCode },
                undefined,
                undefined,
                { walletTransactionId: walletTx.id }
            );
        } catch (auditError) {
            logger.warn("Audit log write failed (withdrawal_settled)", {
                reference,
                error: auditError instanceof Error ? auditError.message : String(auditError),
            });
        }
    }

    /**
     * Process failed withdrawal (Paystack webhook: transfer.failed / transfer.reversed).
     * Reverses the balance debit. Idempotent in the same way as success.
     */
    async processWithdrawalFailure(transferCode: string, reference: string, reason?: string): Promise<void> {
        const walletTx = await walletTransactionRepository.findByTransferCodeOrReference(transferCode, reference);

        if (!walletTx) {
            logger.warn("Withdrawal failure webhook: transaction not found", { transferCode, reference });
            return;
        }
        if (walletTx.status === WALLET_TRANSACTION_STATUS.FAILED || walletTx.status === WALLET_TRANSACTION_STATUS.REVERSED) {
            logger.info("Withdrawal already marked failed/reversed (idempotent)", { reference });
            return;
        }

        const reversalRef = this.walletTransactionService.generateReference("REV");
        let reversed: boolean;
        try {
            reversed = await withTransaction(async (tx) => {
                const claimed = await walletTransactionRepository.claim(
                    walletTx.id,
                    [WALLET_TRANSACTION_STATUS.FAILED as "failed", WALLET_TRANSACTION_STATUS.REVERSED as "reversed"],
                    { status: WALLET_TRANSACTION_STATUS.FAILED as "failed", failureReason: withoutProviderName(reason, "Transfer failed") },
                    tx
                );
                if (!claimed) return false;

                const wallet = await walletRepository.credit(claimed.wallet, claimed.amount, tx);
                if (!wallet) {
                    throw errorResponseMessage.createError(500, "Wallet not found for reversal", ErrorSeverity.CRITICAL);
                }

                await ledgerService.post({
                    legs: [
                        { accountCode: SYSTEM_ACCOUNT_CODES.PAYSTACK_TRANSFER_INFLIGHT_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: claimed.amount },
                        { accountCode: userWalletAccountCode(claimed.user, wallet.currency), direction: JOURNAL_DIRECTION.CREDIT, amount: claimed.amount },
                    ],
                    source: JOURNAL_SOURCE.REVERSAL,
                    reference: claimed.reference,
                    description: `Reversal — withdrawal ${claimed.reference} failed (${reason || "no reason given"})`,
                    externalRef: { provider: WEBHOOK_PROVIDER.PAYSTACK, id: transferCode || claimed.reference },
                    metadata: { reverses: claimed.reference, reason },
                    tx,
                });

                await walletTransactionRepository.create(
                    {
                        wallet: claimed.wallet,
                        user: claimed.user,
                        type: WALLET_TRANSACTION_TYPE.REVERSAL,
                        status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                        amount: claimed.amount,
                        reference: reversalRef,
                        balanceBefore: round2(wallet.balance - claimed.amount),
                        balanceAfter: wallet.balance,
                        description: `Reversal of failed withdrawal (${claimed.reference})`,
                        currency: wallet.currency,
                        reversedTransactionId: claimed.id,
                    },
                    tx
                );
                return true;
            });
        } catch (error) {
            logger.error("Withdrawal reversal failed", { reference, error: (error as any)?.message });
            throw error;
        }

        if (!reversed) {
            logger.info("Withdrawal already marked failed/reversed (idempotent)", { reference });
            return;
        }
        logger.info("Withdrawal reversed", { originalRef: reference, reversalRef, amount: walletTx.amount });

        try {
            await auditLogService.logAction(
                undefined,
                walletTx.user,
                "withdrawal_reversed",
                undefined,
                { amount: walletTx.amount, originalRef: reference, reversalRef, reason },
                undefined,
                undefined,
                { walletTransactionId: walletTx.id }
            );
        } catch (auditError) {
            logger.warn("Audit log write failed (withdrawal_reversed)", {
                reference,
                error: auditError instanceof Error ? auditError.message : String(auditError),
            });
        }
    }

    // ===================== TRANSFER VERIFICATION (Polling fallback) =====================

    /**
     * Verify a processing withdrawal directly with Paystack — the fallback for
     * when webhooks don't arrive. Called by the frontend and the sweeper.
     */
    async verifyAndUpdateTransfer(userId: string, transactionId: string): Promise<any> {
        const walletTx = await walletTransactionRepository.findOwned(transactionId, userId, WALLET_TRANSACTION_TYPE.WITHDRAWAL as "withdrawal");

        if (!walletTx) {
            throw errorResponseMessage.resourceNotFound("Transaction");
        }

        if (
            walletTx.status === WALLET_TRANSACTION_STATUS.SUCCESSFUL ||
            walletTx.status === WALLET_TRANSACTION_STATUS.FAILED ||
            walletTx.status === WALLET_TRANSACTION_STATUS.REVERSED
        ) {
            return { transaction: walletTx, message: `Transaction already ${walletTx.status}` };
        }

        // No transfer code: the Paystack call never succeeded — mark as failed and refund
        if (!walletTx.paystackTransferCode) {
            logger.warn("Transfer verification: no transfer code, marking as failed", { transactionId });
            await this.processWithdrawalFailure("", walletTx.reference, "Transfer was never initiated with payment provider");
            const updated = await walletTransactionRepository.findById(transactionId);
            return { transaction: updated, message: "Transfer failed — balance has been refunded" };
        }

        try {
            const transfer = await paystackService.verifyTransfer(walletTx.paystackTransferCode);
            logger.info("Transfer verification result", { reference: walletTx.reference, paystackStatus: transfer.status });

            if (transfer.status === "success") {
                await this.processWithdrawalSuccess(walletTx.paystackTransferCode, walletTx.reference);
                const updated = await walletTransactionRepository.findById(transactionId);
                return { transaction: updated, message: "Withdrawal completed successfully" };
            } else if (transfer.status === "failed" || transfer.status === "reversed") {
                await this.processWithdrawalFailure(walletTx.paystackTransferCode, walletTx.reference, transfer.reason || `Transfer ${transfer.status}`);
                const updated = await walletTransactionRepository.findById(transactionId);
                return { transaction: updated, message: `Transfer ${transfer.status} — balance has been refunded` };
            }
            return { transaction: walletTx, message: `Transfer is still ${transfer.status} on payment provider` };
        } catch (error: any) {
            logger.error("Transfer verification API call failed", {
                transactionId,
                error: error?.response?.data || error?.message,
            });
            throw errorResponseMessage.createError(
                500,
                "Unable to verify transfer status with payment provider. Please try again later.",
                ErrorSeverity.MEDIUM
            );
        }
    }

    // ===================== WALLET DEBIT/CREDIT (for other services) =====================

    /**
     * Atomically debit an active wallet. Returns the updated wallet.
     * Throws if the balance is insufficient or the wallet is unavailable.
     */
    async debitBalance(walletId: string, amount: number, tx?: Executor): Promise<Wallet> {
        const updated = await walletRepository.debit(walletId, amount, tx);
        if (!updated) {
            throw errorResponseMessage.createError(400, "Insufficient wallet balance or wallet unavailable", ErrorSeverity.HIGH);
        }
        return updated;
    }

    /** Credit a wallet (e.g. a refund), optionally inside the caller's transaction */
    async creditBalance(walletId: string, amount: number, tx?: Executor): Promise<Wallet | undefined> {
        return walletRepository.credit(walletId, amount, tx);
    }

    /** Move the ledger balance after a confirmed settlement */
    async adjustLedgerBalance(walletId: string, amount: number, tx?: Executor): Promise<Wallet | undefined> {
        return walletRepository.adjustLedgerBalance(walletId, amount, tx);
    }

    // ===================== QUERIES =====================

    async getWalletBalance(userId: string) {
        const wallet = await this.getOrCreateWallet(userId);
        return {
            balance: wallet.balance,
            ledgerBalance: wallet.ledgerBalance,
            currency: wallet.currency,
            status: wallet.status,
        };
    }

    /** Paginated wallet transaction history, newest first */
    async getTransactionHistory(userId: string, options: { page: number; limit: number; type?: string; currency?: string }) {
        let wallet: string | null | undefined;
        if (options.currency) {
            const found = await walletRepository.findByUserAndCurrency(userId, options.currency.toUpperCase());
            // An unopened wallet has no history
            wallet = found?.id ?? null;
        }
        const request: PageRequest = { page: options.page, limit: options.limit };
        return walletTransactionRepository.paginateForUser({ user: userId, type: options.type, wallet }, request);
    }

    /** List Nigerian banks (proxied from Paystack) */
    async listBanks() {
        const banks = await paystackService.listBanks("NGN");

        // In test mode, Paystack's bank list doesn't include the test bank
        // but it's required for test transfers — inject it at the top
        const isTestMode = config.PAYSTACK_SECRET_KEY?.startsWith("sk_test_");
        if (isTestMode) {
            const hasTestBank = banks.some((b: any) => b.code === "001");
            if (!hasTestBank) {
                banks.unshift({
                    id: 0,
                    name: "Test Bank",
                    slug: "test-bank",
                    code: "001",
                    active: true,
                    country: "Nigeria",
                    currency: "NGN",
                    type: "nuban",
                });
            }
        }

        return banks;
    }

    /** Resolve a bank account number */
    async resolveAccount(accountNumber: string, bankCode: string) {
        return paystackService.resolveAccountNumber(accountNumber, bankCode);
    }
}

export default WalletService;
