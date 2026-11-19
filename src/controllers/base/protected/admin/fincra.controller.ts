import { Request, Response, NextFunction } from 'express';
import BaseController from '../../base-controller';
import RoleMiddleware from '../../../../middlewares/role.middleware';
import config from '../../../../config/env.config';
import crypto from 'crypto';
import fincraService, { FINCRA_CHECKOUT_CURRENCIES, FINCRA_CHECKOUT_METHODS, FINCRA_VA_CHANNELS, FincraCheckoutCurrency, FincraError } from '../../../../services/fincra.service';
import labPoller from '../../../../services/lab-poller.service';
import errorResponseMessage, { ErrorSeverity } from '../../../../common/messages/error-response-message';
import { redactForLog } from "../../../../utils/redact.utils";

const invalid = (message: string) => errorResponseMessage.createError(400, message, ErrorSeverity.LOW);
const NAME = /^[A-Za-z][A-Za-z'\- ]{0,49}$/;

/**
 * Admin-only Fincra lab, mounted at /protected/admin/fincra. Off (404) unless
 * FINCRA_LAB_ENABLED=true. Nothing here can send money: it reads the business,
 * opens NGN virtual accounts, lists their deposits, creates payment links
 * (money in) and prices fees.
 */
class AdminFincraController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    /** Same request log as every controller, without the BVN */
    protected initializeMiddleware(): void {
        this.router.use((req: Request, _res: Response, next: NextFunction) => {
            const body = req.body && typeof req.body === 'object' && 'bvn' in req.body ? { ...req.body, bvn: '[masked]' } : req.body;
            this.logger.http(`${req.method} ${req.path}`, { body: redactForLog(body), query: redactForLog(req.query), params: req.params, ip: req.ip });
            next();
        });
    }

    protected setupRoutes(): void {
        this.router.use((_req: Request, _res: Response, next: NextFunction) =>
            config.FINCRA_LAB_ENABLED ? next() : next(errorResponseMessage.createError(404, 'Not found', ErrorSeverity.LOW)));
        this.router.use(RoleMiddleware.isAdmin);
        this.router.get('/', this.overview.bind(this));
        this.router.get('/activity', this.activity.bind(this));
        this.router.post('/activity/check', this.checkNow.bind(this));
        this.router.post('/activity/stop', this.stopWatching.bind(this));
        this.router.get('/virtual-accounts', this.listAccounts.bind(this));
        this.router.post('/virtual-accounts', this.createAccount.bind(this));
        this.router.get('/virtual-accounts/:id/deposits', this.deposits.bind(this));
        this.router.get('/fees', this.fees.bind(this));
        this.router.get('/checkouts', this.listCheckouts.bind(this));
        this.router.post('/checkouts', this.createCheckout.bind(this));
        this.router.get('/checkouts/:reference', this.checkout.bind(this));
    }

    private fail(error: any, next: NextFunction) {
        if (error instanceof FincraError) {
            return next(errorResponseMessage.createError(error.status >= 400 && error.status < 600 ? error.status : 502, error.message, ErrorSeverity.LOW, { fincra: error.fincra }));
        }
        return next(error);
    }

    /** What the poller has seen: new deposits, status and balance changes */
    private async activity(_req: Request, res: Response) {
        return this.sendSuccess(res, labPoller.status('fincra'));
    }

    private async checkNow(_req: Request, res: Response) {
        await labPoller.checkAll('fincra');
        return this.sendSuccess(res, labPoller.status('fincra'));
    }

    private async stopWatching(_req: Request, res: Response) {
        labPoller.stopWatching('fincra');
        return this.sendSuccess(res, labPoller.status('fincra'));
    }

    private async overview(_req: Request, res: Response, next: NextFunction) {
        const environment = fincraService.environment;
        if (!fincraService.configured) return this.sendSuccess(res, { environment, configured: false });
        try {
            const b = await fincraService.getBusiness();
            return this.sendSuccess(res, {
                environment,
                configured: true,
                channels: FINCRA_VA_CHANNELS,
                checkout: {
                    ready: fincraService.checkoutConfigured,
                    currencies: FINCRA_CHECKOUT_CURRENCIES,
                    methods: FINCRA_CHECKOUT_METHODS,
                },
                business: {
                    id: b._id,
                    name: b.name,
                    country: b.country,
                    status: b.status,
                    isKYCApproved: b.isKYCApproved,
                    feeBearer: b.settings?.feeBearer,
                    settlementDestination: b.settings?.settlementDestination,
                    settlementSettings: b.settlementSettings ?? null,
                    webhookEnabled: b.settings?.enableWebhook,
                },
            });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private creatingLink = new Set<string>();

    /**
     * Payment link (hosted checkout). Paying it puts money into the Fincra
     * balance of that currency; nothing goes out.
     */
    private async createCheckout(req: Request, res: Response, next: NextFunction) {
        const { currency, amount, customerName, customerEmail, customerPhone, paymentMethods, feeBearer, confirmLive } = req.body ?? {};
        if (!FINCRA_CHECKOUT_CURRENCIES.includes(currency)) return next(invalid(`Currency must be ${FINCRA_CHECKOUT_CURRENCIES.join(' or ')}`));
        const cur = currency as FincraCheckoutCurrency;
        if (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000) return next(invalid('Amount must be a whole number from 1 to 1,000,000'));
        if (typeof customerName !== 'string' || !/^[A-Za-z][A-Za-z'\- ]{1,59}$/.test(customerName.trim())) return next(invalid("Enter the payer's name"));
        if (typeof customerEmail !== 'string' || !/^\S+@\S+\.\S+$/.test(customerEmail)) return next(invalid("Enter the payer's email"));
        if (customerPhone !== undefined && customerPhone !== '' && (typeof customerPhone !== 'string' || !/^\+?\d{9,15}$/.test(customerPhone))) return next(invalid('Phone number is not valid'));
        const methods: string[] = Array.isArray(paymentMethods) && paymentMethods.length ? paymentMethods : FINCRA_CHECKOUT_METHODS[cur];
        if (!methods.every((m) => FINCRA_CHECKOUT_METHODS[cur].includes(m))) return next(invalid(`${cur} links can use ${FINCRA_CHECKOUT_METHODS[cur].join(' or ')}`));
        if (feeBearer !== 'customer' && feeBearer !== 'business') return next(invalid('Choose who pays the fee'));
        if (fincraService.environment === 'live' && confirmLive !== true) {
            return next(invalid('This creates a real payment link on the live Fincra business. Confirm to continue.'));
        }

        const lock = `${cur}:${amount}:${customerEmail.toLowerCase()}`;
        if (this.creatingLink.has(lock)) return next(errorResponseMessage.createError(409, 'The same payment link is already being created', ErrorSeverity.LOW));
        this.creatingLink.add(lock);
        try {
            const reference = `sp-lab-${cur.toLowerCase()}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
            const created = await fincraService.createCheckout({
                currency: cur,
                amount,
                customer: { name: customerName.trim(), email: customerEmail.trim(), ...(customerPhone ? { phoneNumber: customerPhone } : {}) },
                paymentMethods: methods,
                feeBearer,
                reference,
                redirectUrl: `${config.FRONTEND_URL}/dashboard/admin/fincra`,
            });
            // Fincra's own price for the first method; failing to price doesn't stop the link
            const feeEstimate = await fincraService.checkoutFee(methods[0] as any, amount, cur)
                .then((d: any) => ({ fee: d?.fee, vat: d?.vat, method: methods[0] }))
                .catch(() => null);
            const checkout = {
                reference,
                link: created.link,
                currency: cur,
                amount,
                customerName: customerName.trim(),
                paymentMethods: methods,
                feeBearer,
                feeEstimate,
                createdAt: new Date().toISOString(),
                status: 'created',
            };
            labPoller.trackCheckout(checkout);
            return this.sendSuccess(res, { checkout }, 201);
        } catch (error) {
            return this.fail(error, next);
        } finally {
            this.creatingLink.delete(lock);
        }
    }

    private async listCheckouts(_req: Request, res: Response) {
        return this.sendSuccess(res, { checkouts: labPoller.listCheckouts() });
    }

    private async checkout(req: Request, res: Response, next: NextFunction) {
        if (!/^[\w-]{3,80}$/.test(req.params.reference)) return next(invalid('Reference is not valid'));
        try {
            return this.sendSuccess(res, { checkout: await labPoller.refreshCheckout(req.params.reference) });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private async listAccounts(_req: Request, res: Response, next: NextFunction) {
        try {
            return this.sendSuccess(res, await fincraService.listVirtualAccounts());
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private async createAccount(req: Request, res: Response, next: NextFunction) {
        const { firstName, lastName, email, bvn, channel, confirmLive } = req.body ?? {};
        if (typeof firstName !== 'string' || !NAME.test(firstName.trim())) return next(invalid('Enter the first name exactly as it is on the BVN'));
        if (typeof lastName !== 'string' || !NAME.test(lastName.trim())) return next(invalid('Enter the last name exactly as it is on the BVN'));
        if (typeof bvn !== 'string' || !/^\d{11}$/.test(bvn)) return next(invalid('BVN must be 11 digits'));
        if (email !== undefined && email !== '' && (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email))) return next(invalid('Email is not valid'));
        if (channel !== undefined && channel !== '' && !FINCRA_VA_CHANNELS.includes(channel)) return next(invalid(`Bank must be one of ${FINCRA_VA_CHANNELS.join(', ')}`));
        if (fincraService.environment === 'live' && confirmLive !== true) {
            return next(invalid('This opens a real bank account on the live Fincra business. Confirm to continue.'));
        }
        try {
            const account = await fincraService.createVirtualAccount({
                firstName: firstName.trim(),
                lastName: lastName.trim(),
                bvn,
                email: email || undefined,
                channel: channel || undefined,
            });
            labPoller.watchFincraAccount(account?._id || account?.id, account?.accountInformation?.accountNumber || account?.accountNumber, { isNew: true });
            return this.sendSuccess(res, { account }, 201);
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private async deposits(req: Request, res: Response, next: NextFunction) {
        try {
            const accountNumber = typeof req.query.accountNumber === 'string' ? req.query.accountNumber : undefined;
            const deposits = await fincraService.listDeposits(req.params.id, accountNumber);
            labPoller.watchFincraAccount(req.params.id, accountNumber);
            return this.sendSuccess(res, { deposits });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    /** Prices a payment of `amount` NGN each way in; and a payout of it out */
    private async fees(req: Request, res: Response, next: NextFunction) {
        const amount = Number(req.query.amount);
        if (!isFinite(amount) || amount < 100 || amount > 100_000_000) return next(invalid('Amount must be between 100 and 100,000,000 NGN'));
        const settle = async (fn: () => Promise<any>) => {
            try {
                return { ok: true, data: await fn() };
            } catch (error: any) {
                return { ok: false, error: error?.message || 'Failed', fincra: error?.fincra };
            }
        };
        const [bankTransfer, card, payout] = await Promise.all([
            settle(() => fincraService.checkoutFee('bank_transfer', amount)),
            settle(() => fincraService.checkoutFee('card', amount)),
            settle(() => fincraService.payoutQuote(amount)),
        ]);
        return this.sendSuccess(res, { amount, checkout: { bankTransfer, card }, payout });
    }
}

export default new AdminFincraController().router;
