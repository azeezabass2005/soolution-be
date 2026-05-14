import { Request, Response, NextFunction } from 'express';
import BaseController from '../../base-controller';
import RoleMiddleware from '../../../../middlewares/role.middleware';
import Account from '../../../../models/account.model';
import JournalEntry from '../../../../models/journal-entry.model';
import ledgerService from '../../../../services/ledger.service';
import errorResponseMessage from '../../../../common/messages/error-response-message';

/**
 * Admin endpoints for browsing the chart of accounts and the journal.
 * Mounted at /protected/admin/ledger. Every route is admin-gated.
 */
class AdminLedgerController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.use(RoleMiddleware.isAdmin);

        // Chart of accounts (filterable by type / currency)
        this.router.get('/accounts', this.listAccounts.bind(this));

        // Journal entries for one account, paginated
        this.router.get('/accounts/:code/journal', this.accountJournal.bind(this));

        // Recompute and persist an account's cached balance from the journal
        this.router.post('/accounts/:code/refresh-balance', this.refreshAccountBalance.bind(this));

        // Global journal explorer
        this.router.get('/journal', this.listJournal.bind(this));

        // All legs of a single posting
        this.router.get('/journal/:txGroupId', this.getTxGroup.bind(this));
    }

    private async listAccounts(req: Request, res: Response, next: NextFunction) {
        try {
            const filter: any = {};
            if (typeof req.query.type === 'string' && req.query.type) filter.type = req.query.type;
            if (typeof req.query.currency === 'string' && req.query.currency) filter.currency = req.query.currency.toUpperCase();
            if (typeof req.query.code === 'string' && req.query.code) {
                filter.code = { $regex: req.query.code, $options: 'i' };
            }

            const accounts = await Account.find(filter).sort({ type: 1, code: 1 }).limit(500);
            return this.sendSuccess(res, { accounts });
        } catch (error) {
            return next(error);
        }
    }

    private async accountJournal(req: Request, res: Response, next: NextFunction) {
        try {
            const { code } = req.params;
            const account = await Account.findOne({ code });
            if (!account) throw errorResponseMessage.resourceNotFound(`Account ${code}`);

            const page = parseInt(req.query.page as string) || 1;
            const limit = parseInt(req.query.limit as string) || 25;
            const result = await ledgerService.listEntries({ accountCode: code }, { page, limit });
            return this.sendSuccess(res, { account, ...result });
        } catch (error) {
            return next(error);
        }
    }

    private async refreshAccountBalance(req: Request, res: Response, next: NextFunction) {
        try {
            const { code } = req.params;
            const balance = await ledgerService.refreshAccountBalance(code);
            return this.sendSuccess(res, { code, balance });
        } catch (error) {
            return next(error);
        }
    }

    private async listJournal(req: Request, res: Response, next: NextFunction) {
        try {
            const filter: any = {};
            if (typeof req.query.source === 'string' && req.query.source) filter.source = req.query.source;
            if (typeof req.query.txGroupId === 'string' && req.query.txGroupId) filter.txGroupId = req.query.txGroupId;
            if (typeof req.query.accountCode === 'string' && req.query.accountCode) filter.accountCode = req.query.accountCode;
            if (typeof req.query.externalProvider === 'string' && req.query.externalProvider) {
                filter['externalRef.provider'] = req.query.externalProvider;
            }
            if (typeof req.query.externalId === 'string' && req.query.externalId) {
                filter['externalRef.id'] = req.query.externalId;
            }

            const dateRange: any = {};
            if (typeof req.query.startDate === 'string') dateRange.$gte = new Date(req.query.startDate);
            if (typeof req.query.endDate === 'string') dateRange.$lte = new Date(req.query.endDate);
            if (Object.keys(dateRange).length > 0) filter.postedAt = dateRange;

            const page = parseInt(req.query.page as string) || 1;
            const limit = parseInt(req.query.limit as string) || 25;
            const result = await ledgerService.listEntries(filter, { page, limit });
            return this.sendSuccess(res, result);
        } catch (error) {
            return next(error);
        }
    }

    private async getTxGroup(req: Request, res: Response, next: NextFunction) {
        try {
            const { txGroupId } = req.params;
            const entries = await JournalEntry.find({ txGroupId }).sort({ direction: 1, accountCode: 1 });
            if (entries.length === 0) {
                throw errorResponseMessage.resourceNotFound(`Journal posting ${txGroupId}`);
            }
            return this.sendSuccess(res, { txGroupId, entries });
        } catch (error) {
            return next(error);
        }
    }
}

export default new AdminLedgerController().router;
