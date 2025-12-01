import BaseController from "../base-controller";
import ExchangeRateService from "../../../services/exchange-rate.service";
import { Request, Response, NextFunction} from "express";
import {IExchangeRate} from "../../../models/interface";
import {validateExchangeRateCreate, validateExchangeRateUpdate} from "../../../validators";
import errorResponseMessage from "../../../common/messages/error-response-message";
import RoleMiddleware from "../../../middlewares/role.middleware";

/**
 * Controller handling exchange rate related operations
 * @class ExchangeRateController
 * @extends BaseController
 */
class ExchangeRateController extends BaseController {
    private exchangeRateService: ExchangeRateService;
    // private roleMiddleware: typeof RoleMiddleware;
    /**
     * Creates an instance of the ExchangeRateController
     */
    constructor() {
        super();
        this.exchangeRateService = new ExchangeRateService();
        // this.roleMiddleware = RoleMiddleware;
        this.setupRoutes();
    }

    /**
     * Sets up routes for exchange rate operations
     * @protected
     */
    protected setupRoutes(): void {
        // Get Exchange Rates route
        this.router.get("/", this.getExchangeRates.bind(this));

        // Create Exchange Rate route
        this.router.post("/", RoleMiddleware.isAdmin, validateExchangeRateCreate, this.createExchangeRate.bind(this));

        // Update Exchange Rate route
        this.router.patch("/:id", RoleMiddleware.isAdmin, validateExchangeRateUpdate, this.updateExchangeRate.bind(this));

        // Toggle Exchange Rate Activeness route
        this.router.patch("/toggle-activeness/:id",RoleMiddleware.isAdmin, this.toggleExchangeRateActiveness.bind(this));
    }

    /**
     * Retrieves all exchange rates based on query parameters
     * @private
     */
    private async getExchangeRates(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const exchangeRates = await this.exchangeRateService.find();
            return this.sendSuccess(res, {exchangeRates})
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Creates a new exchange rate
     * @private
     */
    private async createExchangeRate(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const exchangeRateData: Partial<IExchangeRate> = req.body;
            const {from, to} = exchangeRateData;
            const exchangeRateExists = await this.exchangeRateService.checkRateExistence(from!, to!)
            if(exchangeRateExists) {
                return next(errorResponseMessage.resourceAlreadyExist('Exchange Rate'))
            }
            const exchangeRate = await this.exchangeRateService.create(exchangeRateData);
            return this.sendSuccess(res, {
                exchangeRate,
                message: 'Exchange rate created successfully.',
            })
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Updates an existing exchange rate
     * @private
     */
    private async updateExchangeRate(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const exchangeRate = await this.exchangeRateService.updateById(req.params.id, req.body);
            if (!exchangeRate) {

                next(errorResponseMessage.resourceNotFound('Exchange rate not found.'));
                return
            }
            return this.sendSuccess(res, {
                exchangeRate,
                message: `Exchange rate updated successfully.`,
            })
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Toggles the exchange rate activeness
     * @private
     */
    private async toggleExchangeRateActiveness(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const exchangeRate = await this.exchangeRateService.toggleActiveness(req.params.id);
            return this.sendSuccess(res, {
                exchangeRate,
                message: `Exchange rate ${exchangeRate?.isActive ? "activated" : "deactivated" } successfully!`,
            })
        } catch (error) {
            return next(error);
        }
    }
}

export default new ExchangeRateController().router;