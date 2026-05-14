import DBService from "../utils/db.utils";
import { IWallet, IWalletTransaction, IUser } from "../models/interface";
import Wallet from "../models/wallet.model";
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
import config from "../config/env.config";
import mongoose from "mongoose";
import logger from "../utils/logger.utils";
import PinService from "./pin.service";
import User from "../models/user.model";
import Account from "../models/account.model";
import ledgerService from "./ledger.service";
import AuditLogService from "./audit-log.service";

const auditLogService = new AuditLogService();

class WalletService extends DBService<IWallet> {
    private walletTransactionService: WalletTransactionService;
    private pinService: PinService;

    constructor(populatePaths: string[] = []) {
        super(Wallet, populatePaths);
        this.walletTransactionService = new WalletTransactionService();
        this.pinService = new PinService();
    }

    // ===================== WALLET MANAGEMENT =====================

    /**
     * Get or create a wallet for a user. Also ensures the user's per-currency
     * ledger account (USER_WALLET_NGN:{userId}) exists so subsequent journal
     * postings have a target account ready.
     */
    async getOrCreateWallet(userId: string): Promise<IWallet> {
        let wallet = await this.findOne({ user: userId });
        if (!wallet) {
            wallet = await this.save({
                user: userId,
                currency: WALLET_LIMITS.CURRENCY,
                balance: 0,
                ledgerBalance: 0,
                status: WALLET_STATUS.ACTIVE,
                isPinSet: false,
                isDVAProvisioned: false,
                pinAttempts: 0,
            });
        }
        await this.ensureUserLedgerAccount(userId, wallet);
        return wallet;
    }

    /**
     * Idempotently create the user's per-currency ledger liability account.
     * Called from getOrCreateWallet so any path that touches a wallet has the
     * matching ledger account in place.
     */
    private async ensureUserLedgerAccount(userId: string, wallet: IWallet): Promise<void> {
        const code = userWalletAccountCode(userId, wallet.currency);
        const existing = await Account.findOne({ code });
        if (existing) return;

        await Account.create({
            code,
            type: ACCOUNT_TYPE.LIABILITY,
            currency: wallet.currency,
            name: `User wallet — ${userId}`,
            ownerUser: userId,
            ownerWallet: wallet._id,
            balance: 0,
            isSystem: false,
        });
    }

    /**
     * Provision a Paystack DVA for a wallet (lazy — called on first access)
     */
    async provisionDVA(walletId: string, user: IUser): Promise<IWallet> {
        const wallet = await this.findById(walletId);
        if (!wallet) throw errorResponseMessage.resourceNotFound("Wallet");

        if (wallet.isDVAProvisioned) return wallet;

        // Create Paystack customer
        const customer = await paystackService.createCustomer({
            email: user.email,
            first_name: user.firstName,
            last_name: user.lastName,
            phone: user.phoneNumber,
        });

        // Create DVA
        const dva = await paystackService.createDedicatedAccount(customer.customer_code);

        const updated = await this.updateById(walletId, {
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
    // The PIN is now stored on the User document and managed by PinService.
    // These methods preserve the old wallet-scoped API so wallet.controller.ts
    // and initiateWithdrawal continue to work unchanged. They also perform a
    // one-time lazy migration of any pre-existing wallet pinHash into the user.

    /**
     * Set the user's transaction PIN (first time).
     */
    async setPin(userId: string, pin: string): Promise<void> {
        await this.pinService.setPin(userId, pin);
    }

    /**
     * Change the user's transaction PIN.
     */
    async changePin(userId: string, oldPin: string, newPin: string): Promise<void> {
        await this.migrateWalletPinToUserIfNeeded(userId);
        await this.pinService.changePin(userId, oldPin, newPin);
    }

    /**
     * Verify the user's transaction PIN, with lockout enforcement.
     * Lazily migrates an old wallet-scoped pinHash to the user document on first call.
     */
    async verifyPin(userId: string, pin: string): Promise<void> {
        await this.migrateWalletPinToUserIfNeeded(userId);
        await this.pinService.verifyPin(userId, pin);
    }

    /**
     * One-time migration: copy a pre-existing wallet.pinHash onto the user
     * document so subsequent verifications go through PinService. Safe to call
     * repeatedly — it no-ops once the user already has a PIN.
     */
    private async migrateWalletPinToUserIfNeeded(userId: string): Promise<void> {
        const user = await User.findById(userId).select('+transactionPinHash');
        if (!user || user.isTransactionPinSet) return;

        const wallet = await this.Model.findOne({ user: userId }).select('+pinHash');
        if (!wallet || !wallet.isPinSet || !wallet.pinHash) return;

        await User.updateOne(
            { _id: userId },
            {
                transactionPinHash: wallet.pinHash,
                isTransactionPinSet: true,
                transactionPinAttempts: wallet.pinAttempts || 0,
                ...(wallet.pinLockedUntil ? { transactionPinLockedUntil: wallet.pinLockedUntil } : {}),
            }
        );

        logger.info("Migrated wallet PIN to user document", { userId, walletId: wallet._id });
    }

    // ===================== FUNDING (Webhook-driven) =====================

    /**
     * Process wallet funding from Paystack webhook (charge.success)
     * Uses atomic $inc to prevent race conditions
     */
    async processFunding(
        paystackReference: string,
        amountInKobo: number,
        webhookData?: any
    ): Promise<IWalletTransaction | null> {
        const amount = Math.round(amountInKobo) / 100; // Convert kobo to NGN, ensure integer

        // Idempotency: check if already processed
        const existing = await this.walletTransactionService.findOne({ paystackReference });
        if (existing) {
            logger.info("Wallet funding already processed (idempotent)", { paystackReference });
            return null;
        }

        // Extract customer code from Paystack charge.success payload
        // Paystack sends: data.customer.customer_code and data.authorization.receiver_bank_account_number
        const customerCode = webhookData?.customer?.customer_code;
        const dvaAccountNumber = webhookData?.authorization?.receiver_bank_account_number;

        logger.info("Processing funding", { paystackReference, customerCode, dvaAccountNumber, amount });

        // Try to find wallet by customer code first, then by DVA account number
        let wallet = customerCode
            ? await this.findOne({ paystackCustomerCode: customerCode })
            : null;

        if (!wallet && dvaAccountNumber) {
            wallet = await this.findOne({ dvaAccountNumber });
        }

        // No matching wallet — instead of silently dropping the money, post a
        // suspense entry so the funds are captured in the ledger and can be
        // attributed manually by an admin later.
        if (!wallet) {
            logger.error("Wallet not found for funding — routing to SUSPENSE", { paystackReference, customerCode, dvaAccountNumber });
            await this.recordSuspenseFunding({
                paystackReference,
                amount,
                customerCode,
                dvaAccountNumber,
                webhookData,
            });
            return null;
        }

        if (wallet.status !== WALLET_STATUS.ACTIVE) {
            logger.warn("Funding attempted on non-active wallet — routing to SUSPENSE", { walletId: wallet._id, status: wallet.status });
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

        // Make sure the user's ledger account exists before we try to credit it.
        await this.ensureUserLedgerAccount(wallet.user as string, wallet);

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const reference = this.walletTransactionService.generateReference('FND');
            const balanceBefore = wallet.balance;
            const balanceAfter = balanceBefore + amount;

            // Post the journal entry first — it's our source of truth.
            // Money entered the platform via Paystack (CASH_PAYSTACK_NGN) and
            // we now owe the user (USER_WALLET_NGN:{userId}).
            const userAccountCode = userWalletAccountCode(wallet.user as string, wallet.currency);
            await ledgerService.post({
                legs: [
                    { accountCode: SYSTEM_ACCOUNT_CODES.CASH_PAYSTACK_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount },
                    { accountCode: userAccountCode, direction: JOURNAL_DIRECTION.CREDIT, amount },
                ],
                source: JOURNAL_SOURCE.FUNDING,
                reference,
                description: `Wallet funding via Paystack DVA (${paystackReference})`,
                externalRef: { provider: WEBHOOK_PROVIDER.PAYSTACK, id: paystackReference },
                metadata: { customerCode, dvaAccountNumber },
                session,
            });

            // Update the cached wallet.balance projection in the same session.
            const updatedWallet = await this.Model.findOneAndUpdate(
                { _id: wallet._id, status: WALLET_STATUS.ACTIVE },
                { $inc: { balance: amount, ledgerBalance: amount } },
                { new: true, session }
            );

            if (!updatedWallet) {
                throw errorResponseMessage.createError(500, "Failed to update wallet balance", ErrorSeverity.CRITICAL);
            }

            // Create transaction record
            const walletTransaction = await this.walletTransactionService.create({
                wallet: wallet._id,
                user: wallet.user,
                type: WALLET_TRANSACTION_TYPE.FUNDING,
                status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                amount,
                reference,
                balanceBefore,
                balanceAfter,
                description: `Wallet funding via bank transfer`,
                paystackReference,
            }, session);

            await session.commitTransaction();
            logger.info("Wallet funded successfully", { walletId: wallet._id, amount, reference });

            // Audit-log the funding event for compliance / replay traceability.
            // Best-effort: a logging failure does NOT block the funding result.
            try {
                await auditLogService.logAction(
                    undefined,
                    wallet.user as string,
                    'funding_received',
                    undefined,
                    { amount, reference, paystackReference },
                    undefined,
                    undefined,
                    { customerCode, dvaAccountNumber, walletId: wallet._id }
                );
            } catch (auditError) {
                logger.warn('Audit log write failed (funding_received)', {
                    paystackReference,
                    error: auditError instanceof Error ? auditError.message : String(auditError),
                });
            }

            return walletTransaction;
        } catch (error) {
            await session.abortTransaction();
            logger.error("Wallet funding failed", { paystackReference, error });
            throw error;
        } finally {
            session.endSession();
        }
    }

    /**
     * Capture an unmatched funding event in the SUSPENSE ledger so the funds
     * are tracked. Idempotent on paystackReference: if a journal entry for the
     * same Paystack reference already exists, this is a no-op.
     *
     * Posted on its own session — the calling webhook flow has already
     * decided we cannot credit a user, so atomicity here is just about
     * keeping the SUSPENSE entry consistent with CASH_PAYSTACK_NGN.
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
                description: `Unmatched Paystack funding held in suspense${opts.note ? ` — ${opts.note}` : ''}`,
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
                    'funding_suspense_held',
                    undefined,
                    { amount: opts.amount, paystackReference: opts.paystackReference },
                    undefined,
                    undefined,
                    {
                        customerCode: opts.customerCode,
                        dvaAccountNumber: opts.dvaAccountNumber,
                        note: opts.note,
                    }
                );
            } catch (auditError) {
                logger.warn('Audit log write failed (funding_suspense_held)', {
                    paystackReference: opts.paystackReference,
                    error: auditError instanceof Error ? auditError.message : String(auditError),
                });
            }
        } catch (error) {
            logger.error('Failed to record suspense funding entry', {
                paystackReference: opts.paystackReference,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    // ===================== WITHDRAWAL =====================

    /**
     * Initiate a withdrawal from the wallet
     */
    async initiateWithdrawal(
        userId: string,
        amount: number,
        bankCode: string,
        accountNumber: string,
        accountName: string,
        pin: string
    ): Promise<IWalletTransaction> {
        // 1. Verify PIN
        await this.verifyPin(userId, pin);

        // 2. Validate amount
        if (amount < WALLET_LIMITS.MIN_WITHDRAWAL) {
            throw errorResponseMessage.createError(400, `Minimum withdrawal is ₦${WALLET_LIMITS.MIN_WITHDRAWAL.toLocaleString()}`, ErrorSeverity.MEDIUM);
        }
        if (amount > WALLET_LIMITS.MAX_WITHDRAWAL) {
            throw errorResponseMessage.createError(400, `Maximum withdrawal is ₦${WALLET_LIMITS.MAX_WITHDRAWAL.toLocaleString()}`, ErrorSeverity.MEDIUM);
        }

        // 3. Check daily limit
        const dailyTotal = await this.walletTransactionService.getDailyWithdrawalTotal(userId);
        if (dailyTotal + amount > WALLET_LIMITS.DAILY_WITHDRAWAL_LIMIT) {
            throw errorResponseMessage.createError(
                400,
                `Daily withdrawal limit of ₦${WALLET_LIMITS.DAILY_WITHDRAWAL_LIMIT.toLocaleString()} would be exceeded.`,
                ErrorSeverity.MEDIUM
            );
        }

        const wallet = await this.findOne({ user: userId });
        if (!wallet) throw errorResponseMessage.resourceNotFound("Wallet");

        if (wallet.status !== WALLET_STATUS.ACTIVE) {
            throw errorResponseMessage.createError(400, "Wallet is not active", ErrorSeverity.HIGH);
        }

        // 4. Check sufficient balance
        if (wallet.balance < amount) {
            throw errorResponseMessage.createError(400, "Insufficient wallet balance", ErrorSeverity.MEDIUM);
        }

        // Make sure the user's ledger account exists before posting against it.
        await this.ensureUserLedgerAccount(userId, wallet);

        const session = await mongoose.startSession();
        session.startTransaction();

        let initTxGroupId: string | undefined;
        try {
            const reference = this.walletTransactionService.generateReference('WDR');
            const balanceBefore = wallet.balance;
            const balanceAfter = balanceBefore - amount;
            const userAccountCode = userWalletAccountCode(userId, wallet.currency);

            // 5. Atomic balance debit
            const updatedWallet = await this.Model.findOneAndUpdate(
                { _id: wallet._id, status: WALLET_STATUS.ACTIVE, balance: { $gte: amount } },
                { $inc: { balance: -amount } },
                { new: true, session }
            );

            if (!updatedWallet) {
                throw errorResponseMessage.createError(400, "Insufficient balance or wallet unavailable", ErrorSeverity.HIGH);
            }

            // Post journal: user's wallet liability decreases (debit), money is now
            // sitting in the in-flight asset awaiting Paystack settlement.
            const post = await ledgerService.post({
                legs: [
                    { accountCode: userAccountCode, direction: JOURNAL_DIRECTION.DEBIT, amount },
                    { accountCode: SYSTEM_ACCOUNT_CODES.PAYSTACK_TRANSFER_INFLIGHT_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount },
                ],
                source: JOURNAL_SOURCE.WITHDRAWAL,
                reference,
                description: `Withdrawal initiated to ${accountName} (${accountNumber})`,
                metadata: { bankCode, accountNumber },
                session,
            });
            initTxGroupId = post.txGroupId;

            // 6. Create wallet transaction record FIRST (so we have a record even if Paystack fails)
            const walletTransaction = await this.walletTransactionService.create({
                wallet: wallet._id,
                user: userId,
                type: WALLET_TRANSACTION_TYPE.WITHDRAWAL,
                status: WALLET_TRANSACTION_STATUS.PENDING,
                amount,
                reference,
                balanceBefore,
                balanceAfter,
                description: `Withdrawal to ${accountName} (${accountNumber})`,
                paystackReference: reference,
                recipientBankCode: bankCode,
                recipientAccountNumber: accountNumber,
                recipientAccountName: accountName,
            }, session);

            await session.commitTransaction();

            // 7. Now call Paystack OUTSIDE the session — balance is already debited
            // If Paystack fails, the transaction record exists with PENDING status for manual review
            try {
                // In test mode, Test Bank (001) can resolve accounts but can't create recipients
                // Map it to Zenith Bank (057) which supports both
                const transferBankCode = bankCode === "001" && config.PAYSTACK_SECRET_KEY?.startsWith("sk_test_")
                    ? "057"
                    : bankCode;

                const recipient = await paystackService.createTransferRecipient({
                    name: accountName,
                    account_number: accountNumber,
                    bank_code: transferBankCode,
                });

                const transfer = await paystackService.initiateTransfer({
                    amount: amount * 100, // kobo
                    recipient: recipient.recipient_code,
                    reason: `Wallet withdrawal - ${reference}`,
                    reference,
                });

                // Update transaction with Paystack codes
                await this.walletTransactionService.updateById(walletTransaction._id as string, {
                    status: WALLET_TRANSACTION_STATUS.PROCESSING,
                    paystackTransferCode: transfer.transfer_code,
                    paystackRecipientCode: recipient.recipient_code,
                });
            } catch (paystackError: any) {
                // Paystack call failed — reverse the balance debit and mark transaction as failed
                logger.error("Paystack transfer failed, reversing balance", {
                    reference, error: paystackError?.response?.data || paystackError?.message,
                });

                // Reverse both the wallet projection and the journal posting in one session.
                const reverseSession = await mongoose.startSession();
                reverseSession.startTransaction();
                try {
                    await this.Model.findOneAndUpdate(
                        { _id: wallet._id },
                        { $inc: { balance: amount } },
                        { session: reverseSession }
                    );

                    await ledgerService.post({
                        legs: [
                            { accountCode: SYSTEM_ACCOUNT_CODES.PAYSTACK_TRANSFER_INFLIGHT_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount },
                            { accountCode: userAccountCode, direction: JOURNAL_DIRECTION.CREDIT, amount },
                        ],
                        source: JOURNAL_SOURCE.REVERSAL,
                        reference,
                        description: `Reversal — Paystack transfer initiation failed`,
                        metadata: { reverses: initTxGroupId },
                        session: reverseSession,
                    });

                    await this.walletTransactionService.updateById(walletTransaction._id as string, {
                        status: WALLET_TRANSACTION_STATUS.FAILED,
                        failureReason: paystackError?.response?.data?.message || paystackError?.message || "Transfer initiation failed",
                    });

                    await reverseSession.commitTransaction();
                } catch (reverseError) {
                    if (reverseSession.inTransaction()) await reverseSession.abortTransaction();
                    logger.error('Reversal of failed Paystack initiation also failed', { reference, error: reverseError });
                    throw reverseError;
                } finally {
                    reverseSession.endSession();
                }

                throw errorResponseMessage.createError(
                    500,
                    paystackError?.response?.data?.message || "Failed to initiate transfer with payment provider",
                    ErrorSeverity.HIGH
                );
            }

            logger.info("Withdrawal initiated", { walletId: wallet._id, amount, reference });

            try {
                await auditLogService.logAction(
                    undefined,
                    userId,
                    'withdrawal_initiated',
                    undefined,
                    { amount, reference, accountNumber, bankCode },
                    undefined,
                    undefined,
                    { walletId: wallet._id }
                );
            } catch (auditError) {
                logger.warn('Audit log write failed (withdrawal_initiated)', {
                    reference,
                    error: auditError instanceof Error ? auditError.message : String(auditError),
                });
            }

            return walletTransaction;
        } catch (error: any) {
            // Only abort if the transaction hasn't been committed yet
            if (session.inTransaction()) {
                await session.abortTransaction();
            }
            logger.error("Withdrawal initiation failed", { userId, amount, error: error.message });
            throw error;
        } finally {
            session.endSession();
        }
    }

    /**
     * Process successful withdrawal (from Paystack webhook: transfer.success).
     * Posts the final journal entry settling the in-flight balance against the
     * Paystack cash balance (i.e. money has actually left Paystack).
     */
    async processWithdrawalSuccess(transferCode: string, reference: string): Promise<void> {
        const walletTx = await this.walletTransactionService.findOne({
            $or: [{ paystackTransferCode: transferCode }, { reference }]
        });

        if (!walletTx) {
            logger.warn("Withdrawal success webhook: transaction not found", { transferCode, reference });
            return;
        }

        if (walletTx.status === WALLET_TRANSACTION_STATUS.SUCCESSFUL) {
            logger.info("Withdrawal already marked successful (idempotent)", { reference });
            return;
        }

        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            // Settle: in-flight asset → cash at Paystack (both are assets, so a
            // debit on inflight reduces it and a credit on cash reduces it too,
            // i.e. cash leaves Paystack to the recipient).
            await ledgerService.post({
                legs: [
                    { accountCode: SYSTEM_ACCOUNT_CODES.PAYSTACK_TRANSFER_INFLIGHT_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: walletTx.amount },
                    { accountCode: SYSTEM_ACCOUNT_CODES.CASH_PAYSTACK_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: walletTx.amount },
                ],
                source: JOURNAL_SOURCE.WITHDRAWAL,
                reference: walletTx.reference,
                description: `Withdrawal settled at Paystack (${reference})`,
                externalRef: { provider: WEBHOOK_PROVIDER.PAYSTACK, id: transferCode || reference },
                session,
            });

            await this.walletTransactionService.updateById(walletTx._id as string, {
                status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
            });

            // Update ledger balance to match (balance was already debited at initiation)
            await this.Model.findOneAndUpdate(
                { _id: walletTx.wallet },
                { $inc: { ledgerBalance: -walletTx.amount } },
                { session }
            );

            await session.commitTransaction();
            logger.info("Withdrawal completed successfully", { reference, amount: walletTx.amount });

            try {
                await auditLogService.logAction(
                    undefined,
                    walletTx.user as string,
                    'withdrawal_settled',
                    undefined,
                    { amount: walletTx.amount, reference, transferCode },
                    undefined,
                    undefined,
                    { walletTransactionId: walletTx._id }
                );
            } catch (auditError) {
                logger.warn('Audit log write failed (withdrawal_settled)', {
                    reference,
                    error: auditError instanceof Error ? auditError.message : String(auditError),
                });
            }
        } catch (error) {
            if (session.inTransaction()) await session.abortTransaction();
            logger.error("Withdrawal success processing failed", { reference, error });
            throw error;
        } finally {
            session.endSession();
        }
    }

    /**
     * Process failed withdrawal (from Paystack webhook: transfer.failed / transfer.reversed)
     * Reverses the balance debit
     */
    async processWithdrawalFailure(transferCode: string, reference: string, reason?: string): Promise<void> {
        const walletTx = await this.walletTransactionService.findOne({
            $or: [{ paystackTransferCode: transferCode }, { reference }]
        });

        if (!walletTx) {
            logger.warn("Withdrawal failure webhook: transaction not found", { transferCode, reference });
            return;
        }

        if (walletTx.status === WALLET_TRANSACTION_STATUS.FAILED || walletTx.status === WALLET_TRANSACTION_STATUS.REVERSED) {
            logger.info("Withdrawal already marked failed/reversed (idempotent)", { reference });
            return;
        }

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            // Mark original transaction as failed
            await this.walletTransactionService.updateById(walletTx._id as string, {
                status: WALLET_TRANSACTION_STATUS.FAILED,
                failureReason: reason || "Transfer failed",
            });

            // Reverse the balance: credit back the debited amount
            const wallet = await this.Model.findOneAndUpdate(
                { _id: walletTx.wallet },
                { $inc: { balance: walletTx.amount } },
                { new: true, session }
            );

            if (!wallet) {
                throw errorResponseMessage.createError(500, "Wallet not found for reversal", ErrorSeverity.CRITICAL);
            }

            // Reverse the journal: in-flight asset → user wallet liability.
            const userAccountCode = userWalletAccountCode(walletTx.user as string, wallet.currency);
            await ledgerService.post({
                legs: [
                    { accountCode: SYSTEM_ACCOUNT_CODES.PAYSTACK_TRANSFER_INFLIGHT_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: walletTx.amount },
                    { accountCode: userAccountCode, direction: JOURNAL_DIRECTION.CREDIT, amount: walletTx.amount },
                ],
                source: JOURNAL_SOURCE.REVERSAL,
                reference: walletTx.reference,
                description: `Reversal — withdrawal ${walletTx.reference} failed (${reason || 'no reason given'})`,
                externalRef: { provider: WEBHOOK_PROVIDER.PAYSTACK, id: transferCode || walletTx.reference },
                metadata: { reverses: walletTx.reference, reason },
                session,
            });

            // Create reversal transaction record
            const reversalRef = this.walletTransactionService.generateReference('REV');
            await this.walletTransactionService.create({
                wallet: walletTx.wallet,
                user: walletTx.user,
                type: WALLET_TRANSACTION_TYPE.REVERSAL,
                status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                amount: walletTx.amount,
                reference: reversalRef,
                balanceBefore: wallet.balance - walletTx.amount,
                balanceAfter: wallet.balance,
                description: `Reversal of failed withdrawal (${walletTx.reference})`,
                reversedTransactionId: walletTx._id,
            }, session);

            await session.commitTransaction();
            logger.info("Withdrawal reversed", { originalRef: reference, reversalRef, amount: walletTx.amount });

            try {
                await auditLogService.logAction(
                    undefined,
                    walletTx.user as string,
                    'withdrawal_reversed',
                    undefined,
                    { amount: walletTx.amount, originalRef: reference, reversalRef, reason },
                    undefined,
                    undefined,
                    { walletTransactionId: walletTx._id }
                );
            } catch (auditError) {
                logger.warn('Audit log write failed (withdrawal_reversed)', {
                    reference,
                    error: auditError instanceof Error ? auditError.message : String(auditError),
                });
            }
        } catch (error) {
            await session.abortTransaction();
            logger.error("Withdrawal reversal failed", { reference, error });
            throw error;
        } finally {
            session.endSession();
        }
    }

    // ===================== TRANSFER VERIFICATION (Polling fallback) =====================

    /**
     * Verify a processing withdrawal directly with Paystack.
     * This is the fallback for when webhooks don't arrive.
     * Called by the frontend when a transaction is stuck in PROCESSING/PENDING.
     */
    async verifyAndUpdateTransfer(userId: string, transactionId: string): Promise<any> {
        const walletTx = await this.walletTransactionService.findOne({
            _id: transactionId,
            user: userId,
            type: WALLET_TRANSACTION_TYPE.WITHDRAWAL,
        });

        if (!walletTx) {
            throw errorResponseMessage.resourceNotFound("Transaction");
        }

        // Only verify transactions that are still pending/processing
        if (walletTx.status === WALLET_TRANSACTION_STATUS.SUCCESSFUL ||
            walletTx.status === WALLET_TRANSACTION_STATUS.FAILED ||
            walletTx.status === WALLET_TRANSACTION_STATUS.REVERSED) {
            return { transaction: walletTx, message: `Transaction already ${walletTx.status}` };
        }

        // If no transfer code, the Paystack call never succeeded — mark as failed and refund
        if (!walletTx.paystackTransferCode) {
            logger.warn("Transfer verification: no transfer code, marking as failed", { transactionId });
            await this.processWithdrawalFailure("", walletTx.reference, "Transfer was never initiated with payment provider");
            const updated = await this.walletTransactionService.findById(transactionId);
            return { transaction: updated, message: "Transfer failed — balance has been refunded" };
        }

        // Query Paystack for the current transfer status
        try {
            const transfer = await paystackService.verifyTransfer(walletTx.paystackTransferCode);
            logger.info("Transfer verification result", {
                reference: walletTx.reference,
                paystackStatus: transfer.status,
            });

            if (transfer.status === "success") {
                await this.processWithdrawalSuccess(walletTx.paystackTransferCode, walletTx.reference);
                const updated = await this.walletTransactionService.findById(transactionId);
                return { transaction: updated, message: "Withdrawal completed successfully" };
            } else if (transfer.status === "failed" || transfer.status === "reversed") {
                await this.processWithdrawalFailure(
                    walletTx.paystackTransferCode,
                    walletTx.reference,
                    transfer.reason || `Transfer ${transfer.status}`
                );
                const updated = await this.walletTransactionService.findById(transactionId);
                return { transaction: updated, message: `Transfer ${transfer.status} — balance has been refunded` };
            } else {
                // Still pending/processing on Paystack's end
                return { transaction: walletTx, message: `Transfer is still ${transfer.status} on payment provider` };
            }
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

    // ===================== WALLET DEBIT/CREDIT (for external services) =====================

    /**
     * Atomically debit wallet balance. Returns the updated wallet.
     * Throws if insufficient balance or wallet unavailable.
     */
    async debitBalance(walletId: string, amount: number, session?: mongoose.ClientSession) {
        const opts: any = { new: true };
        if (session) opts.session = session;

        const updated = await this.Model.findOneAndUpdate(
            { _id: walletId, status: WALLET_STATUS.ACTIVE, balance: { $gte: amount } },
            { $inc: { balance: -amount } },
            opts
        );

        if (!updated) {
            throw errorResponseMessage.createError(400, "Insufficient wallet balance or wallet unavailable", ErrorSeverity.HIGH);
        }
        return updated;
    }

    /**
     * Credit wallet balance (e.g. refund). Optionally participates in a session
     * so the credit can be coordinated atomically with a journal posting.
     */
    async creditBalance(walletId: string, amount: number, session?: mongoose.ClientSession) {
        const opts: any = { new: true };
        if (session) opts.session = session;
        return this.Model.findOneAndUpdate(
            { _id: walletId },
            { $inc: { balance: amount } },
            opts
        );
    }

    /**
     * Update ledger balance (after confirmed settlement). Optional session.
     */
    async adjustLedgerBalance(walletId: string, amount: number, session?: mongoose.ClientSession) {
        const opts: any = { new: true };
        if (session) opts.session = session;
        return this.Model.findOneAndUpdate(
            { _id: walletId },
            { $inc: { ledgerBalance: amount } },
            opts
        );
    }

    // ===================== QUERIES =====================

    /**
     * Get wallet balance
     */
    async getWalletBalance(userId: string) {
        const wallet = await this.getOrCreateWallet(userId);
        return {
            balance: wallet.balance,
            ledgerBalance: wallet.ledgerBalance,
            currency: wallet.currency,
            status: wallet.status,
        };
    }

    /**
     * Get paginated wallet transaction history
     */
    async getTransactionHistory(userId: string, options: { page: number; limit: number; type?: string }) {
        const query: any = { user: userId };
        if (options.type) query.type = options.type;

        return this.walletTransactionService.paginate(query, {
            page: options.page,
            limit: options.limit,
            sort: { createdAt: -1 },
        });
    }

    /**
     * List Nigerian banks (proxied from Paystack)
     */
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

    /**
     * Resolve a bank account number
     */
    async resolveAccount(accountNumber: string, bankCode: string) {
        return paystackService.resolveAccountNumber(accountNumber, bankCode);
    }
}

export default WalletService;
