import { Router, Request, Response, NextFunction } from "express";
import logger from "../../utils/logger.utils";
import UserService from "../../services/user.service";


interface ControllerOptions {
    userService?: UserService;
}

abstract class BaseController {
    public router: Router;
    public userService: UserService;
    protected logger: typeof logger;

    protected constructor(options: ControllerOptions = {}) {
        this.router = Router();
        this.userService = options.userService || new UserService();
        this.logger = logger;
        this.initializeMiddleware();
        this.setupRoutes();
    }

    protected initializeMiddleware(): void {
        this.router.use((req: Request, _res: Response, next: NextFunction) => {
            this.logger.http(`${req.method} ${req.path}`, {
                body: req.body,
                query: req.query,
                params: req.params,
                ip: req.ip
            });
            next();
        });
    }

    protected abstract setupRoutes(): void;

    /**
     * Sends a standardized success response
     * @param {Response} res - Express response object
     * @param {any} [data={}] - Response data
     * @param {number} [statusCode=200] - HTTP status code
     */
    protected sendSuccess(
        res: Response,
        data: any = {},
        statusCode: number = 200
    ): void {

        // Check if response already sent
        if (res.headersSent) {
            this.logger.warn('Attempted to send response after headers already sent');
            return;
        }

        // Log successful response
        this.logger.info(`Successful response`, {
            statusCode,
            dataType: typeof data,
            responseSize: JSON.stringify(data).length
        });

        res.status(statusCode).json({
            success: true,
            data
        });
    }
}

export default BaseController;