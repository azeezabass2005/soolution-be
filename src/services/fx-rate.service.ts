import ExchangeRate from "../models/exchange-rate.model";
import yellowCardService from "./yellowcard.service";
import ogatewayService from "./ogateway.service";
import platformSettingsService from "./platform-settings.service";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import { OG_CURRENCIES, YC_CURRENCIES } from "../common/constant";
import { BASE_WALLET_CURRENCY } from "../common/wallet.constants";
import logger from "../utils/logger.utils";

export type FxSide = "buy" | "sell";

export interface FxRate {
    /** NGN per 1 unit of the currency, markup applied */
    rate: number;
    /** NGN per 1 unit before the markup */
    providerRate: number;
    source: "yellowcard" | "ogateway" | "admin";
}

/**
 * Prices wallet exchanges against NGN with the same sources the send flows
 * use, so converting then sending costs the same as sending directly:
 *   - GHS: OGateway (as instant GHS sends)
 *   - other YellowCard currencies: YellowCard + the platform markup
 *   - the rest (RMB): the admin rate table
 * "buy" is NGN → currency (the user pays more NGN per unit), "sell" is
 * currency → NGN (the user gets fewer).
 */
class FxRateService {
    async ngnPerUnit(currency: string, side: FxSide): Promise<FxRate> {
        if (currency === BASE_WALLET_CURRENCY) return { rate: 1, providerRate: 1, source: "admin" };
        try {
            if ((OG_CURRENCIES as readonly string[]).includes(currency)) {
                const { providerRate, userRate } = side === "buy"
                    ? await ogatewayService.getUserFacingRate(BASE_WALLET_CURRENCY, currency, "send")
                    : await ogatewayService.getUserFacingRate(currency, BASE_WALLET_CURRENCY, "receive");
                return { rate: userRate, providerRate, source: "ogateway" };
            }
            if ((YC_CURRENCIES as readonly string[]).includes(currency)) {
                const providerRate = side === "buy"
                    ? await yellowCardService.getImpliedRate(BASE_WALLET_CURRENCY, currency, "send")
                    : await yellowCardService.getImpliedRate(currency, BASE_WALLET_CURRENCY, "receive");
                const rate = await platformSettingsService.applyRateMarkup(providerRate, side === "buy" ? "send" : "receive");
                return { rate, providerRate, source: "yellowcard" };
            }
        } catch (error: any) {
            logger.error("FX rate lookup failed", { currency, side, error: error?.message });
            throw errorResponseMessage.createError(422, `We couldn't get a ${currency} rate right now. Please try again shortly.`, ErrorSeverity.MEDIUM);
        }
        return this.adminRate(currency, side);
    }

    /** Admin table rows are "units of `to` per 1 `from`" */
    private async adminRate(currency: string, side: FxSide): Promise<FxRate> {
        const row = side === "buy"
            ? await ExchangeRate.findOne({ from: BASE_WALLET_CURRENCY, to: currency, isActive: true }).lean()
            : await ExchangeRate.findOne({ from: currency, to: BASE_WALLET_CURRENCY, isActive: true }).lean();
        if (!row || !(row.rate > 0)) {
            throw errorResponseMessage.createError(
                400,
                side === "buy"
                    ? `Exchanging into ${currency} isn't available right now.`
                    : `Exchanging ${currency} back to NGN isn't available right now.`,
                ErrorSeverity.LOW
            );
        }
        const rate = side === "buy" ? 1 / row.rate : row.rate;
        return { rate, providerRate: rate, source: "admin" };
    }
}

export default new FxRateService();
