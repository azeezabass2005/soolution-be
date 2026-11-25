import { withoutProviderName } from "../utils/provider-names.utils";
import crypto from "crypto";
import type { Executor } from "../db/client";
import { withTransaction } from "../db/transaction";
import walletRepository from "../repositories/wallet.repository";
import walletTransactionRepository from "../repositories/wallet-transaction.repository";
import type { Wallet, WalletTransaction } from "../types/entities";
import type { JournalSource } from "../types/enums";
import ledgerService, { JournalLeg } from "./ledger.service";
import WalletService from "./wallet.service";
import WalletTransactionService from "./wallet-transaction.service";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import {
    JOURNAL_DIRECTION,
    JOURNAL_SOURCE,
    SYSTEM_ACCOUNT_CODES,
    WALLET_STATUS,
    WALLET_TRANSACTION_STATUS,
    WALLET_TRANSACTION_TYPE,
    userWalletAccountCode,
} from "../common/constant";
import { BASE_WALLET_CURRENCY, fxPositionCode, isWalletCurrency, manualPayoutPendingCode, type WalletCurrency } from "../common/wallet.constants";
import logger from "../utils/logger.utils";
import { assertNotHeld, availableOf } from "../common/wallet-holds";

const round2 = (n: number) => Math.round(n * 100) / 100;
/** What the user pays is rounded up so the platform never books less than it charged */
const ceil2 = (n: number) => Math.ceil(Math.round(n * 1e6) / 1e4) / 100;
const money = (amount: number, currency: string) =>
    `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export interface SendCharge {
    userId: string;
    /** NGN, or the destination currency's wallet */
    walletCurrency: string;
    destinationCurrency: string;
    /** What the recipient gets, in the destination currency */
    destinationAmount: number;
    /** The payout's NGN value as the provider side of the ledger books it */
    ngnAmount: number;
    /** The fee in NGN (FEES_NGN) */
    ngnFee: number;
    feePercent: number;
    /** Where the converted amount sits until the provider settles (e.g. YC_FLOAT_NGN) */
    providerAccountCode: string;
    source: JournalSource;
    reference: string;
    description: string;
    externalRef?: { provider: string; id: string };
    metadata?: Record<string, any>;
    walletTxDescription: string;
}

export interface SendChargeResult {
    wallet: Wallet;
    walletTransaction: WalletTransaction;
    /** Total taken from the wallet, in its currency */
    walletDebit: number;
    /** Fee part of walletDebit, in the wallet's currency */
    walletFee: number;
}

/**
 * Pays for sends from a user's wallet and refunds them.
 *
 * From the NGN wallet nothing changes: the wallet pays the converted amount
 * plus the fee. From the destination currency's wallet (filled earlier by an
 * exchange) the recipient's amount plus a fee at the same percentage comes out
 * of that wallet with no conversion, and two postings keep the ledger whole:
 *   1. per-currency: USER_WALLET_X → FX_POSITION_X (the X owed to the user is
 *      delivered)
 *   2. NGN, as the provider postings expect: FX_POSITION_NGN → provider float +
 *      FEES_NGN (the naira taken in by the exchange pays the provider)
 *
 * The NGN figures are stored on the wallet transaction so refunds reverse
 * exactly what was booked, whichever path (create failure, poll, webhook)
 * triggers them.
 */
class WalletSendService {
    private walletService = new WalletService();
    private walletTransactionService = new WalletTransactionService();

    /** Which wallet can pay for a send to `destinationCurrency` */
    resolveWalletCurrency(requested: unknown, destinationCurrency: string): string {
        if (requested === undefined || requested === null || requested === "") return BASE_WALLET_CURRENCY;
        const currency = String(requested).toUpperCase();
        if (currency !== BASE_WALLET_CURRENCY && currency !== destinationCurrency) {
            throw errorResponseMessage.createError(400, `Pay from your NGN wallet or your ${destinationCurrency} wallet`, ErrorSeverity.LOW);
        }
        if (!isWalletCurrency(currency)) {
            throw errorResponseMessage.createError(400, `${currency} wallets aren't supported`, ErrorSeverity.LOW);
        }
        return currency;
    }

    /** Fee charged to a currency wallet: the same percentage, on the recipient's amount */
    walletFeeFor(destinationAmount: number, feePercent: number): number {
        return feePercent > 0 ? ceil2(destinationAmount * (feePercent / 100)) : 0;
    }

    /** Throws a clear error unless the wallet can cover the charge (call before side effects) */
    async assertCanPay(userId: string, walletCurrency: string, total: number, tx?: Executor): Promise<Wallet> {
        const wallet = await this.walletService.findWallet(userId, walletCurrency, tx);
        if (!wallet) {
            throw errorResponseMessage.createError(
                400,
                walletCurrency === BASE_WALLET_CURRENCY
                    ? "You don't have a wallet yet. Please set up your wallet first."
                    : `You don't have a ${walletCurrency} wallet yet. Exchange from NGN to open one.`,
                ErrorSeverity.MEDIUM
            );
        }
        if (wallet.status !== WALLET_STATUS.ACTIVE) {
            throw errorResponseMessage.createError(400, "Your wallet is not active. Please contact support.", ErrorSeverity.HIGH);
        }
        assertNotHeld(wallet, total);
        if (availableOf(wallet) < total) {
            throw errorResponseMessage.createError(
                400,
                `Insufficient ${walletCurrency} balance. You need ${money(total, walletCurrency)} but your balance is ${money(wallet.balance, walletCurrency)}.`,
                ErrorSeverity.MEDIUM,
                { code: "INSUFFICIENT_BALANCE", currency: walletCurrency, required: total, available: wallet.balance }
            );
        }
        return wallet;
    }

    /** Debit the wallet and post the send, atomically */
    async charge(params: SendCharge): Promise<SendChargeResult> {
        const fromBase = params.walletCurrency === BASE_WALLET_CURRENCY;
        if (!fromBase && params.walletCurrency !== params.destinationCurrency) {
            throw errorResponseMessage.createError(500, "A send can only be paid from NGN or its destination wallet", ErrorSeverity.CRITICAL);
        }
        const walletFee = fromBase ? params.ngnFee : this.walletFeeFor(params.destinationAmount, params.feePercent);
        const walletDebit = fromBase ? round2(params.ngnAmount + params.ngnFee) : round2(params.destinationAmount + walletFee);

        const wallet = await this.assertCanPay(params.userId, params.walletCurrency, walletDebit);
        await this.walletService.getOrCreateWallet(params.userId, params.walletCurrency as WalletCurrency);

        return withTransaction(async (tx) => {
            const updated = await this.walletService.debitBalance(wallet.id, walletDebit, tx);
            await this.postCharge(params, walletDebit, crypto.randomUUID(), tx);

            const walletTransaction = await walletTransactionRepository.create(
                {
                    wallet: wallet.id,
                    user: params.userId,
                    type: WALLET_TRANSACTION_TYPE.TRANSFER,
                    status: WALLET_TRANSACTION_STATUS.PENDING,
                    amount: walletDebit,
                    currency: params.walletCurrency,
                    reference: this.walletTransactionService.generateReference("TRF"),
                    balanceBefore: round2(updated.balance + walletDebit),
                    balanceAfter: updated.balance,
                    description: params.walletTxDescription,
                    sendNgnAmount: params.ngnAmount,
                    sendNgnFee: params.ngnFee,
                    sendFee: walletFee,
                    providerAccountCode: params.providerAccountCode,
                },
                tx
            );

            return { wallet: updated, walletTransaction, walletDebit, walletFee };
        });
    }

    private async postCharge(params: SendCharge, walletDebit: number, txGroupId: string, tx: Executor) {
        const { userId, walletCurrency, ngnAmount, ngnFee, providerAccountCode } = params;
        const common = {
            source: params.source,
            reference: params.reference,
            description: params.description,
            externalRef: params.externalRef,
            metadata: { ...params.metadata, walletCurrency, walletDebit },
            txGroupId,
            tx,
        };
        const providerLegs: JournalLeg[] = [{ accountCode: providerAccountCode, direction: JOURNAL_DIRECTION.CREDIT, amount: ngnAmount }];
        if (ngnFee > 0) providerLegs.push({ accountCode: SYSTEM_ACCOUNT_CODES.FEES_NGN, direction: JOURNAL_DIRECTION.CREDIT, amount: ngnFee });

        if (walletCurrency === BASE_WALLET_CURRENCY) {
            await ledgerService.post({
                ...common,
                legs: [{ accountCode: userWalletAccountCode(userId, walletCurrency), direction: JOURNAL_DIRECTION.DEBIT, amount: walletDebit }, ...providerLegs],
            });
            return;
        }
        await ledgerService.post({
            ...common,
            perCurrency: true,
            legs: [
                { accountCode: userWalletAccountCode(userId, walletCurrency), direction: JOURNAL_DIRECTION.DEBIT, amount: walletDebit },
                { accountCode: fxPositionCode(walletCurrency), direction: JOURNAL_DIRECTION.CREDIT, amount: walletDebit },
            ],
        });
        await ledgerService.post({
            ...common,
            legs: [{ accountCode: fxPositionCode(BASE_WALLET_CURRENCY), direction: JOURNAL_DIRECTION.DEBIT, amount: round2(ngnAmount + ngnFee) }, ...providerLegs],
        });
    }

    /**
     * Return a failed send's money to the wallet that paid for it. Idempotent:
     * the wallet transaction is claimed in the same database transaction, so a
     * webhook and a poll racing each other refund once.
     */
    async refund(
        walletTransactionId: string,
        reason: string,
        legacy: { feeAmount?: number; providerAccountCode: string; externalRef?: { provider: string; id: string } }
    ): Promise<boolean> {
        try {
            const refunded = await withTransaction(async (tx) => {
                // Never refund a send that already went through (a late or
                // out-of-order provider event), nor one refunded before
                const walletTx = await walletTransactionRepository.claim(
                    walletTransactionId,
                    [WALLET_TRANSACTION_STATUS.SUCCESSFUL as "successful", WALLET_TRANSACTION_STATUS.FAILED as "failed", WALLET_TRANSACTION_STATUS.REVERSED as "reversed"],
                    { status: WALLET_TRANSACTION_STATUS.FAILED as "failed", failureReason: reason },
                    tx
                );
                if (!walletTx) return false;

                const userId = walletTx.user;
                const currency = walletTx.currency || BASE_WALLET_CURRENCY;
                const amount = walletTx.amount;
                const ngnFee = walletTx.sendNgnFee ?? legacy.feeAmount ?? 0;
                const ngnAmount = walletTx.sendNgnAmount ?? round2(amount - ngnFee);
                const providerAccountCode = walletTx.providerAccountCode || legacy.providerAccountCode;
                const common = {
                    source: JOURNAL_SOURCE.REVERSAL,
                    reference: walletTx.reference,
                    description: `Reversal — send refund (${reason})`,
                    externalRef: legacy.externalRef,
                    metadata: { reverses: walletTx.reference, reason, walletCurrency: currency },
                    txGroupId: crypto.randomUUID(),
                    tx,
                };
                const providerLegs: JournalLeg[] = [{ accountCode: providerAccountCode, direction: JOURNAL_DIRECTION.DEBIT, amount: ngnAmount }];
                if (ngnFee > 0) providerLegs.push({ accountCode: SYSTEM_ACCOUNT_CODES.FEES_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount: ngnFee });

                if (currency === BASE_WALLET_CURRENCY) {
                    await ledgerService.post({
                        ...common,
                        legs: [...providerLegs, { accountCode: userWalletAccountCode(userId, currency), direction: JOURNAL_DIRECTION.CREDIT, amount }],
                    });
                } else {
                    await ledgerService.post({
                        ...common,
                        legs: [...providerLegs, { accountCode: fxPositionCode(BASE_WALLET_CURRENCY), direction: JOURNAL_DIRECTION.CREDIT, amount: round2(ngnAmount + ngnFee) }],
                    });
                    await ledgerService.post({
                        ...common,
                        perCurrency: true,
                        legs: [
                            { accountCode: fxPositionCode(currency), direction: JOURNAL_DIRECTION.DEBIT, amount },
                            { accountCode: userWalletAccountCode(userId, currency), direction: JOURNAL_DIRECTION.CREDIT, amount },
                        ],
                    });
                }

                const wallet = await walletRepository.credit(walletTx.wallet, amount, tx);
                if (!wallet) throw errorResponseMessage.createError(500, "Wallet not found for refund", ErrorSeverity.CRITICAL);

                await walletTransactionRepository.create(
                    {
                        wallet: walletTx.wallet,
                        user: walletTx.user,
                        type: WALLET_TRANSACTION_TYPE.REVERSAL,
                        status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                        amount,
                        currency,
                        reference: this.walletTransactionService.generateReference("REV"),
                        balanceBefore: round2(wallet.balance - amount),
                        balanceAfter: wallet.balance,
                        // Customers see this: never a partner's own wording
                        description: `Refund: ${withoutProviderName(reason, "the payment didn't go through")} (${walletTx.reference})`,
                        reversedTransactionId: walletTx.id,
                        transactionId: walletTx.transactionId,
                    },
                    tx
                );
                return true;
            });

            if (!refunded) {
                logger.info("Send refund skipped: already refunded or not found", { walletTransactionId });
                return false;
            }
            logger.info("Send refunded to wallet", { walletTransactionId, reason });
            return true;
        } catch (error: any) {
            logger.error("CRITICAL: send refund failed", { walletTransactionId, reason, error: error?.message });
            throw error;
        }
    }

    // ===================== MANUAL PAYOUTS (ops pays the recipient) =====================

    /**
     * Take a manual send's amount from the matching currency wallet and hold
     * it in MANUAL_PAYOUT_PENDING_{CUR} until ops completes or rejects it.
     * Runs in the caller's transaction so the debit commits with the transaction.
     */
    async holdForManualPayout(
        params: { userId: string; currency: string; amount: number; transactionId: string; reference: string; description: string },
        tx: Executor
    ): Promise<WalletTransaction> {
        const { userId, currency, amount } = params;
        const wallet = await this.assertCanPay(userId, currency, amount, tx);
        await this.walletService.getOrCreateWallet(userId, currency as WalletCurrency, tx);
        const updated = await this.walletService.debitBalance(wallet.id, amount, tx);
        await ledgerService.post({
            perCurrency: true,
            legs: [
                { accountCode: userWalletAccountCode(userId, currency), direction: JOURNAL_DIRECTION.DEBIT, amount },
                { accountCode: manualPayoutPendingCode(currency), direction: JOURNAL_DIRECTION.CREDIT, amount },
            ],
            source: JOURNAL_SOURCE.MANUAL_PAYOUT,
            reference: params.reference,
            description: params.description,
            metadata: { transactionId: params.transactionId },
            tx,
        });
        return walletTransactionRepository.create(
            {
                wallet: wallet.id,
                user: userId,
                type: WALLET_TRANSACTION_TYPE.TRANSFER,
                status: WALLET_TRANSACTION_STATUS.PENDING,
                amount,
                currency,
                reference: this.walletTransactionService.generateReference("TRF"),
                balanceBefore: round2(updated.balance + amount),
                balanceAfter: updated.balance,
                description: params.description,
                providerAccountCode: manualPayoutPendingCode(currency),
                transactionId: params.transactionId,
            },
            tx
        );
    }

    /** Ops paid the recipient: the held money leaves the platform's FX position */
    async completeManualPayout(transactionId: string): Promise<void> {
        await withTransaction(async (tx) => {
            const walletTx = await walletTransactionRepository.claimPendingTransferFor(
                transactionId,
                { status: WALLET_TRANSACTION_STATUS.SUCCESSFUL as "successful" },
                tx
            );
            if (!walletTx) return;
            const currency = walletTx.currency || BASE_WALLET_CURRENCY;
            await ledgerService.post({
                perCurrency: true,
                legs: [
                    { accountCode: manualPayoutPendingCode(currency), direction: JOURNAL_DIRECTION.DEBIT, amount: walletTx.amount },
                    { accountCode: fxPositionCode(currency), direction: JOURNAL_DIRECTION.CREDIT, amount: walletTx.amount },
                ],
                source: JOURNAL_SOURCE.MANUAL_PAYOUT,
                reference: walletTx.reference,
                description: "Manual payout completed",
                metadata: { transactionId },
                tx,
            });
            await walletRepository.adjustLedgerBalance(walletTx.wallet, -walletTx.amount, tx);
        });
    }

    /** Ops rejected the payout: the held money goes back to the wallet. Idempotent. */
    async refundManualPayout(transactionId: string, reason: string): Promise<boolean> {
        return withTransaction(async (tx) => {
            const walletTx = await walletTransactionRepository.claimPendingTransferFor(
                transactionId,
                { status: WALLET_TRANSACTION_STATUS.FAILED as "failed", failureReason: reason },
                tx
            );
            if (!walletTx) return false;
            const currency = walletTx.currency || BASE_WALLET_CURRENCY;
            await ledgerService.post({
                perCurrency: true,
                legs: [
                    { accountCode: manualPayoutPendingCode(currency), direction: JOURNAL_DIRECTION.DEBIT, amount: walletTx.amount },
                    { accountCode: userWalletAccountCode(walletTx.user, currency), direction: JOURNAL_DIRECTION.CREDIT, amount: walletTx.amount },
                ],
                source: JOURNAL_SOURCE.REVERSAL,
                reference: walletTx.reference,
                description: `Manual payout rejected — returned to wallet (${reason})`,
                metadata: { transactionId, reason },
                tx,
            });
            const wallet = await walletRepository.credit(walletTx.wallet, walletTx.amount, tx);
            if (!wallet) throw errorResponseMessage.createError(500, "Wallet not found for refund", ErrorSeverity.CRITICAL);
            await walletTransactionRepository.create(
                {
                    wallet: walletTx.wallet,
                    user: walletTx.user,
                    type: WALLET_TRANSACTION_TYPE.REVERSAL,
                    status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                    amount: walletTx.amount,
                    currency,
                    reference: this.walletTransactionService.generateReference("REV"),
                    balanceBefore: round2(wallet.balance - walletTx.amount),
                    balanceAfter: wallet.balance,
                    description: `Returned: ${reason}`,
                    reversedTransactionId: walletTx.id,
                    transactionId,
                },
                tx
            );
            return true;
        });
    }
}

export default new WalletSendService();
