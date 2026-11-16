import accountRepository from '../repositories/account.repository';
import journalRepository from '../repositories/journal.repository';
import walletRepository from '../repositories/wallet.repository';
import transactionRepository from '../repositories/transaction.repository';
import reconciliationRepository, { type LedgerAlertFilter, type NewReconciliationReport } from '../repositories/reconciliation.repository';
import type { LedgerAlert, ReconciliationReport } from '../types/entities';
import type { AccountProof, InFlightSummary, LedgerProof, SuspenseSummary, WalletProof } from '../db/schema';
import type { PageRequest, Paginated } from '../db/pagination';
import {
    SYSTEM_ACCOUNT_CODES,
    TRANSACTION_STATUS,
    DETAIL_TYPE,
    userWalletAccountCode,
} from '../common/constant';
import logger from '../utils/logger.utils';

const PROOF_TOLERANCE = 0.01;

/**
 * Compare wallet balances, account balances, journal balance, and provider
 * balances. Produces a persisted report any admin can read.
 */
class ReconciliationService {
    /**
     * Run a full reconciliation pass and persist the report. Never throws —
     * any per-section error is captured into the report itself with
     * `status: 'error'` so a half-successful run is still useful.
     */
    async runFullReconciliation(opts: {
        runMode?: 'on_demand' | 'cron';
        runBy?: string;
    } = {}): Promise<ReconciliationReport> {
        const startedAt = new Date();
        const runMode = opts.runMode || 'on_demand';
        logger.info('Reconciliation started', { runMode, runBy: opts.runBy });

        const report: NewReconciliationReport = {
            startedAt,
            runMode,
            runBy: opts.runBy,
            status: 'clean',
        };

        try {
            const [walletProof, accountProof, ledgerProof, inFlight, suspense] = await Promise.all([
                this.proveWalletBalances(),
                this.proveAccountBalances(),
                this.proveJournalBalance(),
                this.summariseInFlight(),
                this.summariseSuspense(),
            ]);

            report.walletProof = walletProof;
            report.accountProof = accountProof;
            report.ledgerProof = ledgerProof;
            report.inFlight = inFlight;
            report.suspense = suspense;

            const hasMismatch =
                walletProof.mismatches.length > 0 ||
                accountProof.mismatches.length > 0 ||
                ledgerProof.unbalancedGroups.length > 0;
            report.status = hasMismatch ? 'mismatch' : 'clean';
        } catch (error) {
            report.status = 'error';
            report.notes = error instanceof Error ? error.message : String(error);
            logger.error('Reconciliation failed', { error: report.notes });
        }

        report.finishedAt = new Date();
        const saved = await reconciliationRepository.createReport(report);
        logger.info('Reconciliation finished', {
            runMode,
            status: saved.status,
            durationMs: saved.finishedAt!.getTime() - saved.startedAt.getTime(),
        });
        return saved;
    }

    /**
     * For each wallet, compare wallet.balance to the sum of its
     * USER_WALLET_NGN:{userId} journal entries. Any drift is a mismatch.
     */
    async proveWalletBalances(): Promise<WalletProof> {
        const wallets = await walletRepository.listAll();
        const mismatches: WalletProof['mismatches'] = [];

        for (const wallet of wallets) {
            const code = userWalletAccountCode(wallet.user, wallet.currency);
            const expected = await this.computeAccountBalanceFromJournal(code, 'liability');
            const actual = wallet.balance;
            const delta = +(actual - expected).toFixed(2);
            if (Math.abs(delta) > PROOF_TOLERANCE) {
                mismatches.push({
                    walletId: wallet.id,
                    userId: wallet.user,
                    expected,
                    actual,
                    delta,
                });
                await this.raiseAlert({
                    severity: 'critical',
                    code: 'wallet_balance_drift',
                    accountCode: code,
                    expected,
                    actual,
                    delta,
                    message: `Wallet ${wallet.id} drifts from journal by ${delta}`,
                    metadata: { walletId: wallet.id, userId: wallet.user },
                });
            }
        }

        return { walletsChecked: wallets.length, mismatches };
    }

    /**
     * For every ledger account, compare account.balance (cached) to the true
     * balance derived from journal entries.
     */
    async proveAccountBalances(): Promise<AccountProof> {
        const accounts = await accountRepository.listAll();
        const mismatches: AccountProof['mismatches'] = [];

        for (const account of accounts) {
            const expected = await this.computeAccountBalanceFromJournal(account.code, account.type);
            const actual = account.balance;
            const delta = +(actual - expected).toFixed(2);
            if (Math.abs(delta) > PROOF_TOLERANCE) {
                mismatches.push({ code: account.code, expected, actual, delta });
                await this.raiseAlert({
                    severity: 'critical',
                    code: 'account_balance_drift',
                    accountCode: account.code,
                    expected,
                    actual,
                    delta,
                    message: `Account ${account.code} cached balance drifts by ${delta}`,
                });
            }
        }

        return { accountsChecked: accounts.length, mismatches };
    }

    /**
     * For every txGroupId in the journal, assert sum(debits) == sum(credits).
     * Unbalanced groups are a critical bug — should never happen if all writes
     * went through LedgerService.post.
     */
    async proveJournalBalance(): Promise<LedgerProof> {
        const groups = await journalRepository.totalsByTxGroup();

        const unbalanced: LedgerProof['unbalancedGroups'] = [];
        for (const g of groups) {
            const delta = +(g.debits - g.credits).toFixed(2);
            if (Math.abs(delta) > PROOF_TOLERANCE) {
                unbalanced.push({ txGroupId: g.txGroupId, debits: g.debits, credits: g.credits, delta });
                await this.raiseAlert({
                    severity: 'critical',
                    code: 'unbalanced_posting',
                    txGroupId: g.txGroupId,
                    expected: g.debits,
                    actual: g.credits,
                    delta,
                    message: `Posting ${g.txGroupId} unbalanced: debits=${g.debits} credits=${g.credits}`,
                });
            }
        }

        return { txGroupsChecked: groups.length, unbalancedGroups: unbalanced };
    }

    /**
     * Count in-flight transactions per provider. Useful for the admin dashboard
     * to see how much money is currently sitting at a provider.
     */
    async summariseInFlight(): Promise<InFlightSummary> {
        const [paystackTransfers, ycPayments, ycCollections] = await Promise.all([
            accountRepository.findByCode(SYSTEM_ACCOUNT_CODES.PAYSTACK_TRANSFER_INFLIGHT_NGN).then((a) => a?.balance || 0),
            // YC-side in-flight is a subset of YC_FLOAT_NGN that has not yet
            // settled. We approximate via pending YC transactions.
            transactionRepository.count({ detailType: DETAIL_TYPE.YELLOWCARD as 'yellowcard', status: TRANSACTION_STATUS.PENDING as 'pending' }),
            transactionRepository.count({ detailType: DETAIL_TYPE.YELLOWCARD as 'yellowcard', status: TRANSACTION_STATUS.PROCESSING as 'processing' }),
        ]);

        return {
            paystackTransfers: typeof paystackTransfers === 'number' ? paystackTransfers : 0,
            ycPayments,
            ycCollections,
        };
    }

    /**
     * How much money is currently held in suspense awaiting attribution, and
     * how many distinct entries are open.
     */
    async summariseSuspense(): Promise<SuspenseSummary> {
        const acc = await accountRepository.findByCode(SYSTEM_ACCOUNT_CODES.SUSPENSE_NGN);
        const totalUnattributed = acc?.balance || 0;
        const count = await journalRepository.countOpenCredits(SYSTEM_ACCOUNT_CODES.SUSPENSE_NGN);
        return { totalUnattributed, count };
    }

    /**
     * Recompute an account's balance directly from the journal. Mirrors the
     * sign convention in LedgerService.post.
     */
    private async computeAccountBalanceFromJournal(
        accountCode: string,
        accountType: string
    ): Promise<number> {
        const { debits, credits } = await journalRepository.totalsByDirection(accountCode);
        const isDebitNormal = accountType === 'asset' || accountType === 'expense';
        const balance = isDebitNormal ? debits - credits : credits - debits;
        return +balance.toFixed(2);
    }

    /** Reports, newest first */
    async listReports(page: PageRequest): Promise<Paginated<ReconciliationReport>> {
        return reconciliationRepository.paginateReports(page);
    }

    async getReport(id: string): Promise<ReconciliationReport | undefined> {
        return reconciliationRepository.findReport(id);
    }

    /** Alerts, newest first */
    async listAlerts(filter: LedgerAlertFilter, page: PageRequest): Promise<Paginated<LedgerAlert>> {
        return reconciliationRepository.paginateAlerts(filter, page);
    }

    async acknowledgeAlert(id: string, adminId?: string): Promise<LedgerAlert | undefined> {
        return reconciliationRepository.acknowledgeAlert(id, adminId);
    }

    private async raiseAlert(opts: {
        severity: 'warning' | 'critical';
        code: string;
        accountCode?: string;
        txGroupId?: string;
        expected?: number;
        actual?: number;
        delta?: number;
        message: string;
        metadata?: Record<string, any>;
    }): Promise<void> {
        try {
            await reconciliationRepository.createAlert(opts);
        } catch (error) {
            logger.error('Failed to write ledger alert', {
                code: opts.code,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}

const reconciliationService = new ReconciliationService();

export default reconciliationService;
export { ReconciliationService };
