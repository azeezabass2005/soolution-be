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
import config from '../config/env.config';
import logger from '../utils/logger.utils';

const STALE_YC_AFTER_MS = 10 * 60 * 1000; // 10 min
const STALE_PAYSTACK_AFTER_MS = 15 * 60 * 1000; // 15 min
const STALE_OG_AFTER_MS = config.OGATEWAY_STALE_AFTER_MINUTES * 60 * 1000;
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
 * Find Paystack withdrawals stuck in PROCESSING and verify the transfer with
 * Paystack. The verifier already syncs status and posts the balanced journal
 * entries (success → settle, failure → reverse).
 */
async function sweepStalePaystack(): Promise<{ scanned: number; synced: number }> {
    const cutoff = new Date(Date.now() - STALE_PAYSTACK_AFTER_MS);
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
            logger.warn('Sweeper: Paystack verify failed', {
                walletTxId: tx.id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { scanned: stale.length, synced };
}

/**
 * Find OGateway payouts/collections stuck in PROCESSING and ask OGateway
 * for the authoritative status, then sync via the existing webhook
 * handler (so settle/refund/state-machine all reuse one code path).
 */
async function sweepStaleOGateway(): Promise<{ scanned: number; synced: number }> {
    const cutoff = new Date(Date.now() - STALE_OG_AFTER_MS);
    const stale = await transactionRepository.listStale(
        DETAIL_TYPE.OGATEWAY as 'ogateway',
        [TRANSACTION_STATUS.PENDING, TRANSACTION_STATUS.PROCESSING] as ('pending' | 'processing')[],
        cutoff,
        MAX_PER_RUN
    );

    let synced = 0;
    for (const tx of stale) {
        try {
            await txService.pollOGatewayStatus(tx.id);
            synced += 1;
        } catch (error) {
            logger.warn('Sweeper: OGateway poll failed', {
                transactionId: tx.id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { scanned: stale.length, synced };
}

export async function runStaleTransactionSweep(): Promise<void> {
    const [yc, paystack, og] = await Promise.all([
        sweepStaleYC(),
        sweepStalePaystack(),
        sweepStaleOGateway(),
    ]);
    logger.info('Sweep complete', { yc, paystack, og });
}
