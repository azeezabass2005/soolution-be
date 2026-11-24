import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import BaseController from '../../base-controller';
import RoleMiddleware from '../../../../middlewares/role.middleware';
import config from '../../../../config/env.config';
import hyperRailsService, { HYPERRAILS_COUNTRY, HYPERRAILS_LAB_CURRENCIES, HyperRailsError, HyperRailsLabCurrency } from '../../../../services/hyperrails.service';
import errorResponseMessage, { ErrorSeverity } from '../../../../common/messages/error-response-message';
import { redactForLog } from '../../../../utils/redact.utils';

const invalid = (message: string) => errorResponseMessage.createError(400, message, ErrorSeverity.LOW);
const ID = /^[A-Za-z0-9_-]{6,100}$/;
const PROVIDER = /^[a-z0-9_-]{2,40}$/;
const BANK_CODE = /^[A-Za-z0-9_-]{2,40}$/;
const NAME = /^[A-Za-z][A-Za-z .'\-]{1,99}$/;
/** Fields that never reach the request log */
const SECRET_FIELDS = ['phoneNumber', 'accountNumber', 'otp'];

/** On a live key, the most a lab payout can send (local currency) */
const LIVE_PAYOUT_CAP: Record<HyperRailsLabCurrency, number> = { GHS: 50, KES: 500 };

const labCurrency = (value: unknown): HyperRailsLabCurrency | null => {
    const c = String(value || '').toUpperCase();
    return (HYPERRAILS_LAB_CURRENCIES as readonly string[]).includes(c) ? (c as HyperRailsLabCurrency) : null;
};

/** "0244123456" / "+233244123456" → "0244123456" for GH; "+254712345678" / "0712345678" → "254712345678" for KE */
const localPhone = (currency: HyperRailsLabCurrency, raw: unknown): string | null => {
    let digits = String(raw || '').replace(/\D/g, '');
    const dial = currency === 'GHS' ? '233' : '254';
    if (digits.startsWith(dial)) digits = digits.slice(3);
    if (digits.startsWith('0')) digits = digits.slice(1);
    if (!/^\d{9}$/.test(digits)) return null;
    // Ghana's docs use the local 0-number; Kenya's mobile money uses the 254 number
    return currency === 'GHS' ? `0${digits}` : `${dial}${digits}`;
};

/**
 * Admin-only HyperRails lab, mounted at /protected/admin/hyperrails. Off (404)
 * unless HYPERRAILS_LAB_ENABLED=true. For GHS and KES: balances, rates,
 * mobile money pay-ins that settle in naira, and bank payouts.
 * On a live key every money-moving call needs an explicit confirmation, and
 * payouts are capped.
 */
class AdminHyperRailsController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    protected initializeMiddleware(): void {
        this.router.use((req: Request, _res: Response, next: NextFunction) => {
            let body = req.body;
            if (body && typeof body === 'object' && SECRET_FIELDS.some((f) => f in body)) {
                body = { ...body };
                for (const f of SECRET_FIELDS) if (f in body) body[f] = '[masked]';
            }
            this.logger.http(`${req.method} ${req.path}`, { body: redactForLog(body), query: redactForLog(req.query), params: req.params, ip: req.ip });
            next();
        });
    }

    protected setupRoutes(): void {
        this.router.use((_req: Request, _res: Response, next: NextFunction) =>
            config.HYPERRAILS_LAB_ENABLED ? next() : next(errorResponseMessage.createError(404, 'Not found', ErrorSeverity.LOW)));
        this.router.use(RoleMiddleware.can('labs'));
        this.router.get('/', this.overview.bind(this));
        this.router.get('/coverage/:currency', this.coverage.bind(this));
        this.router.post('/quotes', this.quote.bind(this));
        this.router.get('/quotes/:id', this.quoteStatus.bind(this));
        this.router.post('/quotes/:id/charge', this.charge.bind(this));
        this.router.post('/quotes/:id/authorize', this.authorize.bind(this));
        this.router.post('/quotes/:id/complete', this.complete.bind(this));
        this.router.post('/quotes/:id/cancel', this.cancel.bind(this));
        this.router.post('/payouts', this.payout.bind(this));
        this.router.get('/payouts/:reference', this.payoutStatus.bind(this));
    }

    private fail(error: any, next: NextFunction) {
        if (error instanceof HyperRailsError) {
            return next(errorResponseMessage.createError(error.status >= 400 && error.status < 600 ? error.status : 502, error.message, ErrorSeverity.LOW, { hyperrails: error.hyperrails }));
        }
        return next(error);
    }

    private liveCheck(body: any, what: string): string | null {
        return hyperRailsService.mode === 'live' && body?.confirmLive !== true ? `This ${what} on the live HyperRails business. Confirm to continue.` : null;
    }

    /** Mode, the GHS / KES / NGN accounts, and the published rates to and from naira */
    private async overview(_req: Request, res: Response, next: NextFunction) {
        const mode = hyperRailsService.mode;
        if (!hyperRailsService.configured) return this.sendSuccess(res, { configured: false, mode, currencies: HYPERRAILS_LAB_CURRENCIES });
        if (!mode) return next(invalid('HYPERRAILS_SECRET_KEY should start with sk_test_ or sk_live_'));
        try {
            const balances = await hyperRailsService.balances();
            const rates: Record<string, any> = {};
            await Promise.all(HYPERRAILS_LAB_CURRENCIES.flatMap((c) => [
                hyperRailsService.rate(c, 'NGN').then((r) => { rates[`${c}-NGN`] = r; }).catch((e) => { rates[`${c}-NGN`] = { error: e.message }; }),
                hyperRailsService.rate('NGN', c).then((r) => { rates[`NGN-${c}`] = r; }).catch((e) => { rates[`NGN-${c}`] = { error: e.message }; }),
            ]));
            return this.sendSuccess(res, {
                configured: true,
                mode,
                host: config.HYPERRAILS_BASE_URL,
                currencies: HYPERRAILS_LAB_CURRENCIES,
                balances: balances.filter((b: any) => ['GHS', 'KES', 'NGN'].includes(String(b?.currency).toUpperCase())),
                otherBalances: balances.filter((b: any) => !['GHS', 'KES', 'NGN'].includes(String(b?.currency).toUpperCase())).map((b: any) => b?.currency),
                rates,
                liveCaps: LIVE_PAYOUT_CAP,
            });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    /** Mobile money providers and banks for a currency */
    private async coverage(req: Request, res: Response, next: NextFunction) {
        const currency = labCurrency(req.params.currency);
        if (!currency) return next(invalid('Choose GHS or KES'));
        const [providers, banks, momoCurrencies] = await Promise.all([
            hyperRailsService.mobileMoneyProviders(currency, HYPERRAILS_COUNTRY[currency]).catch((e) => ({ error: e.message })),
            hyperRailsService.banks(currency).catch((e) => ({ error: e.message })),
            hyperRailsService.mobileMoneyCurrencies().catch((e) => ({ error: e.message })),
        ]);
        const found = 'error' in providers ? providers : providers.providers;
        return this.sendSuccess(res, {
            currency,
            country: HYPERRAILS_COUNTRY[currency],
            providers: found,
            // What HyperRails actually said, for when the list comes back empty
            raw: { providers: 'error' in providers ? providers : providers.raw, momoCurrencies },
            // Ghana's codes as HyperRails documents them, to try when it lists none
            documentedProviders: currency === 'GHS' ? [{ code: 'mtn', name: 'MTN' }, { code: 'telecel', name: 'Telecel' }, { code: 'airtel', name: 'AirtelTigo' }] : [],
            banks,
            momoCurrencies,
        });
    }

    /**
     * Prices GHS/KES → NGN (a receive: the payer's cedis or shillings arrive as
     * naira) or NGN → GHS/KES. Settles into the destination currency's account.
     */
    private async quote(req: Request, res: Response, next: NextFunction) {
        const from = String(req.body?.from || '').toUpperCase();
        const to = String(req.body?.to || '').toUpperCase();
        const amount = Number(req.body?.amount);
        const local = labCurrency(from) || labCurrency(to);
        if (!local || !((from === 'NGN') !== (to === 'NGN'))) return next(invalid('Quote GHS or KES to NGN, or NGN to GHS or KES'));
        if (!isFinite(amount) || amount <= 0 || amount > 100_000_000) return next(invalid('Enter an amount'));
        const amountDirection = req.body?.amountDirection === 'destination' ? 'destination' : 'source';
        try {
            const account = await hyperRailsService.balanceFor(to);
            const quote = await hyperRailsService.expressQuote({
                sourceCurrency: from,
                destinationCurrency: to,
                amount,
                amountDirection,
                accountId: account.accountId,
                externalReference: `SPLAB-${crypto.randomBytes(6).toString('hex')}`,
            });
            return this.sendSuccess(res, { quote, accountId: account.accountId }, 201);
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private async quoteStatus(req: Request, res: Response, next: NextFunction) {
        if (!ID.test(req.params.id)) return next(invalid('Quote id is not valid'));
        try {
            const [quote, payment] = await Promise.all([
                hyperRailsService.getQuote(req.params.id).catch((e) => ({ error: e.message })),
                hyperRailsService.paymentStatus(req.params.id).catch((e) => ({ error: e.message })),
            ]);
            return this.sendSuccess(res, { quote, payment });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    /** Accepts a GHS/KES → NGN quote and charges the payer's mobile money */
    private async charge(req: Request, res: Response, next: NextFunction) {
        if (!ID.test(req.params.id)) return next(invalid('Quote id is not valid'));
        const currency = labCurrency(req.body?.currency);
        if (!currency) return next(invalid('Choose GHS or KES'));
        const providerCode = String(req.body?.providerCode || '').toLowerCase();
        if (!PROVIDER.test(providerCode)) return next(invalid('Choose the mobile money provider'));
        const phoneNumber = localPhone(currency, req.body?.phoneNumber);
        if (!phoneNumber) return next(invalid(`Enter a valid ${currency === 'GHS' ? 'Ghana' : 'Kenya'} mobile money number`));
        const live = this.liveCheck(req.body, 'charges a real mobile money wallet');
        if (live) return next(invalid(live));
        try {
            const account = await hyperRailsService.balanceFor('NGN');
            const quote = await hyperRailsService.acceptWithMobileMoney(req.params.id, { accountId: account.accountId, countryCode: HYPERRAILS_COUNTRY[currency], providerCode, phoneNumber });
            return this.sendSuccess(res, { quote });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private async authorize(req: Request, res: Response, next: NextFunction) {
        if (!ID.test(req.params.id)) return next(invalid('Quote id is not valid'));
        const otp = String(req.body?.otp || '').trim();
        if (!/^\d{4,8}$/.test(otp)) return next(invalid('Enter the code from the phone'));
        try {
            return this.sendSuccess(res, { quote: await hyperRailsService.authorize(req.params.id, otp) });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    /** Settles a paid quote: the naira lands in the NGN account */
    private async complete(req: Request, res: Response, next: NextFunction) {
        if (!ID.test(req.params.id)) return next(invalid('Quote id is not valid'));
        try {
            return this.sendSuccess(res, { quote: await hyperRailsService.complete(req.params.id) });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private async cancel(req: Request, res: Response, next: NextFunction) {
        if (!ID.test(req.params.id)) return next(invalid('Quote id is not valid'));
        try {
            return this.sendSuccess(res, { quote: await hyperRailsService.cancel(req.params.id) });
        } catch (error) {
            return this.fail(error, next);
        }
    }

    /** Pays a GHS or KES bank account from that currency's HyperRails balance */
    private async payout(req: Request, res: Response, next: NextFunction) {
        const currency = labCurrency(req.body?.currency);
        if (!currency) return next(invalid('Choose GHS or KES'));
        const amount = Math.round(Number(req.body?.amount) * 100) / 100;
        if (!isFinite(amount) || amount <= 0) return next(invalid('Enter an amount'));
        const accountNumber = String(req.body?.accountNumber || '').replace(/\s/g, '');
        if (!/^[0-9A-Za-z]{5,30}$/.test(accountNumber)) return next(invalid('Enter the account number'));
        const accountName = String(req.body?.accountName || '').trim();
        if (!NAME.test(accountName)) return next(invalid('Enter the name on the account'));
        const bankCode = String(req.body?.bankCode || '').trim();
        if (!BANK_CODE.test(bankCode)) return next(invalid('Choose the bank'));
        const branchCode = String(req.body?.branchCode || '').trim();
        if (branchCode && !BANK_CODE.test(branchCode)) return next(invalid('Branch code is not valid'));
        if (hyperRailsService.mode === 'live') {
            const live = this.liveCheck(req.body, 'sends real money');
            if (live) return next(invalid(live));
            if (amount > LIVE_PAYOUT_CAP[currency]) return next(invalid(`On the live key the lab pays out at most ${currency} ${LIVE_PAYOUT_CAP[currency]}`));
        }
        const reference = `SPLAB-PO-${crypto.randomBytes(8).toString('hex')}`;
        try {
            const payout = await hyperRailsService.payout({
                reference,
                amount,
                currency,
                destination: { accountNumber, accountName, bankCode, ...(branchCode ? { branchCode } : {}) },
                narration: 'Solution Pay lab payout',
            });
            return this.sendSuccess(res, { reference, payout }, 201);
        } catch (error) {
            return this.fail(error, next);
        }
    }

    private async payoutStatus(req: Request, res: Response, next: NextFunction) {
        if (!ID.test(req.params.reference)) return next(invalid('Reference is not valid'));
        try {
            return this.sendSuccess(res, { payout: await hyperRailsService.payoutStatus(req.params.reference) });
        } catch (error) {
            return this.fail(error, next);
        }
    }
}

export default new AdminHyperRailsController().router;
