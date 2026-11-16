import errorResponseMessage, {
    ErrorResponse,
    ErrorResponseCode,
    ErrorSeverity,
    ErrorResponseMessage
} from "../common/messages/error-response-message";
import { NextFunction, Request, Response, Application } from "express";
import logger from "../utils/logger.utils";
import { PG_ERROR, pgError } from "../db/errors";

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

        // Database errors: Drizzle's message contains the SQL and its parameters
        // (which can include password hashes or identity numbers), so it is
        // never logged or returned; only the Postgres code and constraint are.
        const database = this.databaseError(err);

        // Log the error with request context
        // Extract error details safely to avoid circular references
        const errorDetails: any = database
            ? { name: "DatabaseError", message: database.logMessage, code: database.code, constraint: database.constraint }
            : {
                name: err.name || "UnknownError",
                message: err.message || String(err),
                stack: err.stack || "UnknownStack"
            };

        // If it's an AxiosError, extract response details safely
        if ((err as any).response) {
            const axiosError = err as any;
            errorDetails.statusCode = axiosError.response?.status;
            errorDetails.statusText = axiosError.response?.statusText;
            if (axiosError.response?.data) {
                try {
                    // Try to extract just the important parts
                    const data = axiosError.response.data;
                    if (typeof data === 'string') {
                        errorDetails.responseData = data;
                    } else if (data && typeof data === 'object') {
                        errorDetails.responseData = {
                            message: data.message,
                            error: data.error,
                            code: data.code,
                            detail: data.detail
                        };
                    }
                } catch (e) {
                    errorDetails.responseData = '[Could not extract response data]';
                }
            }
        }

        this.logger.error(`Error in request [${correlationId}]: ${errorDetails.message}`, {
            correlationId,
            error: errorDetails,
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
        const errorResponse = database ? database.response : this.createDetailedErrorResponse(err);

        // Add correlation ID to response headers
        res.setHeader('X-Correlation-ID', correlationId);

        // Send error response
        res.status(errorResponse.response_code)
            .json({ ...errorResponse, correlationId });
    }

    /** Maps a Postgres error to a safe client response; null when `err` isn't one */
    private databaseError(err: Error): { code: string; constraint?: string; logMessage: string; response: ErrorResponse } | null {
        const info = pgError(err);
        if (!info && err?.name !== 'DrizzleQueryError') return null;
        const code = info?.code ?? 'unknown';
        const logMessage = `Database error ${code}${info?.constraint ? ` (${info.constraint})` : ''}`;
        const respond = (status: number, message: string, severity: ErrorSeverity) =>
            this.errorMessageHandler.createError(status, message, severity);
        let response: ErrorResponse;
        switch (code) {
            case PG_ERROR.UNIQUE_VIOLATION:
                response = respond(ErrorResponseCode.RESOURCE_ALREADY_EXISTS, 'A record with these details already exists', ErrorSeverity.LOW);
                break;
            case PG_ERROR.FOREIGN_KEY_VIOLATION:
                response = respond(ErrorResponseCode.PAYLOAD_INCORRECT, 'A related record does not exist', ErrorSeverity.LOW);
                break;
            case PG_ERROR.CHECK_VIOLATION:
                response = respond(ErrorResponseCode.PAYLOAD_INCORRECT, 'One or more values are outside the allowed range', ErrorSeverity.LOW);
                break;
            case PG_ERROR.NOT_NULL_VIOLATION:
                response = respond(ErrorResponseCode.PAYLOAD_INCORRECT, 'A required field is missing', ErrorSeverity.LOW);
                break;
            case PG_ERROR.INVALID_TEXT_REPRESENTATION:
                response = respond(ErrorResponseCode.PAYLOAD_INCORRECT, 'One or more values are invalid', ErrorSeverity.LOW);
                break;
            default:
                response = this.errorMessageHandler.unableToComplete('An unexpected error occurred');
        }
        return { code, constraint: info?.constraint, logMessage, response };
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