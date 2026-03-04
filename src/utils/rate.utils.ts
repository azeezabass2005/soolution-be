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
     * If direct rate exists, uses it. Otherwise, uses reverse rate with division.
     * @param amount Amount in toCurrency to convert to fromCurrency
     * @returns Converted amount in fromCurrency
     */
    public convertAmountReverse = async (amount: number) => {
        // First, try to find the direct reverse rate (toCurrency -> fromCurrency)
        const reverseRate = await this.exchangeRateService.findOne({
            from: this.toCurrency,
            to: this.fromCurrency,
            isActive: true
        });

        if (reverseRate) {
            // Direct reverse rate exists, use it with multiplication
            // Formula: amount_in_toCurrency * reverseRate = amount_in_fromCurrency
            // Example: 1 RMB * 0.00103 = 0.00103 NGN (if reverse rate exists)
            const converted = reverseRate.rate * amount;
            return Math.round(converted * 100) / 100;
        }

        // If reverse rate doesn't exist, use the forward rate with division
        // Validate forward rate exists
        await this.validateExchangeRate();

        const forwardRate = await this.exchangeRateService.findOne({
            from: this.fromCurrency,
            to: this.toCurrency,
            isActive: true
        });

        if(!forwardRate) {
            throw errorResponseMessage.resourceNotFound(
                `Active exchange rate from ${this.fromCurrency} to ${this.toCurrency} or from ${this.toCurrency} to ${this.fromCurrency}`
            );
        }

        // Formula: amount_in_toCurrency / forwardRate = amount_in_fromCurrency
        // Example: If rate is 970 (1 NGN = 970 RMB), then 10,000,000 RMB / 970 = 10,309.28 NGN
        const converted = amount / forwardRate.rate;
        return Math.round(converted * 100) / 100;
    }
}

export default RateUtils;