import errorResponseMessage, {
    ErrorResponse,
    ErrorResponseCode,
    ErrorSeverity,
    ErrorResponseMessage
} from "../common/messages/error-response-message";
import { NextFunction, Request, Response, Application } from "express";
import logger from "../utils/logger.utils";

class ResponseErrorHandler {
    protected logger: typeof logger;
    private static instance: ResponseErrorHandler;
    private errorMessageHandler: ErrorResponseMessage;

    private constructor() {
        this.logger = logger;
        this.errorMessageHandler = errorResponseMessage;
    }

    public static getInstance(): ResponseErrorHandler {
        if (!ResponseErrorHandler.instance) {
            ResponseErrorHandler.instance = new ResponseErrorHandler();
        }
        return ResponseErrorHandler.instance;
    }

    public static initialize(app: Application): void {
        const handler = ResponseErrorHandler.getInstance();
        app.use((err: Error | ErrorResponse, req: Request, res: Response, next: NextFunction) => {
            handler.handleError(err, req, res, next);
        });
    }

    public handleError(
        err: Error | ErrorResponse,
        req: Request,
        res: Response,
        next: NextFunction
    ): void {
        if (res.headersSent) {
            return next(err);
        }

        const correlationId = req.headers['x-correlation-id'] || this.generateCorrelationId();

        // If the error is already an ErrorResponse, use it directly
        if (this.isErrorResponse(err)) {
            const errorResp = err as ErrorResponse;
            res.status(errorResp.response_code)
                .json({ ...errorResp, correlationId });
            return;
        }

        // Log the error with request context
        this.logger.error(`Error in request [${correlationId}]: ${err.message}`, {
            correlationId,
            error: {
                name: err.name || "UnknownError",
                message: err.message,
                stack: err.stack || "UnknownStack"
            },
            request: {
                path: req.path,
                method: req.method,
                body: this.sanitizeData(req.body),
                query: req.query,
                params: req.params,
                ip: req.ip,
                headers: this.sanitizeHeaders(req.headers)
            }
        });

        // Create error response using the provided ErrorResponseMessage methods
        const errorResponse = this.createDetailedErrorResponse(err);

        // Add correlation ID to response headers
        res.setHeader('X-Correlation-ID', correlationId);

        // Send error response
        res.status(errorResponse.response_code)
            .json({ ...errorResponse, correlationId });
    }

    private isErrorResponse(err: any): err is ErrorResponse {
        return 'response_code' in err && 'severity' in err && 'timestamp' in err;
    }

    private createDetailedErrorResponse(err: Error): ErrorResponse {
        // Use the specific error message methods based on error type
        switch (err.name) {
            case 'ValidationError':
                return this.errorMessageHandler.payloadIncorrect(err.message);

            case 'NotFoundError':
                return this.errorMessageHandler.resourceNotFound(err.message);

            case 'UnauthorizedError':
                return this.errorMessageHandler.unauthorized(err.message);

            case 'TypeError':
            case 'SyntaxError':
                return this.errorMessageHandler.createError(
                    ErrorResponseCode.PAYLOAD_INCORRECT,
                    err.message,
                    ErrorSeverity.MEDIUM
                );

            default:
                if (process.env.NODE_ENV === 'production') {
                    return this.errorMessageHandler.unableToComplete('An unexpected error occurred');
                }
                return this.errorMessageHandler.createError(
                    ErrorResponseCode.INTERNAL_SERVER_ERROR,
                    err.message,
                    ErrorSeverity.CRITICAL
                );
        }
    }

    private sanitizeData(data: any): any {
        const sensitiveFields = ['password', 'token', 'secret', 'creditCard'];
        if (!data) return data;

        return Object.entries(data).reduce((acc, [key, value]) => {
            acc[key] = sensitiveFields.includes(key.toLowerCase()) ? '[REDACTED]' : value;
            return acc;
        }, {} as any);
    }

    private sanitizeHeaders(headers: any): any {
        const sensitiveHeaders = ['authorization', 'cookie', 'x-api-key'];
        return Object.entries(headers).reduce((acc, [key, value]) => {
            acc[key] = sensitiveHeaders.includes(key.toLowerCase()) ? '[REDACTED]' : value;
            return acc;
        }, {} as any);
    }

    private generateCorrelationId(): string {
        return `${Date.now()}-${Math.random().toString(36)}`;
    }
}

export default ResponseErrorHandler;