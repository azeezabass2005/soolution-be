import errorResponseMessage from "../common/messages/error-response-message";
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

    public convertAmount = async (amount: number) => {
        const exchangeRate = await this.exchangeRateService.findOne({
            from: this.fromCurrency,
            to: this.toCurrency
        })

        if(!exchangeRate) {
            throw errorResponseMessage.resourceNotFound("Exchange rate")
        }

        return exchangeRate.rate * amount;

    }
}

export default RateUtils;