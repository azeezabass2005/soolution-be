import yellowCardService from "./yellowcard.service";
import platformSettingsService, { type RateDirection } from "./platform-settings.service";
import { pairFees } from "./ghs-rate.service";
import { NO_LIMITS, applyRateRule, limitProblem, type FxPricing, type TxLimits, type UsdPricing } from "../common/pricing";
import { YELLOWCARD_FLOW_CURRENCIES } from "../common/payment-link.constants";

const round2 = (n: number) => Math.round(n * 100) / 100;
const RATES_TTL_MS = 30_000;

/** A currency's price against USD at YellowCard: units of the currency per 1 USD */
export interface UsdQuote {
    /** What YellowCard charges in the currency for 1 USD (we buy USD with it) */
    buy: number;
    /** What YellowCard gives in the currency for 1 USD (we sell USD for it) */
    sell: number;
}

export interface YcPrice {
    direction: RateDirection;
    currency: string;
    /** The foreign amount: sent to the recipient (send) or paid by the payer (receive) */
    amount: number;
    /** NGN per 1 unit before our buffer: what it costs us (send) or fetches us (receive) */
    providerRate: number;
    /** NGN per 1 unit the user gets, after the admin's buffer */
    userRate: number;
    /** Where the NGN-per-USD came from */
    usdSource: UsdPricing["mode"];
    /** amount × userRate */
    subtotalNgn: number;
    providerFee: number;
    platformFee: number;
    /** The whole fee in NGN */
    feeAmount: number;
    /** feeAmount as a % of the subtotal */
    feePercent: number;
    /** YellowCard's part of the fee as a % of the subtotal (kept on the transaction for reports) */
    providerFeePercent: number;
    /** The admin's rate buffer % for the pair */
    markupPercent: number;
    /** send: what the user pays in NGN; receive: what they're credited */
    totalNgn: number;
    limits: TxLimits;
}

export class YcLimitError extends Error {
    readonly code = "TX_LIMIT";
}

export const isYellowCardCurrency = (currency?: string | null) =>
    !!currency && (YELLOWCARD_FLOW_CURRENCIES as readonly string[]).includes(currency.toUpperCase());

/** The pricing pair for a YellowCard currency: sends are NGN-KES, receives KES-NGN */
export const ycPair = (direction: RateDirection, currency: string) => (direction === "send" ? `NGN-${currency}` : `${currency}-NGN`);

/**
 * NGN prices for YellowCard currencies, like GHS has: the provider's rate
 * (YellowCard's, bridged through USD the way YellowCard quotes everything,
 * with our own NGN-per-USD when the admin sets it), the admin's buffer for
 * the pair, and the pair's fees and limits. Quotes, sends, receives, payment
 * links and wallet exchanges all price from here.
 */
class YcRateService {
    private cache: { at: number; quotes: Map<string, UsdQuote> } | null = null;

    /** Every currency's USD price at YellowCard, kept for 30 seconds */
    async usdQuotes(): Promise<Map<string, UsdQuote>> {
        if (this.cache && Date.now() - this.cache.at < RATES_TTL_MS) return this.cache.quotes;
        const data: any = await yellowCardService.getRates();
        const list: any[] = data?.rates || (Array.isArray(data) ? data : []);
        const quotes = new Map<string, UsdQuote>();
        for (const r of list) {
            const code = String(r.code || r.currency || r.currencyCode || "").toUpperCase();
            const buy = Number(r.buy);
            const sell = Number(r.sell);
            if (code && buy > 0 && sell > 0) quotes.set(code, { buy, sell });
        }
        this.cache = { at: Date.now(), quotes };
        return quotes;
    }

    /** Forget the cached rates (tests) */
    clearCache() {
        this.cache = null;
    }

    /**
     * NGN per 1 unit before our buffer, and the NGN-per-USD behind it.
     *   send:    we buy USD with naira, YellowCard pays out the currency:  NGN-per-USD (buy) / currency-per-USD (sell)
     *   receive: YellowCard collects the currency as USD, we sell it:      NGN-per-USD (sell) / currency-per-USD (buy)
     * With our own USD rate, it replaces YellowCard's NGN leg.
     */
    async providerRate(direction: RateDirection, currency: string): Promise<{ rate: number; ngnPerUsd: number; usdSource: UsdPricing["mode"]; currencyPerUsd: number }> {
        const cur = currency.toUpperCase();
        const [quotes, pricing] = await Promise.all([this.usdQuotes(), platformSettingsService.getPricing()]);
        const foreign = quotes.get(cur);
        const naira = quotes.get("NGN");
        if (!foreign) throw new Error(`YellowCard has no ${cur} rate`);
        const ours = pricing.usd?.mode === "ours" && pricing.usd.buyNgn > 0 && pricing.usd.sellNgn > 0;
        const ngnPerUsd = direction === "send"
            ? (ours ? pricing.usd.buyNgn : naira?.buy)
            : (ours ? pricing.usd.sellNgn : naira?.sell);
        if (!ngnPerUsd || !(ngnPerUsd > 0)) throw new Error("YellowCard has no NGN rate");
        const currencyPerUsd = direction === "send" ? foreign.sell : foreign.buy;
        return { rate: ngnPerUsd / currencyPerUsd, ngnPerUsd, usdSource: ours ? "ours" : "yellowcard", currencyPerUsd };
    }

    async rules(direction: RateDirection, currency: string): Promise<FxPricing | undefined> {
        return platformSettingsService.pairPricing(direction, ycPair(direction, currency.toUpperCase()));
    }

    /** The user's rate, with the provider's: NGN per 1 unit */
    async userRate(direction: RateDirection, currency: string): Promise<{ providerRate: number; userRate: number }> {
        const [{ rate }, rules] = await Promise.all([this.providerRate(direction, currency), this.rules(direction, currency)]);
        return { providerRate: rate, userRate: applyRateRule(rules?.rate, rate, direction) };
    }

    async limits(direction: RateDirection, currency: string): Promise<TxLimits> {
        return (await this.rules(direction, currency))?.limits ?? { ...NO_LIMITS };
    }

    /** Throws YcLimitError when `amount` is outside the admin's per-transaction limits for the pair */
    async assertWithinLimits(direction: RateDirection, currency: string, amount: number): Promise<void> {
        const problem = limitProblem(await this.limits(direction, currency), amount, currency.toUpperCase());
        if (problem) throw new YcLimitError(problem);
    }

    /** The full price of sending or receiving `amount` of a YellowCard currency */
    async price(direction: RateDirection, currency: string, amount: number): Promise<YcPrice> {
        const cur = currency.toUpperCase();
        const [{ rate: providerRate, usdSource }, rules] = await Promise.all([this.providerRate(direction, cur), this.rules(direction, cur)]);
        const userRate = applyRateRule(rules?.rate, providerRate, direction);
        const fees = pairFees(rules, amount, userRate);
        const pct = (n: number) => (fees.subtotalNgn > 0 ? Math.round((n / fees.subtotalNgn) * 100 * 10_000) / 10_000 : 0);
        return {
            direction,
            currency: cur,
            amount,
            providerRate,
            userRate,
            usdSource,
            subtotalNgn: fees.subtotalNgn,
            providerFee: fees.providerFee,
            platformFee: fees.platformFee,
            feeAmount: fees.total,
            feePercent: pct(fees.total),
            providerFeePercent: pct(fees.providerFee),
            markupPercent: rules?.rate.percent ?? 0,
            totalNgn: direction === "send" ? round2(fees.subtotalNgn + fees.total) : round2(fees.subtotalNgn - fees.total),
            limits: rules?.limits ?? { ...NO_LIMITS },
        };
    }

    /**
     * For admins: how a currency's naira rate is made right now, both ways
     * (YellowCard's USD prices, the NGN-per-USD used, the result before and
     * after our buffer).
     */
    async explain(currency: string) {
        const cur = currency.toUpperCase();
        const quotes = await this.usdQuotes();
        const pricing = await platformSettingsService.getPricing();
        const side = async (direction: RateDirection) => {
            const provider = await this.providerRate(direction, cur);
            const { userRate } = await this.userRate(direction, cur);
            return { ...provider, userRate };
        };
        return {
            currency: cur,
            yellowcard: { currency: quotes.get(cur) ?? null, ngn: quotes.get("NGN") ?? null },
            usd: pricing.usd,
            send: await side("send").catch(() => null),
            receive: await side("receive").catch(() => null),
        };
    }
}

export default new YcRateService();
