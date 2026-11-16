import { getDb, type Executor } from "./client";
import { isRetryableTransactionError } from "./errors";
import logger from "../utils/logger.utils";

export interface TransactionOptions {
    /**
     * Attempts on a deadlock / serialization failure. The callback is re-run
     * from the start, so it must only do database work (no HTTP calls, emails
     * or other side effects that can't be repeated).
     */
    attempts?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` in a database transaction: everything commits together, or a
 * thrown error rolls all of it back. Replaces Mongo's
 * startSession/startTransaction/commit/abort boilerplate.
 */
export async function withTransaction<T>(fn: (tx: Executor) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    const attempts = Math.max(1, options.attempts ?? 3);
    for (let attempt = 1; ; attempt++) {
        try {
            return await getDb().transaction(async (tx) => fn(tx as unknown as Executor));
        } catch (error) {
            if (attempt >= attempts || !isRetryableTransactionError(error)) throw error;
            logger.warn("Retrying transaction after a deadlock/serialization failure", { attempt });
            await sleep(20 * attempt + Math.floor(Math.random() * 30));
        }
    }
}

/** Uses the caller's transaction when given one, otherwise opens a new one */
export async function inTransaction<T>(tx: Executor | undefined, fn: (tx: Executor) => Promise<T>): Promise<T> {
    return tx ? fn(tx) : withTransaction(fn);
}
