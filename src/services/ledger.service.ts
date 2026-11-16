import crypto from 'crypto';
import type { Executor } from '../db/client';
import { withTransaction } from '../db/transaction';
import accountRepository from '../repositories/account.repository';
import journalRepository, { type JournalFilter } from '../repositories/journal.repository';
import type { Account, JournalEntry } from '../types/entities';
import type { JournalDirection, JournalSource } from '../types/enums';
import type { PageRequest, Paginated } from '../db/pagination';
import walletRepository from '../repositories/wallet.repository';
import walletTransactionRepository from '../repositories/wallet-transaction.repository';
import {
    ACCOUNT_STATUS,
    ACCOUNT_TYPE,
    JOURNAL_DIRECTION,
    JOURNAL_SOURCE,
    SYSTEM_ACCOUNT_CODES,
    WALLET_STATUS,
    WALLET_TRANSACTION_STATUS,
    WALLET_TRANSACTION_TYPE,
    userWalletAccountCode,
} from '../common/constant';
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
    currency?: string; // overrides per-leg account currency; defaults to each leg's account currency
    /**
     * Balance debits and credits separately within each account currency
     * (multi-currency wallet postings). Without it, legs are summed across
     * currencies, as the NGN-equivalent provider postings expect.
     */
    perCurrency?: boolean;
    externalRef?: { provider: string; id: string };
    metadata?: Record<string, any>;
    postedBy?: string;
    /** The caller's database transaction: the posting commits or rolls back with the caller's other writes */
    tx: Executor;
}

export interface PostResult {
    txGroupId: string;
    entries: JournalEntry[];
}

const isDebitNormal = (type: string) => type === 'asset' || type === 'expense';

/**
 * The single entry point for every money movement on the platform.
 *
 * LedgerService maintains the double-entry invariant — every posting consists
 * of one or more legs whose debits sum to credits. The journal_entries table
 * is the source of truth; accounts.balance is a cached projection updated in
 * the same database transaction as the journal rows.
 *
 * Callers that need to coordinate the journal post with other writes (e.g.
 * wallet.balance) MUST pass their own transaction so everything commits together.
 */
class LedgerService {
    /**
     * Post a balanced multi-leg journal entry. Throws if:
     *   - debits != credits (within float epsilon),
     *   - any account doesn't exist or is frozen,
     *   - any leg amount is non-positive.
     */
    async post(opts: PostOptions): Promise<PostResult> {
        const { legs, source, reference, description, externalRef, metadata, postedBy, tx } = opts;

        if (!tx) {
            throw errorResponseMessage.createError(500, 'LedgerService.post requires a database transaction', ErrorSeverity.CRITICAL);
        }

        if (!Array.isArray(legs) || legs.length < 2) {
            throw errorResponseMessage.createError(500, 'A journal posting requires at least two legs', ErrorSeverity.CRITICAL);
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
        const debits = legs.filter((l) => l.direction === JOURNAL_DIRECTION.DEBIT).reduce((s, l) => s + l.amount, 0);
        const credits = legs.filter((l) => l.direction === JOURNAL_DIRECTION.CREDIT).reduce((s, l) => s + l.amount, 0);
        if (Math.abs(debits - credits) > 0.01) {
            throw errorResponseMessage.createError(
                500,
                `Unbalanced journal posting: debits=${debits} credits=${credits} reference=${reference}`,
                ErrorSeverity.CRITICAL
            );
        }

        // Resolve all accounts in one round-trip and validate.
        const codes = Array.from(new Set(legs.map((l) => l.accountCode)));
        const accounts = await accountRepository.findByCodes(codes, tx);
        const byCode = new Map<string, Account>(accounts.map((a) => [a.code, a]));

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
                throw errorResponseMessage.createError(400, `Ledger account ${code} is frozen — posting refused`, ErrorSeverity.HIGH);
            }
        }

        // Invariant 3 (multi-currency postings): each currency balances on its own.
        if (opts.perCurrency) {
            const net = new Map<string, number>();
            for (const leg of legs) {
                const currency = byCode.get(leg.accountCode)!.currency;
                const signed = leg.direction === JOURNAL_DIRECTION.DEBIT ? leg.amount : -leg.amount;
                net.set(currency, (net.get(currency) ?? 0) + signed);
            }
            for (const [currency, amount] of net) {
                if (Math.abs(amount) > 0.01) {
                    throw errorResponseMessage.createError(
                        500,
                        `Unbalanced ${currency} legs in journal posting: net=${amount} reference=${reference}`,
                        ErrorSeverity.CRITICAL
                    );
                }
            }
        }

        const txGroupId = opts.txGroupId || crypto.randomUUID();
        const postedAt = new Date();

        const entries = await journalRepository.insertMany(
            legs.map((leg) => {
                const acc = byCode.get(leg.accountCode)!;
                return {
                    txGroupId,
                    accountCode: acc.code,
                    account: acc.id,
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
            }),
            tx
        );

        // Update the cached account.balance projection. Sign of the delta
        // depends on account type semantics:
        //   - asset/expense → debit increases, credit decreases
        //   - liability/equity/revenue → credit increases, debit decreases
        const deltas = new Map<string, number>();
        for (const leg of legs) {
            const acc = byCode.get(leg.accountCode)!;
            const debitNormal = isDebitNormal(acc.type);
            const sign = leg.direction === JOURNAL_DIRECTION.DEBIT ? (debitNormal ? 1 : -1) : debitNormal ? -1 : 1;
            deltas.set(acc.code, (deltas.get(acc.code) ?? 0) + sign * leg.amount);
        }
        await accountRepository.applyBalanceDeltas(deltas, postedAt, tx);

        logger.info('Journal posting committed', {
            txGroupId,
            source,
            reference,
            legs: legs.map((l) => ({ code: l.accountCode, dir: l.direction, amt: l.amount })),
        });

        return { txGroupId, entries };
    }

    /**
     * Compute the true balance of an account directly from its journal entries.
     * Used by reconciliation to prove account.balance has not drifted.
     */
    async computeBalance(accountCode: string, asOf?: Date): Promise<number> {
        const account = await accountRepository.findByCode(accountCode);
        if (!account) {
            throw errorResponseMessage.resourceNotFound(`Account ${accountCode}`);
        }
        const { debits, credits } = await journalRepository.totalsByDirection(accountCode, asOf);
        return isDebitNormal(account.type) ? debits - credits : credits - debits;
    }

    /**
     * Recompute account.balance from the journal and persist it.
     * Used by reconciliation to repair drift.
     */
    async refreshAccountBalance(accountCode: string): Promise<number> {
        const trueBalance = await this.computeBalance(accountCode);
        await accountRepository.setBalance(accountCode, trueBalance);
        return trueBalance;
    }

    /** Read-only paginated journal query used by the admin UI (newest first, max 200 per page) */
    async listEntries(filter: JournalFilter, opts: PageRequest = {}): Promise<Paginated<JournalEntry>> {
        return journalRepository.paginate(filter, opts, { limit: 25, maxLimit: 200 });
    }

    /**
     * Fetch every leg of a single posting so the admin can see the full
     * balanced entry. Returned in a stable order.
     */
    async getTxGroup(txGroupId: string): Promise<JournalEntry[]> {
        return journalRepository.findByTxGroup(txGroupId);
    }

    async findAccount(code: string): Promise<Account | undefined> {
        return accountRepository.findByCode(code);
    }

    /** Admin chart of accounts (by type, then code; max 500) */
    async searchAccounts(filter: { type?: string; currency?: string; code?: string }): Promise<Account[]> {
        return accountRepository.search(filter);
    }

    /** Open suspense credits (not yet attributed), newest first */
    async listOpenSuspense(page: PageRequest): Promise<Paginated<JournalEntry>> {
        return journalRepository.paginateOpenCredits(SYSTEM_ACCOUNT_CODES.SUSPENSE_NGN, page);
    }

    /**
     * Attribute a suspense credit to a user. Posts a balanced reversal
     * (debit SUSPENSE_NGN, credit USER_WALLET_NGN:{userId}), credits the wallet,
     * records it in the user's history and marks the original `reversedBy`.
     * The suspense entry is locked for the duration, so it can be attributed once.
     */
    async attributeSuspense(opts: { journalEntryId: string; userId: string; note?: string; adminId?: string }) {
        const { journalEntryId, userId, note, adminId } = opts;
        return withTransaction(async (tx) => {
            const original = await journalRepository.findByIdForUpdate(journalEntryId, tx);
            if (!original) throw errorResponseMessage.resourceNotFound('Journal entry');
            if (original.accountCode !== SYSTEM_ACCOUNT_CODES.SUSPENSE_NGN) {
                throw errorResponseMessage.payloadIncorrect('Entry is not a suspense entry');
            }
            if (original.direction !== JOURNAL_DIRECTION.CREDIT) {
                throw errorResponseMessage.payloadIncorrect('Suspense attribution requires a credit entry');
            }
            if (original.reversedBy) {
                throw errorResponseMessage.payloadIncorrect('Entry has already been attributed');
            }

            const wallet = await walletRepository.findByUserAndCurrency(userId, 'NGN', tx);
            if (!wallet) throw errorResponseMessage.resourceNotFound('Wallet for user');
            if (wallet.status !== WALLET_STATUS.ACTIVE) {
                throw errorResponseMessage.payloadIncorrect('Target wallet is not active');
            }

            // Ensure the user's ledger account exists.
            const userAccountCode = userWalletAccountCode(userId, wallet.currency);
            await accountRepository.createIfMissing(
                {
                    code: userAccountCode,
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

            const amount = original.amount;
            const post = await this.post({
                legs: [
                    { accountCode: SYSTEM_ACCOUNT_CODES.SUSPENSE_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount },
                    { accountCode: userAccountCode, direction: JOURNAL_DIRECTION.CREDIT, amount },
                ],
                source: JOURNAL_SOURCE.MANUAL_ATTRIBUTION,
                reference: original.reference,
                description: `Manual attribution of suspense entry to user ${userId}${note ? ` — ${note}` : ''}`,
                externalRef: original.externalRef,
                metadata: { reverses: original.txGroupId, suspenseEntryId: original.id, note, attributedBy: adminId },
                postedBy: adminId,
                tx,
            });

            // Mark the original as reversed so the suspense list hides it.
            await journalRepository.markReversed(original.id, post.txGroupId, tx);

            const credited = await walletRepository.credit(wallet.id, amount, tx, { alsoLedger: true, requireActive: true });
            if (!credited) throw errorResponseMessage.payloadIncorrect('Target wallet is not active');

            // A wallet transaction so the user's history shows the credit.
            await walletTransactionRepository.create(
                {
                    wallet: wallet.id,
                    user: userId,
                    type: WALLET_TRANSACTION_TYPE.FUNDING,
                    status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                    amount,
                    reference: `ATTR-${post.txGroupId.slice(0, 8).toUpperCase()}`,
                    balanceBefore: Math.round((credited.balance - amount) * 100) / 100,
                    balanceAfter: credited.balance,
                    description: `Manually attributed funding (${original.reference})${note ? ` — ${note}` : ''}`,
                    currency: wallet.currency,
                },
                tx
            );

            logger.info('Suspense attribution posted', { originalEntryId: original.id, userId, amount, txGroupId: post.txGroupId });
            return { txGroupId: post.txGroupId, amount, userId };
        });
    }

    /**
     * Convenience helper for callers that don't already have a transaction.
     * Wraps post() in its own transaction. Avoid in money paths that need to
     * coordinate with other writes (use post() with the caller's tx there).
     */
    async postStandalone(opts: Omit<PostOptions, 'tx'>): Promise<PostResult> {
        return withTransaction((tx) => this.post({ ...opts, tx }));
    }
}

// Singleton — service has no per-instance state.
const ledgerService = new LedgerService();
export default ledgerService;
export { LedgerService };
