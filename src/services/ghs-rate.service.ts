import fincraService from "./fincra.service";
import platformSettingsService, { type RateDirection } from "./platform-settings.service";

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * NGN ↔ GHS prices for users, from Fincra's rate plus the platform markup.
 * The rate is always NGN per 1 GHS:
 *   - "send" (NGN → GHS payout): what buying GHS costs
 *   - "receive" (GHS paid in → NGN): what selling the GHS brings
 * Sends, receives, payment links and wallet exchanges all price from here, so
 * they agree with each other.
 */
class GhsRateService {
    async getUserFacingRate(source: string, destination: string, direction: RateDirection): Promise<{ providerRate: number; userRate: number }> {
        if (![source, destination].includes("GHS") || ![source, destination].includes("NGN")) {
            throw new Error(`GHS rates are only for GHS and NGN, not ${source}/${destination}`);
        }
        const providerRate = await fincraService.ngnPerGhs(direction);
        const userRate = await platformSettingsService.applyRateMarkup(providerRate, direction);
        return { providerRate, userRate };
    }

    /**
     * A priced conversion for `amount` (in `source`), with the fee, in the
     * shape the frontend renders as is. Sends add the fee to what the user
     * pays; receives take it from what they get.
     */
    async quoteRate(source: string, destination: string, amount: number) {
        const direction: RateDirection = source === "GHS" ? "receive" : "send";
        const { providerRate, userRate } = await this.getUserFacingRate(source, destination, direction);
        const convertedAmount = source === "GHS" ? round2(amount * userRate) : round2(amount / userRate);
        const feeBaseNgn = source === "NGN" ? amount : convertedAmount;
        const { feeAmount, feePercent } = await platformSettingsService.computeFee("fincra", feeBaseNgn);
        const totalAmount = source === "NGN" ? round2(amount + feeAmount) : round2(convertedAmount - feeAmount);
        return { rate: userRate, providerRate, userRate, convertedAmount, feePercent, feeAmount, totalAmount, source, destination };
    }
}

export default new GhsRateService();
