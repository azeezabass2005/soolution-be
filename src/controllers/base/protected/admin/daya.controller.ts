import { Request, Response, NextFunction } from 'express';
import BaseController from '../../base-controller';
import RoleMiddleware from '../../../../middlewares/role.middleware';
import config from '../../../../config/env.config';
import dayaService, { DAYA_SANDBOX_SCENARIOS, DAYA_SETTLEMENTS, DAYA_VA_CURRENCIES, DayaAccountType, DayaError } from '../../../../services/daya.service';
import labPoller from '../../../../services/lab-poller.service';
import errorResponseMessage, { ErrorSeverity } from '../../../../common/messages/error-response-message';

const invalid = (message: string) => errorResponseMessage.createError(400, message, ErrorSeverity.LOW);
const UUID = /^[0-9a-f-]{36}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME = /^[A-Za-z][A-Za-z .'\-]{0,99}$/;
/** Fields that never reach the request log */
const SECRET_FIELDS = ['bvn', 'phoneNumber', 'imageUrl'];

/** First account number among a funding account's ACTIVE instructions */
const accountNumberOf = (a: any) => (a?.instructions || []).find((i: any) => i?.account_number && i?.status === 'ACTIVE')?.account_number
    || (a?.instructions || []).find((i: any) => i?.account_number)?.account_number;

/**
 * Admin-only Daya lab, mounted at /protected/admin/daya. Off (404) unless
 * DAYA_LAB_ENABLED=true. Creates customers, NGN funding accounts and USD/EUR
 * virtual accounts and reads deposits and balances; it can't send money out.
 */
class AdminDayaController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    /** Same request log as every controller, minus BVN, phone and selfie */
    protected initializeMiddleware(): void {
        this.router.use((req: Request, _res: Response, next: NextFunction) => {
            let body = req.body;
            if (body && typeof body === 'object' && SECRET_FIELDS.some((f) => f in body)) {
                body = { ...body };
                for (const f of SECRET_FIELDS) if (f in body) body[f] = '[masked]';
            }
            this.logger.http(`${req.method} ${req.path}`, { body, query: req.query, params: req.params, ip: req.ip });
            next();
        });
    }

    protected setupRoutes(): void {
        this.router.use((_req: Request, _res: Response, next: NextFunction) =>
            config.DAYA_LAB_ENABLED ? next() : next(errorResponseMessage.createError(404, 'Not found', ErrorSeverity.LOW)));
        this.router.use(RoleMiddleware.isAdmin);
        this.router.get('/', this.overview.bind(this));
        this.router.get('/activity', this.activity.bind(this));
        this.router.post('/activity/check', this.checkNow.bind(this));
        this.router.post('/activity/stop', this.stopWatching.bind(this));
        this.router.get('/fees', this.fees.bind(this));
        this.router.get('/customers', this.listCustomers.bind(this));
        this.router.post('/customers', this.createCustomer.bind(this));
        this.router.get('/customers/:id', this.getCustomer.bind(this));
        this.router.post('/customers/:id/tier1', this.tier1.bind(this));
        this.router.get('/funding-accounts', this.listFundingAccounts.bind(this));
        this.router.post('/funding-accounts', this.createFundingAccount.bind(this));
        this.router.get('/funding-accounts/:id/deposits', this.fundingDeposits.bind(this));
        this.router.post('/funding-accounts/:id/simulate', this.simulate.bind(this));
        this.router.get('/virtual-accounts', this.listVirtualAccounts.bind(this));
        this.router.post('/virtual-accounts', this.createVirtualAccount.bind(this));
        this.router.get('/virtual-accounts/:id/deposits', this.virtualDeposits.bind(this));
    }

    private fail(error: any, next: NextFunction) {
        if (error instanceof DayaError) {
            return next(errorResponseMessage.createError(error.status >= 400 && error.status < 600 ? error.status : 502, error.message, ErrorSeverity.LOW, { daya: error.daya }));
        }
        return next(error);
    }

    /** On a live key every write needs an explicit tick in the tab */
    private liveCheck(body: any, what: string): string | null {
        return dayaService.mode === 'live' && body?.confirmLive !== true ? `This ${what} on the live Daya business. Confirm to continue.` : null;
    }

    private async activity(_req: Request, res: Response) {
        return this.sendSuccess(res, labPoller.status('daya'));
    }

    private async checkNow(_req: Request, res: Response) {
        await labPoller.checkAll('daya');
        return this.sendSuccess(res, labPoller.status('daya'));
    }

    private async stopWatching(_req: Request, res: Response) {
        labPoller.stopWatching('daya');
        return this.sendSuccess(res, labPoller.status('daya'));
    }

    private async overview(_req: Request, res: Response, next: NextFunction) {
        const mode = dayaService.mode;
        if (!dayaService.configured) return this.sendSuccess(res, { configured: false, mode });
        if (!mode) return next(invalid('DAYA_SECRET_KEY should start with sk_sandbox_ or sk_live_'));
        try {
            const [balance, funding] = await Promise.all([dayaService.merchantBalance(), dayaService.merchantFunding()]);
            return this.sendSuccess(res, {
                configured: true,
                mode,
                host: dayaService.baseUrl,
                balance,
                funding,
                settlements: DAYA_SETTLEMENTS,
                scenarios: DAYA_SANDBOX_SCENARIOS,
            });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    /** Fee table, current NGN rates and, with ?amount=, an NGN → USDC quote. Prices only. */
    private async fees(req: Request, res: Response, next: NextFunction) {
        const amount = Number(req.query.amount);
        try {
            const [fees, usd, usdc] = await Promise.all([
                dayaService.fees(),
                dayaService.rate('USD', 'BUY').catch((e) => ({ error: e.message })),
                dayaService.rate('USDC', 'BUY').catch((e) => ({ error: e.message })),
            ]);
            let quote: any = null;
            if (isFinite(amount) && amount >= 100 && amount <= 100_000_000) {
                quote = await dayaService.quote(amount.toFixed(2), 'USDC', 'BASE').catch((e) => ({ error: e.message }));
            }
            return this.sendSuccess(res, { fees, rates: { usd, usdc }, quote });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private async listCustomers(_req: Request, res: Response, next: NextFunction) {
        try {
            return this.sendSuccess(res, { customers: await dayaService.listCustomers() });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    /** The customer, their NGN balance (when Daya has it on) and their accounts */
    private async getCustomer(req: Request, res: Response, next: NextFunction) {
        if (!UUID.test(req.params.id)) return next(invalid('Customer id is not valid'));
        try {
            const customer = await dayaService.getCustomer(req.params.id);
            const balances = await dayaService.customerBalances(req.params.id).catch((e) => ({ error: e.message }));
            return this.sendSuccess(res, { customer, balances });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private async createCustomer(req: Request, res: Response, next: NextFunction) {
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const firstName = typeof req.body?.firstName === 'string' ? req.body.firstName.trim() : '';
        const lastName = typeof req.body?.lastName === 'string' ? req.body.lastName.trim() : '';
        if (!EMAIL.test(email)) return next(invalid('Enter a valid email'));
        if ((firstName && !NAME.test(firstName)) || (lastName && !NAME.test(lastName))) return next(invalid('Names can only use letters, spaces, apostrophes and hyphens'));
        const live = this.liveCheck(req.body, 'creates a real customer');
        if (live) return next(invalid(live));
        try {
            return this.sendSuccess(res, { customer: await dayaService.createCustomer({ email, firstName, lastName }) }, 201);
        } catch (error) {
            return this.fail(error, next);
        }
    }

    /** Tier 1 (BVN + selfie), needed for permanent NGN accounts */
    private async tier1(req: Request, res: Response, next: NextFunction) {
        if (!UUID.test(req.params.id)) return next(invalid('Customer id is not valid'));
        const { bvn, phoneNumber, imageUrl } = req.body ?? {};
        if (typeof bvn !== 'string' || !/^\d{11}$/.test(bvn)) return next(invalid('BVN must be exactly 11 digits'));
        if (phoneNumber !== undefined && phoneNumber !== '' && (typeof phoneNumber !== 'string' || !/^(\+234\d{10}|0\d{10})$/.test(phoneNumber))) {
            return next(invalid('Phone number must be 11 digits (080…) or +234…'));
        }
        if (typeof imageUrl !== 'string' || !(/^data:image\/(jpeg|jpg|png);base64,/.test(imageUrl) || /^https:\/\//.test(imageUrl))) {
            return next(invalid('Add a JPG or PNG selfie'));
        }
        // Daya caps the decoded image at 1 MiB
        if (imageUrl.startsWith('data:') && (imageUrl.length - imageUrl.indexOf(',') - 1) * 0.75 > 1024 * 1024) return next(invalid('The selfie must be 1 MB or smaller'));
        const live = this.liveCheck(req.body, 'sends a real BVN for verification');
        if (live) return next(invalid(live));
        try {
            const customer = await dayaService.submitTier1(req.params.id, { bvn, phoneNumber: phoneNumber || undefined, imageUrl });
            return this.sendSuccess(res, { customer });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private async listFundingAccounts(req: Request, res: Response, next: NextFunction) {
        const customerId = typeof req.query.customerId === 'string' && UUID.test(req.query.customerId) ? req.query.customerId : undefined;
        try {
            return this.sendSuccess(res, { accounts: await dayaService.listFundingAccounts(customerId) });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private async createFundingAccount(req: Request, res: Response, next: NextFunction) {
        const { type, customerId, settlement } = req.body ?? {};
        if (type !== 'PERMANENT' && type !== 'TEMPORARY') return next(invalid('Type must be PERMANENT or TEMPORARY'));
        if (typeof customerId !== 'string' || !UUID.test(customerId)) return next(invalid('Pick a customer'));
        const allowed: readonly string[] = DAYA_SETTLEMENTS[type as DayaAccountType];
        if (!allowed.includes(settlement)) return next(invalid(`Settlement must be one of ${allowed.join(', ')}`));
        let amount: number | undefined;
        if (type === 'TEMPORARY') {
            amount = Number(req.body.amount);
            if (!Number.isInteger(amount) || amount < 100 || amount > 15_000_000) return next(invalid('Amount must be a whole number of naira between 100 and 15,000,000'));
        }
        const live = this.liveCheck(req.body, 'opens a real NGN account');
        if (live) return next(invalid(live));
        try {
            const account = await dayaService.createFundingAccount({ type, customerId, settlement, amount });
            labPoller.watchDayaAccount('fa', account?.id, accountNumberOf(account), { isNew: true });
            return this.sendSuccess(res, { account }, 201);
        } catch (error) {
            return this.fail(error, next);
        }
    }

    /** Deposits into one NGN account over the last 30 days; opening them watches the account */
    private async fundingDeposits(req: Request, res: Response, next: NextFunction) {
        if (!UUID.test(req.params.id)) return next(invalid('Account id is not valid'));
        const label = typeof req.query.label === 'string' ? req.query.label.slice(0, 40) : undefined;
        try {
            const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
            const deposits = (await dayaService.listDeposits(from)).filter((d: any) => d.funding_account_id === req.params.id);
            labPoller.watchDayaAccount('fa', req.params.id, label);
            return this.sendSuccess(res, { deposits });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    /** Sandbox only: a fake payment into a funding account */
    private async simulate(req: Request, res: Response, next: NextFunction) {
        if (!UUID.test(req.params.id)) return next(invalid('Account id is not valid'));
        if (dayaService.mode !== 'sandbox') return next(invalid('The deposit simulator only works with a sandbox key'));
        const scenario = req.body?.scenario || 'COMPLETED';
        if (!(DAYA_SANDBOX_SCENARIOS as readonly string[]).includes(scenario)) return next(invalid(`Scenario must be one of ${DAYA_SANDBOX_SCENARIOS.join(', ')}`));
        try {
            const result = await dayaService.simulateDeposit(req.params.id, scenario);
            labPoller.watchDayaAccount('fa', req.params.id, typeof req.body?.label === 'string' ? req.body.label.slice(0, 40) : undefined);
            return this.sendSuccess(res, { result });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private async listVirtualAccounts(req: Request, res: Response, next: NextFunction) {
        const customerId = typeof req.query.customerId === 'string' && UUID.test(req.query.customerId) ? req.query.customerId : undefined;
        try {
            return this.sendSuccess(res, { accounts: await dayaService.listVirtualAccounts(customerId) });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private async createVirtualAccount(req: Request, res: Response, next: NextFunction) {
        const { customerId, currency } = req.body ?? {};
        if (typeof customerId !== 'string' || !UUID.test(customerId)) return next(invalid('Pick a customer'));
        if (!(DAYA_VA_CURRENCIES as readonly string[]).includes(currency)) return next(invalid('Currency must be usd or eur'));
        const live = this.liveCheck(req.body, `opens a real ${String(currency).toUpperCase()} account`);
        if (live) return next(invalid(live));
        try {
            const account = await dayaService.createVirtualAccount(customerId, currency);
            const d = account?.deposit_instructions;
            labPoller.watchDayaAccount('va', account?.id, d?.bank_account_number || d?.iban, { isNew: true });
            return this.sendSuccess(res, { account }, 201);
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private async virtualDeposits(req: Request, res: Response, next: NextFunction) {
        if (!UUID.test(req.params.id)) return next(invalid('Account id is not valid'));
        const label = typeof req.query.label === 'string' ? req.query.label.slice(0, 40) : undefined;
        try {
            const deposits = await dayaService.listVirtualAccountDeposits(req.params.id);
            labPoller.watchDayaAccount('va', req.params.id, label);
            return this.sendSuccess(res, { deposits });
        } catch (error) {
            return this.fail(error, next);
        }
    }
}

export default new AdminDayaController().router;
