import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import ExchangeRateService from "../services/exchange-rate.service";

class RateUtils {
    exchangeRateService: ExchangeRateService;
    fromCurrency: string;
    toCurrency: string;

    constructor(fromCurrency: string, toCurrency: string) {
        this.exchangeRateService = new ExchangeRateService();
        this.fromCurrency = fromCurrency;
        this.toCurrency = toCurrency;
    }

    /**
     * Validates that an exchange rate exists and is active
     * @throws Error if rate doesn't exist or is inactive
     */
    public async validateExchangeRate(): Promise<void> {
        const exchangeRate = await this.exchangeRateService.findOne({
            from: this.fromCurrency,
            to: this.toCurrency
        });

        if (!exchangeRate) {
            throw errorResponseMessage.resourceNotFound(`Exchange rate from ${this.fromCurrency} to ${this.toCurrency}`);
        }

        if (exchangeRate.isActive === false) {
            throw errorResponseMessage.createError(
                400,
                `Exchange rate from ${this.fromCurrency} to ${this.toCurrency} is currently inactive`,
                ErrorSeverity.HIGH
            );
        }
    }

    public convertAmount = async (amount: number) => {
        // Validate exchange rate exists and is active
        await this.validateExchangeRate();

        const exchangeRate = await this.exchangeRateService.findOne({
            from: this.fromCurrency,
            to: this.toCurrency,
            isActive: true
        });

        if(!exchangeRate) {
            throw errorResponseMessage.resourceNotFound(`Active exchange rate from ${this.fromCurrency} to ${this.toCurrency}`);
        }

        // Round to 2 decimal places
        const converted = exchangeRate.rate * amount;
        return Math.round(converted * 100) / 100;
    }
}

export default RateUtils;