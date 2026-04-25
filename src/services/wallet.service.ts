import DBService from "../utils/db.utils";
import { IWallet, IWalletTransaction, IUser } from "../models/interface";
import Wallet from "../models/wallet.model";
import WalletTransactionService from "./wallet-transaction.service";
import paystackService from "./paystack.service";
import HashService from "../utils/hash.utils";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import { WALLET_STATUS, WALLET_TRANSACTION_TYPE, WALLET_TRANSACTION_STATUS } from "../common/constant";
import { WALLET_LIMITS } from "../config/wallet-limits.config";
import config from "../config/env.config";
import mongoose from "mongoose";
import logger from "../utils/logger.utils";

class WalletService extends DBService<IWallet> {
    private walletTransactionService: WalletTransactionService;

    constructor(populatePaths: string[] = []) {
        super(Wallet, populatePaths);
        this.walletTransactionService = new WalletTransactionService();
    }

    // ===================== WALLET MANAGEMENT =====================

    /**
     * Get or create a wallet for a user
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
        return wallet;
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

    /**
     * Set wallet PIN (first time only)
     */
    async setPin(userId: string, pin: string): Promise<void> {
        const wallet = await this.findOne({ user: userId });
        if (!wallet) throw errorResponseMessage.resourceNotFound("Wallet");

        if (wallet.isPinSet) {
            throw errorResponseMessage.createError(400, "PIN is already set. Use change PIN instead.", ErrorSeverity.MEDIUM);
        }

        const { password: pinHash } = await HashService.hashPassword(pin);
        await this.updateById(wallet._id as string, {
            pinHash,
            isPinSet: true,
            pinAttempts: 0,
            pinLockedUntil: undefined,
        });
    }

    /**
     * Change wallet PIN
     */
    async changePin(userId: string, oldPin: string, newPin: string): Promise<void> {
        await this.verifyPin(userId, oldPin);

        const wallet = await this.Model.findOne({ user: userId }).select('+pinHash');
        if (!wallet) throw errorResponseMessage.resourceNotFound("Wallet");

        const { password: pinHash } = await HashService.hashPassword(newPin);
        await this.updateById(wallet._id as string, {
            pinHash,
            pinAttempts: 0,
            pinLockedUntil: undefined,
        });
    }

    /**
     * Verify wallet PIN with lockout protection
     */
    async verifyPin(userId: string, pin: string): Promise<void> {
        const wallet = await this.Model.findOne({ user: userId }).select('+pinHash');
        if (!wallet) throw errorResponseMessage.resourceNotFound("Wallet");

        if (!wallet.isPinSet || !wallet.pinHash) {
            throw errorResponseMessage.createError(400, "PIN has not been set yet.", ErrorSeverity.MEDIUM);
        }

        // Check lockout
        if (wallet.pinLockedUntil && wallet.pinLockedUntil.getTime() > Date.now()) {
            const remainingMinutes = Math.ceil((wallet.pinLockedUntil.getTime() - Date.now()) / 60000);
            throw errorResponseMessage.createError(
                429,
                `PIN is locked. Try again in ${remainingMinutes} minute(s).`,
                ErrorSeverity.HIGH
            );
        }

        const isValid = await HashService.verifyPassword(pin, wallet.pinHash);
        if (!isValid) {
            const attempts = (wallet.pinAttempts || 0) + 1;
            const updates: any = { pinAttempts: attempts };

            if (attempts >= WALLET_LIMITS.MAX_PIN_ATTEMPTS) {
                updates.pinLockedUntil = new Date(Date.now() + WALLET_LIMITS.PIN_LOCKOUT_MINUTES * 60 * 1000);
                updates.pinAttempts = 0;
                logger.warn("Wallet PIN locked", { userId, attempts });
            }

            await this.updateById(wallet._id as string, updates);

            const remaining = WALLET_LIMITS.MAX_PIN_ATTEMPTS - attempts;
            throw errorResponseMessage.createError(
                401,
                remaining > 0
                    ? `Incorrect PIN. ${remaining} attempt(s) remaining.`
                    : `Too many incorrect attempts. PIN locked for ${WALLET_LIMITS.PIN_LOCKOUT_MINUTES} minutes.`,
                ErrorSeverity.HIGH
            );
        }

        // Reset attempts on success
        if (wallet.pinAttempts > 0) {
            await this.updateById(wallet._id as string, { pinAttempts: 0, pinLockedUntil: undefined });
        }
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

        if (!wallet) {
            logger.error("Wallet not found for funding", { paystackReference, customerCode, dvaAccountNumber });
            return null;
        }

        if (wallet.status !== WALLET_STATUS.ACTIVE) {
            logger.warn("Funding attempted on non-active wallet", { walletId: wallet._id, status: wallet.status });
            return null;
        }

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const reference = this.walletTransactionService.generateReference('FND');
            const balanceBefore = wallet.balance;
            const balanceAfter = balanceBefore + amount;

            // Atomic balance update
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
            return walletTransaction;
        } catch (error) {
            await session.abortTransaction();
            logger.error("Wallet funding failed", { paystackReference, error });
            throw error;
        } finally {
            session.endSession();
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

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            const reference = this.walletTransactionService.generateReference('WDR');
            const balanceBefore = wallet.balance;
            const balanceAfter = balanceBefore - amount;

            // 5. Atomic balance debit
            const updatedWallet = await this.Model.findOneAndUpdate(
                { _id: wallet._id, status: WALLET_STATUS.ACTIVE, balance: { $gte: amount } },
                { $inc: { balance: -amount } },
                { new: true, session }
            );

            if (!updatedWallet) {
                throw errorResponseMessage.createError(400, "Insufficient balance or wallet unavailable", ErrorSeverity.HIGH);
            }

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

                await this.Model.findOneAndUpdate(
                    { _id: wallet._id },
                    { $inc: { balance: amount } }
                );

                await this.walletTransactionService.updateById(walletTransaction._id as string, {
                    status: WALLET_TRANSACTION_STATUS.FAILED,
                    failureReason: paystackError?.response?.data?.message || paystackError?.message || "Transfer initiation failed",
                });

                throw errorResponseMessage.createError(
                    500,
                    paystackError?.response?.data?.message || "Failed to initiate transfer with payment provider",
                    ErrorSeverity.HIGH
                );
            }

            logger.info("Withdrawal initiated", { walletId: wallet._id, amount, reference });
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
     * Process successful withdrawal (from Paystack webhook: transfer.success)
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

        await this.walletTransactionService.updateById(walletTx._id as string, {
            status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
        });

        // Update ledger balance to match (balance was already debited at initiation)
        await this.Model.findOneAndUpdate(
            { _id: walletTx.wallet },
            { $inc: { ledgerBalance: -walletTx.amount } }
        );

        logger.info("Withdrawal completed successfully", { reference, amount: walletTx.amount });
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
     * Credit wallet balance (e.g. refund).
     */
    async creditBalance(walletId: string, amount: number) {
        return this.Model.findOneAndUpdate(
            { _id: walletId },
            { $inc: { balance: amount } },
            { new: true }
        );
    }

    /**
     * Update ledger balance (after confirmed settlement).
     */
    async adjustLedgerBalance(walletId: string, amount: number) {
        return this.Model.findOneAndUpdate(
            { _id: walletId },
            { $inc: { ledgerBalance: amount } },
            { new: true }
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
