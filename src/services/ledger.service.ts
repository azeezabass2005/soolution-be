import mongoose, { ClientSession, FilterQuery } from 'mongoose';
import crypto from 'crypto';
import Account, { IAccount } from '../models/account.model';
import JournalEntry, {
    IJournalEntry,
    JournalDirection,
    JournalSource,
} from '../models/journal-entry.model';
import { ACCOUNT_STATUS, JOURNAL_DIRECTION } from '../common/constant';
import errorResponseMessage, { ErrorSeverity } from '../common/messages/error-response-message';
import logger from '../utils/logger.utils';

export interface JournalLeg {
    accountCode: string;
    direction: JournalDirection;
    amount: number;
}

export interface PostOptions {
    legs: JournalLeg[];
    txGroupId?: string;
    source: JournalSource;
    reference: string;
    description: string;
    currency?: string; // overrides per-leg account currency mismatch check; defaults to first leg account currency
    externalRef?: { provider: string; id: string };
    metadata?: Record<string, any>;
    postedBy?: string;
    session: ClientSession;
}

export interface PostResult {
    txGroupId: string;
    entries: IJournalEntry[];
}

/**
 * The single entry point for every money movement on the platform.
 *
 * LedgerService maintains the double-entry invariant — every posting consists
 * of one or more legs whose debits sum to credits. The journal_entries
 * collection is the source of truth; account.balance is a cached projection
 * refreshed atomically inside the same Mongo session as the leg writes.
 *
 * Callers that need to coordinate the journal post with other writes (e.g.
 * mutating wallet.balance as a denormalised cache) MUST pass in their own
 * session so all writes commit together.
 */
class LedgerService {
    /**
     * Post a balanced multi-leg journal entry. Throws if:
     *   - debits != credits (within float epsilon),
     *   - any account doesn't exist or is frozen,
     *   - any leg amount is non-positive.
     *
     * The caller's session is reused — atomicity is the caller's responsibility.
     */
    async post(opts: PostOptions): Promise<PostResult> {
        const {
            legs,
            source,
            reference,
            description,
            externalRef,
            metadata,
            postedBy,
            session,
        } = opts;

        if (!session) {
            throw errorResponseMessage.createError(
                500,
                'LedgerService.post requires a Mongo session',
                ErrorSeverity.CRITICAL
            );
        }

        if (!Array.isArray(legs) || legs.length < 2) {
            throw errorResponseMessage.createError(
                500,
                'A journal posting requires at least two legs',
                ErrorSeverity.CRITICAL
            );
        }

        // Invariant 1: amounts must be positive finite numbers.
        for (const leg of legs) {
            if (!Number.isFinite(leg.amount) || leg.amount <= 0) {
                throw errorResponseMessage.createError(
                    500,
                    `Invalid leg amount for account ${leg.accountCode}: ${leg.amount}`,
                    ErrorSeverity.CRITICAL
                );
            }
        }

        // Invariant 2: debits == credits (within 0.01 to absorb float noise).
        const debits = legs
            .filter((l) => l.direction === JOURNAL_DIRECTION.DEBIT)
            .reduce((s, l) => s + l.amount, 0);
        const credits = legs
            .filter((l) => l.direction === JOURNAL_DIRECTION.CREDIT)
            .reduce((s, l) => s + l.amount, 0);
        if (Math.abs(debits - credits) > 0.01) {
            throw errorResponseMessage.createError(
                500,
                `Unbalanced journal posting: debits=${debits} credits=${credits} reference=${reference}`,
                ErrorSeverity.CRITICAL
            );
        }

        // Resolve all accounts in one round-trip and validate.
        const codes = Array.from(new Set(legs.map((l) => l.accountCode)));
        const accounts = await Account.find({ code: { $in: codes } }).session(session);
        const byCode = new Map<string, IAccount>(accounts.map((a) => [a.code, a]));

        for (const code of codes) {
            const acc = byCode.get(code);
            if (!acc) {
                throw errorResponseMessage.createError(
                    500,
                    `Ledger account not found: ${code}. Bootstrap may not have completed.`,
                    ErrorSeverity.CRITICAL
                );
            }
            if (acc.status === ACCOUNT_STATUS.FROZEN) {
                throw errorResponseMessage.createError(
                    400,
                    `Ledger account ${code} is frozen — posting refused`,
                    ErrorSeverity.HIGH
                );
            }
        }

        const txGroupId = opts.txGroupId || crypto.randomUUID();
        const postedAt = new Date();

        // Build the leg documents. Currency is taken from each leg's account.
        const legDocs = legs.map((leg) => {
            const acc = byCode.get(leg.accountCode)!;
            return {
                txGroupId,
                accountCode: acc.code,
                account: acc._id,
                direction: leg.direction,
                amount: leg.amount,
                currency: opts.currency || acc.currency,
                reference,
                source,
                description,
                externalRef,
                metadata,
                postedAt,
                postedBy,
            };
        });

        const entries = await JournalEntry.insertMany(legDocs, { session });

        // Update the cached account.balance projection. Sign of the delta
        // depends on account type semantics:
        //   - asset/expense → debit increases, credit decreases
        //   - liability/equity/revenue → credit increases, debit decreases
        for (const leg of legs) {
            const acc = byCode.get(leg.accountCode)!;
            const isDebitNormal =
                acc.type === 'asset' || acc.type === 'expense';
            const sign =
                leg.direction === JOURNAL_DIRECTION.DEBIT
                    ? isDebitNormal
                        ? 1
                        : -1
                    : isDebitNormal
                        ? -1
                        : 1;
            const delta = sign * leg.amount;
            await Account.updateOne(
                { _id: acc._id },
                { $inc: { balance: delta }, $set: { balanceUpdatedAt: postedAt } },
                { session }
            );
        }

        logger.info('Journal posting committed', {
            txGroupId,
            source,
            reference,
            legs: legs.map((l) => ({ code: l.accountCode, dir: l.direction, amt: l.amount })),
        });

        return { txGroupId, entries: entries as unknown as IJournalEntry[] };
    }

    /**
     * Compute the true balance of an account directly from its journal entries.
     * Used by reconciliation to prove account.balance has not drifted.
     */
    async computeBalance(accountCode: string, asOf?: Date): Promise<number> {
        const account = await Account.findOne({ code: accountCode });
        if (!account) {
            throw errorResponseMessage.resourceNotFound(`Account ${accountCode}`);
        }

        const filter: FilterQuery<IJournalEntry> = { accountCode };
        if (asOf) filter.postedAt = { $lte: asOf };

        const result = await JournalEntry.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: '$direction',
                    total: { $sum: '$amount' },
                },
            },
        ]);

        let debits = 0;
        let credits = 0;
        for (const row of result) {
            if (row._id === JOURNAL_DIRECTION.DEBIT) debits = row.total;
            if (row._id === JOURNAL_DIRECTION.CREDIT) credits = row.total;
        }

        const isDebitNormal = account.type === 'asset' || account.type === 'expense';
        return isDebitNormal ? debits - credits : credits - debits;
    }

    /**
     * Recompute account.balance from the journal and persist it.
     * Used by reconciliation to repair drift.
     */
    async refreshAccountBalance(accountCode: string): Promise<number> {
        const trueBalance = await this.computeBalance(accountCode);
        await Account.updateOne(
            { code: accountCode },
            { $set: { balance: trueBalance, balanceUpdatedAt: new Date() } }
        );
        return trueBalance;
    }

    /**
     * Read-only paginated journal query used by the admin UI.
     */
    async listEntries(
        filter: FilterQuery<IJournalEntry>,
        opts: { page?: number; limit?: number } = {}
    ): Promise<any> {
        const page = opts.page || 1;
        const limit = Math.min(opts.limit || 25, 200);
        // @ts-ignore — paginate plugin types
        return JournalEntry.paginate(filter, {
            page,
            limit,
            sort: { postedAt: -1 },
            customLabels: {
                totalDocs: 'itemsCount',
                docs: 'data',
                limit: 'perPage',
                page: 'currentPage',
                nextPage: 'next',
                prevPage: 'prev',
                totalPages: 'pageCount',
                pagingCounter: 'serialNumber',
                meta: 'paginator',
            },
        });
    }

    /**
     * Fetch every leg of a single posting so the admin can see the full
     * balanced entry. Returned in a stable order.
     */
    async getTxGroup(txGroupId: string): Promise<IJournalEntry[]> {
        return JournalEntry.find({ txGroupId }).sort({ direction: 1, accountCode: 1 });
    }

    /**
     * Convenience helper for callers that don't already have a session.
     * Wraps post() in a fresh session+transaction. Avoid in money paths that
     * already need to coordinate with other writes (use post() directly there).
     */
    async postStandalone(
        opts: Omit<PostOptions, 'session'>
    ): Promise<PostResult> {
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            const result = await this.post({ ...opts, session });
            await session.commitTransaction();
            return result;
        } catch (error) {
            if (session.inTransaction()) await session.abortTransaction();
            throw error;
        } finally {
            session.endSession();
        }
    }
}

// Singleton — service has no per-instance state.
const ledgerService = new LedgerService();
export default ledgerService;
export { LedgerService };
