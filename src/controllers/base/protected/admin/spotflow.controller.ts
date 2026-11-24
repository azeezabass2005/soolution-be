import { Request, Response, NextFunction } from 'express';
import BaseController from '../../base-controller';
import RoleMiddleware from '../../../../middlewares/role.middleware';
import config from '../../../../config/env.config';
import spotflowService, { SPOTFLOW_CURRENCIES, SpotflowCurrency, SpotflowError } from '../../../../services/spotflow.service';
import labPoller from '../../../../services/lab-poller.service';
import errorResponseMessage, { ErrorSeverity } from '../../../../common/messages/error-response-message';

const invalid = (message: string) => errorResponseMessage.createError(400, message, ErrorSeverity.LOW);
const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9 .,&'\-]{1,59}$/;

/**
 * Admin-only Spotflow lab, mounted at /protected/admin/spotflow. Off (404)
 * unless SPOTFLOW_LAB_ENABLED=true. Opens NGN/GHS virtual accounts and reads
 * balances; it can't send money or close an account.
 */
class AdminSpotflowController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.use((_req: Request, _res: Response, next: NextFunction) =>
            config.SPOTFLOW_LAB_ENABLED ? next() : next(errorResponseMessage.createError(404, 'Not found', ErrorSeverity.LOW)));
        this.router.use(RoleMiddleware.can('labs'));
        this.router.get('/', this.overview.bind(this));
        this.router.get('/activity', this.activity.bind(this));
        this.router.post('/activity/check', this.checkNow.bind(this));
        this.router.post('/activity/stop', this.stopWatching.bind(this));
        this.router.get('/accounts', this.listAccounts.bind(this));
        this.router.post('/accounts', this.createStatic.bind(this));
        this.router.get('/accounts/:id/balance', this.balance.bind(this));
        this.router.get('/accounts/:id/transactions', this.transactions.bind(this));
        this.router.post('/dynamic-accounts', this.createDynamic.bind(this));
    }

    private fail(error: any, next: NextFunction) {
        if (error instanceof SpotflowError) {
            return next(errorResponseMessage.createError(error.status >= 400 && error.status < 600 ? error.status : 502, error.message, ErrorSeverity.LOW, { spotflow: error.spotflow }));
        }
        return next(error);
    }

    /** Shared checks for both kinds of account; returns an error message or null */
    private checkCreate(body: any): string | null {
        const { currency, accountName, confirmLive } = body ?? {};
        if (!SPOTFLOW_CURRENCIES.includes(currency)) return `Currency must be ${SPOTFLOW_CURRENCIES.join(' or ')}`;
        if (typeof accountName !== 'string' || !ACCOUNT_NAME.test(accountName.trim())) return 'Enter an account name (2–60 letters, numbers or spaces)';
        if (spotflowService.mode === 'live' && confirmLive !== true) return 'This opens a real account on the live Spotflow business. Confirm to continue.';
        return null;
    }

    /** What the poller has seen: new deposits, status and balance changes */
    private async activity(_req: Request, res: Response) {
        return this.sendSuccess(res, labPoller.status('spotflow'));
    }

    private async checkNow(_req: Request, res: Response) {
        await labPoller.checkAll('spotflow');
        return this.sendSuccess(res, labPoller.status('spotflow'));
    }

    private async stopWatching(_req: Request, res: Response) {
        labPoller.stopWatching('spotflow');
        return this.sendSuccess(res, labPoller.status('spotflow'));
    }

    private async overview(_req: Request, res: Response, next: NextFunction) {
        const mode = spotflowService.mode;
        if (!spotflowService.configured) return this.sendSuccess(res, { configured: false, mode });
        if (!mode) return next(invalid('SPOTFLOW_SECRET_KEY should start with sk_test_ or sk_live_'));
        try {
            return this.sendSuccess(res, { configured: true, mode, currencies: SPOTFLOW_CURRENCIES, balances: await spotflowService.mainBalances() });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private async listAccounts(req: Request, res: Response, next: NextFunction) {
        const currency = req.query.currency as SpotflowCurrency | undefined;
        if (currency && !SPOTFLOW_CURRENCIES.includes(currency)) return next(invalid(`Currency must be ${SPOTFLOW_CURRENCIES.join(' or ')}`));
        try {
            return this.sendSuccess(res, { accounts: await spotflowService.listStaticAccounts(currency) });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private async balance(req: Request, res: Response, next: NextFunction) {
        if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return next(invalid('Account id is not valid'));
        const label = typeof req.query.accountNumber === 'string' && /^\d{6,20}$/.test(req.query.accountNumber) ? req.query.accountNumber : undefined;
        try {
            const balance = await spotflowService.accountBalance(req.params.id);
            // Showing balances when the page loads isn't an action; only ?watch=1 starts watching
            if (req.query.watch === '1') labPoller.watchSpotflowAccount(req.params.id, label);
            return this.sendSuccess(res, { balance });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    /** History of one account; opening it watches the account for new payments */
    private async transactions(req: Request, res: Response, next: NextFunction) {
        if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return next(invalid('Account id is not valid'));
        const label = typeof req.query.label === 'string' ? req.query.label.slice(0, 40) : undefined;
        try {
            const result = await spotflowService.listTransactions(req.params.id);
            labPoller.watchSpotflowAccount(req.params.id, label);
            return this.sendSuccess(res, result);
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private async createStatic(req: Request, res: Response, next: NextFunction) {
        const problem = this.checkCreate(req.body);
        if (problem) return next(invalid(problem));
        try {
            const account = await spotflowService.createStaticAccount(req.body.currency, req.body.accountName.trim());
            labPoller.watchSpotflowAccount(account?.id, account?.accountDetails?.accountNumber, { isNew: true });
            return this.sendSuccess(res, { account }, 201);
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private async createDynamic(req: Request, res: Response, next: NextFunction) {
        const problem = this.checkCreate(req.body);
        if (problem) return next(invalid(problem));
        const amount = Number(req.body.amount);
        if (!isFinite(amount) || amount < 1 || amount > 10_000_000) return next(invalid('Amount must be between 1 and 10,000,000'));
        const expiresIn = req.body.expiresIn === undefined || req.body.expiresIn === '' ? undefined : Number(req.body.expiresIn);
        if (expiresIn !== undefined && (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 30)) return next(invalid('Expiry must be 1 to 30 minutes'));
        try {
            const account = await spotflowService.createDynamicAccount(req.body.currency, req.body.accountName.trim(), Math.round(amount * 100) / 100, expiresIn);
            const mainId = await spotflowService.mainAccountId(req.body.currency).catch(() => undefined);
            if (mainId) labPoller.watchSpotflowAccount(mainId, `main ${req.body.currency} balance`);
            return this.sendSuccess(res, { account }, 201);
        } catch (error) {
            return this.fail(error, next);
        }
    }
}

export default new AdminSpotflowController().router;
