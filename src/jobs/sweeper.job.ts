import transactionRepository from '../repositories/transaction.repository';
import walletTransactionRepository from '../repositories/wallet-transaction.repository';
import TransactionService from '../services/transaction.service';
import WalletService from '../services/wallet.service';
import {
    DETAIL_TYPE,
    TRANSACTION_STATUS,
    WALLET_TRANSACTION_TYPE,
    WALLET_TRANSACTION_STATUS,
} from '../common/constant';
import logger from '../utils/logger.utils';

const STALE_YC_AFTER_MS = 10 * 60 * 1000; // 10 min
const STALE_WITHDRAWAL_AFTER_MS = 15 * 60 * 1000; // 15 min
const STALE_GHS_AFTER_MS = 15 * 60 * 1000; // 15 min
const MAX_PER_RUN = 50;

const txService = new TransactionService();
const walletSvc = new WalletService();

/**
 * Find YellowCard payments stuck in PENDING / PROCESSING and ask YC for the
 * authoritative status, then sync. Refunds are handled by pollYellowCardStatus
 * via the existing refund path (which posts a balanced reversal journal).
 */
async function sweepStaleYC(): Promise<{ scanned: number; synced: number }> {
    const cutoff = new Date(Date.now() - STALE_YC_AFTER_MS);
    const stale = await transactionRepository.listStale(
        DETAIL_TYPE.YELLOWCARD as 'yellowcard',
        [TRANSACTION_STATUS.PENDING, TRANSACTION_STATUS.PROCESSING] as ('pending' | 'processing')[],
        cutoff,
        MAX_PER_RUN
    );

    let synced = 0;
    for (const tx of stale) {
        try {
            await txService.pollYellowCardStatus(tx.id);
            synced += 1;
        } catch (error) {
            logger.warn('Sweeper: YC poll failed', {
                transactionId: tx.id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { scanned: stale.length, synced };
}

/**
 * Find NGN withdrawals stuck in PROCESSING and check the payout with Fincra.
 * The verifier already syncs status and posts the balanced journal entries
 * (success → settle, failure → reverse).
 */
async function sweepStaleWithdrawals(): Promise<{ scanned: number; synced: number }> {
    const cutoff = new Date(Date.now() - STALE_WITHDRAWAL_AFTER_MS);
    const stale = await walletTransactionRepository.listStale(
        WALLET_TRANSACTION_TYPE.WITHDRAWAL as 'withdrawal',
        WALLET_TRANSACTION_STATUS.PROCESSING as 'processing',
        cutoff,
        MAX_PER_RUN
    );

    let synced = 0;
    for (const tx of stale) {
        try {
            await walletSvc.verifyAndUpdateTransfer(tx.user, tx.id);
            synced += 1;
        } catch (error) {
            logger.warn('Sweeper: withdrawal verify failed', {
                walletTxId: tx.id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { scanned: stale.length, synced };
}

/**
 * Find GHS payouts and payment-link payments stuck in PENDING / PROCESSING
 * and ask Fincra for the status, then sync through the same handlers the
 * webhook uses (so settle/refund/state-machine share one code path).
 */
async function sweepStaleGhs(): Promise<{ scanned: number; synced: number }> {
    const cutoff = new Date(Date.now() - STALE_GHS_AFTER_MS);
    const stale = await transactionRepository.listStale(
        DETAIL_TYPE.FINCRA as 'fincra',
        [TRANSACTION_STATUS.PENDING, TRANSACTION_STATUS.PROCESSING] as ('pending' | 'processing')[],
        cutoff,
        MAX_PER_RUN
    );

    let synced = 0;
    for (const tx of stale) {
        try {
            await txService.pollGhsStatus(tx.id);
            synced += 1;
        } catch (error) {
            logger.warn('Sweeper: GHS poll failed', {
                transactionId: tx.id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { scanned: stale.length, synced };
}

/** One-time GHS accounts that were never paid: closed well after they expire */
async function closeUnpaidGhsAccounts(): Promise<number> {
    try {
        return await txService.expireGhsAccountCollections();
    } catch (error) {
        logger.warn('Sweeper: closing unpaid GHS accounts failed', { error: error instanceof Error ? error.message : String(error) });
        return 0;
    }
}

export async function runStaleTransactionSweep(): Promise<void> {
    const [yc, withdrawals, ghs, ghsAccountsClosed] = await Promise.all([
        sweepStaleYC(),
        sweepStaleWithdrawals(),
        sweepStaleGhs(),
        closeUnpaidGhsAccounts(),
    ]);
    logger.info('Sweep complete', { yc, withdrawals, ghs, ghsAccountsClosed });
}
