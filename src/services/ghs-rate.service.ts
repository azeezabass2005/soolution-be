import fincraService from "./fincra.service";
import platformSettingsService, { type RateDirection } from "./platform-settings.service";
import { NO_LIMITS, limitProblem, priceFees, type FxPricing, type TxLimits } from "../common/pricing";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The pricing pair for a direction: sends are NGN→GHS, receives GHS→NGN */
export const ghsPair = (direction: RateDirection) => (direction === "send" ? "NGN-GHS" : "GHS-NGN");

export interface GhsPrice {
    direction: RateDirection;
    /** GHS sent to the recipient (send) or paid by the payer (receive) */
    ghsAmount: number;
    providerRate: number;
    /** NGN per 1 GHS after the admin's rate buffer */
    userRate: number;
    /** ghsAmount × userRate */
    subtotalNgn: number;
    /** Fincra's part of the fee, in NGN */
    providerFee: number;
    /** SolutionPay's part of the fee, in NGN */
    platformFee: number;
    /** The whole fee in NGN: what the wallet is charged (send) or what's taken off (receive) */
    feeAmount: number;
    /** The fee in the currency it's set in (feeCurrency) */
    feeInFeeCurrency: number;
    /** "GHS" when the admin sets this pair's fees in cedis, "NGN" for older configs */
    feeCurrency: string;
    /** feeAmount as a % of the subtotal */
    feePercent: number;
    /** send: what the user pays; receive: what the user gets */
    totalNgn: number;
    /** Per-transaction limits in GHS (0 = none) */
    limits: TxLimits;
}

export class GhsLimitError extends Error {
    readonly code = "TX_LIMIT";
}

/**
 * The fee for `ghsAmount` under a pair's rules. Fees set in GHS are worked
 * out on the GHS amount and converted at the user's (buffered) rate, never
 * Fincra's; older NGN configs are worked out on the NGN subtotal.
 */
export function pairFees(rules: FxPricing | undefined, ghsAmount: number, userRate: number) {
    const subtotalNgn = round2(ghsAmount * userRate);
    if (rules && rules.feeCurrency && rules.feeCurrency !== "NGN") {
        const inGhs = priceFees(rules, ghsAmount);
        const providerFee = round2(inGhs.providerFee * userRate);
        const platformFee = round2(inGhs.platformFee * userRate);
        const total = round2(Math.min(providerFee + platformFee, subtotalNgn));
        return { subtotalNgn, providerFee, platformFee, total, inFeeCurrency: inGhs.total, feeCurrency: rules.feeCurrency };
    }
    const inNgn = priceFees(rules, subtotalNgn);
    return { subtotalNgn, providerFee: inNgn.providerFee, platformFee: inNgn.platformFee, total: inNgn.total, inFeeCurrency: inNgn.total, feeCurrency: "NGN" };
}

/**
 * NGN ↔ GHS prices for users: Fincra's rate with the admin's buffer for the
 * pair, and the pair's fees (Fincra's, passed on, plus SolutionPay's).
 * Sends, receives, payment links and the rate display all price from here,
 * so what users see is what they're charged.
 */
class GhsRateService {
    async getUserFacingRate(source: string, destination: string, direction: RateDirection): Promise<{ providerRate: number; userRate: number }> {
        if (![source, destination].includes("GHS") || ![source, destination].includes("NGN")) {
            throw new Error(`GHS rates are only for GHS and NGN, not ${source}/${destination}`);
        }
        const providerRate = await fincraService.ngnPerGhs(direction);
        const userRate = await platformSettingsService.applyPairRate(direction, ghsPair(direction), providerRate);
        return { providerRate, userRate };
    }

    /** The admin's per-transaction limits for a direction, in GHS */
    async limits(direction: RateDirection): Promise<TxLimits> {
        return (await platformSettingsService.pairPricing(direction, ghsPair(direction)))?.limits ?? { ...NO_LIMITS };
    }

    /** Throws GhsLimitError when `ghsAmount` is outside the admin's per-transaction limits */
    async assertWithinLimits(direction: RateDirection, ghsAmount: number): Promise<void> {
        const problem = limitProblem(await this.limits(direction), ghsAmount, "GHS");
        if (problem) throw new GhsLimitError(problem);
    }

    /** The full price of sending or receiving `ghsAmount` GHS */
    async price(direction: RateDirection, ghsAmount: number): Promise<GhsPrice> {
        const { providerRate, userRate } = await this.getUserFacingRate("NGN", "GHS", direction);
        const rules = await platformSettingsService.pairPricing(direction, ghsPair(direction));
        const fees = pairFees(rules, ghsAmount, userRate);
        return {
            direction,
            ghsAmount,
            providerRate,
            userRate,
            subtotalNgn: fees.subtotalNgn,
            providerFee: fees.providerFee,
            platformFee: fees.platformFee,
            feeAmount: fees.total,
            feeInFeeCurrency: fees.inFeeCurrency,
            feeCurrency: fees.feeCurrency,
            feePercent: fees.subtotalNgn > 0 ? Math.round((fees.total / fees.subtotalNgn) * 100 * 10_000) / 10_000 : 0,
            totalNgn: direction === "send" ? round2(fees.subtotalNgn + fees.total) : round2(fees.subtotalNgn - fees.total),
            limits: rules?.limits ?? { ...NO_LIMITS },
        };
    }

    /**
     * A priced conversion for `amount` (in `source`), in the shape the
     * frontend renders. Sends add the fee to what the user pays; receives
     * take it from what they get.
     */
    async quoteRate(source: string, destination: string, amount: number) {
        const direction: RateDirection = source === "GHS" ? "receive" : "send";
        const { providerRate, userRate } = await this.getUserFacingRate(source, destination, direction);
        const rules = await platformSettingsService.pairPricing(direction, ghsPair(direction));
        // The GHS side of the conversion: what's paid in (receive) or what the NGN buys (send)
        const ghsAmount = source === "GHS" ? amount : round2(amount / userRate);
        const fees = source === "GHS" ? pairFees(rules, ghsAmount, userRate) : pairFees(rules, amount / userRate, userRate);
        const convertedAmount = source === "GHS" ? fees.subtotalNgn : ghsAmount;
        const totalAmount = source === "NGN" ? round2(amount + fees.total) : round2(fees.subtotalNgn - fees.total);
        const feeBase = source === "NGN" ? amount : fees.subtotalNgn;
        return {
            rate: userRate, providerRate, userRate, convertedAmount,
            feePercent: feeBase > 0 ? Math.round((fees.total / feeBase) * 100 * 10_000) / 10_000 : 0,
            feeAmount: fees.total, providerFee: fees.providerFee, platformFee: fees.platformFee,
            feeInFeeCurrency: fees.inFeeCurrency, feeCurrency: fees.feeCurrency,
            totalAmount, source, destination,
            limits: rules?.limits ?? { ...NO_LIMITS },
        };
    }
}

export default new GhsRateService();
