import BaseController from "../base-controller";
import ExchangeRateService from "../../../services/exchange-rate.service";
import { Request, Response, NextFunction} from "express";

/**
 * Controller handling exchange rate related operations
 * @class ExchangeRateController
 * @extends BaseController
 */
class ExchangeRateController extends BaseController {
    private exchangeRateService: ExchangeRateService;

    /**
     * Creates an instance of the ExchangeRateController
     */
    constructor() {
        super();
        this.exchangeRateService = new ExchangeRateService();
        this.setupRoutes();
    }

    /**
     * Sets up routes for exchange rate operations
     * @protected
     */
    protected setupRoutes(): void {
        // Get Exchange Rates route
        this.router.get("/", this.getExchangeRates.bind(this));
    }

    /**
     * Retrieves all exchange rates based on query parameters
     * @private
     */
    private async getExchangeRates(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const exchangeRates = await this.exchangeRateService.find({ isActive: true });
            this.sendSuccess(res, {exchangeRates})
        } catch (error) {
            next(error);
        }
    }
}

export default new ExchangeRateController().router;