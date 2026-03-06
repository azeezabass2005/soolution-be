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
        // Formula: amount_in_fromCurrency * rate = amount_in_toCurrency
        // Example: 1 NGN * 970 = 970 RMB
        const converted = exchangeRate.rate * amount;
        return Math.round(converted * 100) / 100;
    }

    /**
     * Converts amount in reverse direction (from toCurrency to fromCurrency)
     * Always uses the forward rate (fromCurrency -> toCurrency) with division, which is
     * the mathematically correct inverse regardless of whether a separate reverse rate exists.
     * Falling back to the stored reverse rate (toCurrency -> fromCurrency) with multiplication
     * is avoided as the two rates may not be exact reciprocals of each other.
     * @param amount Amount in toCurrency to convert to fromCurrency
     * @returns Converted amount in fromCurrency
     */
    public convertAmountReverse = async (amount: number) => {
        // Prefer forward rate with division — always correct for reverse conversion.
        // Example: KES→NGN rate = 240, so 120,000 NGN / 240 = 500 KES.
        await this.validateExchangeRate();

        const forwardRate = await this.exchangeRateService.findOne({
            from: this.fromCurrency,
            to: this.toCurrency,
            isActive: true
        });

        if (forwardRate) {
            // Formula: amount_in_toCurrency / forwardRate = amount_in_fromCurrency
            const converted = amount / forwardRate.rate;
            return Math.round(converted * 100) / 100;
        }

        // Fallback: use stored reverse rate with multiplication only when forward rate is absent.
        const reverseRate = await this.exchangeRateService.findOne({
            from: this.toCurrency,
            to: this.fromCurrency,
            isActive: true
        });

        if (reverseRate) {
            const converted = reverseRate.rate * amount;
            return Math.round(converted * 100) / 100;
        }

        throw errorResponseMessage.resourceNotFound(
            `Active exchange rate from ${this.fromCurrency} to ${this.toCurrency} or from ${this.toCurrency} to ${this.fromCurrency}`
        );
    }
}

export default RateUtils;