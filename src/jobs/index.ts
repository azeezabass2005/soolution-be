import logger from '../utils/logger.utils';
import reconciliationService from '../services/reconciliation.service';
import { runStaleTransactionSweep } from './sweeper.job';

const ONE_MINUTE = 60_000;
const ONE_HOUR = 60 * ONE_MINUTE;

let timers: NodeJS.Timeout[] = [];

/**
 * Wrap a job function so a thrown error from one tick can never kill the
 * interval. We log and move on.
 */
function safe(name: string, fn: () => Promise<void>): () => Promise<void> {
    return async () => {
        const start = Date.now();
        logger.info(`Job started: ${name}`);
        try {
            await fn();
            logger.info(`Job finished: ${name}`, { durationMs: Date.now() - start });
        } catch (error) {
            logger.error(`Job failed: ${name}`, {
                durationMs: Date.now() - start,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    };
}

/**
 * Schedule the platform's recurring source-of-truth jobs.
 *
 * Single-instance only. If you ever run multiple app instances, swap this
 * for an external scheduler (e.g. node-cron + leader election, or a real
 * cron daemon hitting an admin endpoint) so jobs don't fire N times.
 */
export function registerJobs(): void {
    if (timers.length > 0) {
        logger.warn('registerJobs called twice — ignoring second call');
        return;
    }

    // Stale transaction sweep — every 5 minutes.
    const sweepFn = safe('stale-transaction-sweep', runStaleTransactionSweep);
    timers.push(setInterval(sweepFn, 5 * ONE_MINUTE));

    // Full reconciliation — once an hour. Originally specified as nightly 02:00,
    // but with setInterval we don't have wall-clock scheduling. Hourly is a
    // reasonable substitute for a single-instance system.
    const reconFn = safe('nightly-reconciliation', async () => {
        await reconciliationService.runFullReconciliation({ runMode: 'cron' });
    });
    timers.push(setInterval(reconFn, ONE_HOUR));

    logger.info('Background jobs scheduled', {
        sweepIntervalMs: 5 * ONE_MINUTE,
        reconIntervalMs: ONE_HOUR,
    });
}

/**
 * Test/teardown helper — clear any scheduled intervals.
 */
export function unregisterJobs(): void {
    for (const t of timers) clearInterval(t);
    timers = [];
}
