import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import BaseController from '../../base-controller';
import RoleMiddleware from '../../../../middlewares/role.middleware';
import JournalEntry from '../../../../models/journal-entry.model';
import Wallet from '../../../../models/wallet.model';
import ledgerService from '../../../../services/ledger.service';
import WalletService from '../../../../services/wallet.service';
import errorResponseMessage from '../../../../common/messages/error-response-message';
import {
    JOURNAL_DIRECTION,
    JOURNAL_SOURCE,
    SYSTEM_ACCOUNT_CODES,
    WALLET_STATUS,
    WALLET_TRANSACTION_TYPE,
    WALLET_TRANSACTION_STATUS,
    userWalletAccountCode,
} from '../../../../common/constant';
import logger from '../../../../utils/logger.utils';

/**
 * Lists every unattributed credit on SUSPENSE_NGN and lets an admin manually
 * attribute it to a user. Attribution posts a balancing journal entry that
 * moves the funds from SUSPENSE_NGN into the user's wallet liability.
 */
class AdminSuspenseController extends BaseController {
    private walletService: WalletService;

    constructor() {
        super();
        this.walletService = new WalletService();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.use(RoleMiddleware.isAdmin);

        this.router.get('/', this.list.bind(this));
        this.router.post('/:journalEntryId/attribute', this.attribute.bind(this));
    }

    /**
     * Open suspense entries: credits to SUSPENSE_NGN that have not yet been
     * reversed by an attribution posting.
     */
    private async list(req: Request, res: Response, next: NextFunction) {
        try {
            const filter: any = {
                accountCode: SYSTEM_ACCOUNT_CODES.SUSPENSE_NGN,
                direction: JOURNAL_DIRECTION.CREDIT,
                reversedBy: { $exists: false },
            };
            const page = parseInt(req.query.page as string) || 1;
            const limit = parseInt(req.query.limit as string) || 25;
            // @ts-ignore — paginate plugin
            const result = await JournalEntry.paginate(filter, {
                page, limit, sort: { postedAt: -1 },
                customLabels: {
                    totalDocs: 'itemsCount', docs: 'data', limit: 'perPage',
                    page: 'currentPage', nextPage: 'next', prevPage: 'prev',
                    totalPages: 'pageCount', pagingCounter: 'serialNumber', meta: 'paginator',
                },
            });
            return this.sendSuccess(res, result);
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Attribute a suspense credit to a user. Posts a balanced reversal:
     *   debit SUSPENSE_NGN, credit USER_WALLET_NGN:{userId}
     * and updates the wallet.balance projection. The original entry is marked
     * `reversedBy` with the new txGroupId so the suspense tray hides it.
     */
    private async attribute(req: Request, res: Response, next: NextFunction) {
        const adminUser = res.locals.user;
        const { journalEntryId } = req.params;
        const { userId, note } = req.body || {};

        if (!userId) {
            return next(errorResponseMessage.payloadIncorrect('userId is required'));
        }

        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            const original = await JournalEntry.findById(journalEntryId).session(session);
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

            const wallet = await Wallet.findOne({ user: userId }).session(session);
            if (!wallet) throw errorResponseMessage.resourceNotFound('Wallet for user');
            if (wallet.status !== WALLET_STATUS.ACTIVE) {
                throw errorResponseMessage.payloadIncorrect('Target wallet is not active');
            }

            // Ensure the user's ledger account exists.
            await this.walletService.getOrCreateWallet(userId);

            const userAccountCode = userWalletAccountCode(userId, wallet.currency);
            const amount = original.amount;

            const post = await ledgerService.post({
                legs: [
                    { accountCode: SYSTEM_ACCOUNT_CODES.SUSPENSE_NGN, direction: JOURNAL_DIRECTION.DEBIT, amount },
                    { accountCode: userAccountCode, direction: JOURNAL_DIRECTION.CREDIT, amount },
                ],
                source: JOURNAL_SOURCE.MANUAL_ATTRIBUTION,
                reference: original.reference,
                description: `Manual attribution of suspense entry to user ${userId}${note ? ` — ${note}` : ''}`,
                externalRef: original.externalRef,
                metadata: {
                    reverses: original.txGroupId,
                    suspenseEntryId: (original._id as any).toString(),
                    note,
                    attributedBy: adminUser?._id?.toString(),
                },
                postedBy: adminUser?._id?.toString(),
                session,
            });

            // Mark the original as reversed so the suspense list hides it.
            await JournalEntry.updateOne(
                { _id: original._id },
                { reversedBy: post.txGroupId },
                { session }
            );

            // Bump wallet.balance projection in the same session.
            await Wallet.updateOne(
                { _id: wallet._id, status: WALLET_STATUS.ACTIVE },
                { $inc: { balance: amount, ledgerBalance: amount } },
                { session }
            );

            // Record a wallet-transaction so the user's history reflects the credit.
            await this.walletService['walletTransactionService'].create({
                wallet: wallet._id,
                user: userId,
                type: WALLET_TRANSACTION_TYPE.FUNDING,
                status: WALLET_TRANSACTION_STATUS.SUCCESSFUL,
                amount,
                reference: `ATTR-${post.txGroupId.slice(0, 8).toUpperCase()}`,
                balanceBefore: wallet.balance,
                balanceAfter: wallet.balance + amount,
                description: `Manually attributed funding (${original.reference})${note ? ` — ${note}` : ''}`,
            }, session);

            await session.commitTransaction();
            logger.info('Suspense attribution posted', {
                originalEntryId: original._id,
                userId,
                amount,
                txGroupId: post.txGroupId,
            });

            return this.sendSuccess(res, { txGroupId: post.txGroupId, amount, userId });
        } catch (error) {
            if (session.inTransaction()) await session.abortTransaction();
            return next(error);
        } finally {
            session.endSession();
        }
    }
}

export default new AdminSuspenseController().router;
