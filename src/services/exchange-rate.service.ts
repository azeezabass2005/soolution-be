/**
 * Service class for Exchange Rate related database operations
 *
 * @description Extends the generic DBService with Exchange Rate specific configurations
 * @extends {DBService<IExchangeRate>}
 */
import DBService from "../utils/db.utils";
import {CurrencyCode, IExchangeRate} from "../models/interface";
import ExchangeRate from "../models/exchange-rate.model";
import {HydratedDocument} from "mongoose";
import errorResponseMessage from "../common/messages/error-response-message";

class ExchangeRateService extends DBService<IExchangeRate> {
    /**
     * Creates an instance of ExchangeRateService
     *
     * @constructor
     */
    constructor() {
        super(ExchangeRate);
    }

    /**
     * Checks for existence of a rate
     * @returns {boolean}
     */
    public async checkRateExistence(
        from: CurrencyCode,
        to: CurrencyCode,
    ): Promise<boolean> {
        const existingExchangeRate = await this.findOne({ from : from, to: to });
        console.log(existingExchangeRate, "This is the existing exchange rate")
        return !!existingExchangeRate;
    }

    /**
     * Toggle the activeness of an exchange rate
     */
    public async toggleActiveness(
        exchangeRateId: string
    ): Promise<HydratedDocument<IExchangeRate>> {
        const exchangeRate = await this.findById(exchangeRateId);
        if(!exchangeRate) {
            throw errorResponseMessage.resourceNotFound('Exchange Rate');
        }
        return await this.updateById(exchangeRateId, { isActive: !exchangeRate.isActive });
    }
}

export default ExchangeRateService;