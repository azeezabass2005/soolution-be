import fincraService from "./fincra.service";
import platformSettingsService, { type RateDirection } from "./platform-settings.service";

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
    providerFee: number;
    platformFee: number;
    feeAmount: number;
    /** feeAmount as a % of the subtotal */
    feePercent: number;
    /** send: what the user pays; receive: what the user gets */
    totalNgn: number;
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

    /** The full price of sending or receiving `ghsAmount` GHS */
    async price(direction: RateDirection, ghsAmount: number): Promise<GhsPrice> {
        const { providerRate, userRate } = await this.getUserFacingRate("NGN", "GHS", direction);
        const subtotalNgn = round2(ghsAmount * userRate);
        const fees = await platformSettingsService.priceFees(direction, subtotalNgn, ghsPair(direction));
        return {
            direction,
            ghsAmount,
            providerRate,
            userRate,
            subtotalNgn,
            providerFee: fees.providerFee,
            platformFee: fees.platformFee,
            feeAmount: fees.total,
            feePercent: fees.effectivePercent,
            totalNgn: direction === "send" ? round2(subtotalNgn + fees.total) : round2(subtotalNgn - fees.total),
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
        const convertedAmount = source === "GHS" ? round2(amount * userRate) : round2(amount / userRate);
        const feeBaseNgn = source === "NGN" ? amount : convertedAmount;
        const fees = await platformSettingsService.priceFees(direction, feeBaseNgn, ghsPair(direction));
        const totalAmount = source === "NGN" ? round2(amount + fees.total) : round2(convertedAmount - fees.total);
        return {
            rate: userRate, providerRate, userRate, convertedAmount,
            feePercent: fees.effectivePercent, feeAmount: fees.total, providerFee: fees.providerFee, platformFee: fees.platformFee,
            totalAmount, source, destination,
        };
    }
}

export default new GhsRateService();
