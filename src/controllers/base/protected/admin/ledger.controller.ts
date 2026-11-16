import { Request, Response, NextFunction } from 'express';
import BaseController from '../../base-controller';
import RoleMiddleware from '../../../../middlewares/role.middleware';
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
            const accounts = await ledgerService.searchAccounts({
                type: typeof req.query.type === 'string' && req.query.type ? req.query.type : undefined,
                currency: typeof req.query.currency === 'string' && req.query.currency ? req.query.currency : undefined,
                code: typeof req.query.code === 'string' && req.query.code ? req.query.code : undefined,
            });
            return this.sendSuccess(res, { accounts });
        } catch (error) {
            return next(error);
        }
    }

    private async accountJournal(req: Request, res: Response, next: NextFunction) {
        try {
            const { code } = req.params;
            const account = await ledgerService.findAccount(code);
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
            const q = req.query;
            const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
            const filter = {
                source: text(q.source),
                txGroupId: text(q.txGroupId),
                accountCode: text(q.accountCode),
                externalProvider: text(q.externalProvider),
                externalId: text(q.externalId),
                postedFrom: typeof q.startDate === 'string' ? new Date(q.startDate) : undefined,
                postedTo: typeof q.endDate === 'string' ? new Date(q.endDate) : undefined,
            };

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
            const entries = await ledgerService.getTxGroup(txGroupId);
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
