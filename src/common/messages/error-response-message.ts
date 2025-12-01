import logger from "../../utils/logger.utils"
import z from 'zod'

/**
 * Represents the severity levels of an error
 * @enum {string}
 */
export enum ErrorSeverity {
    /** Low severity error */
    LOW = 'LOW',
    /** Medium severity error */
    MEDIUM = 'MEDIUM',
    /** High severity error */
    HIGH = 'HIGH',
    /** Critical severity error */
    CRITICAL = 'CRITICAL'
}

/**
 * Defines standardized error response codes across different categories
 * @enum {number}
 */
export enum ErrorResponseCode {
    // Authentication Errors (400-499)
    /** Unauthorized access attempt */
    UNAUTHORIZED = 401,
    /** Invalid authentication token */
    INVALID_TOKEN = 403,

    // Request Errors (400-499)
    /** Malformed or invalid request */
    BAD_REQUEST = 400,
    /** Requested resource not found */
    NOT_FOUND = 404,
    /** Request could not be completed */
    UNABLE_TO_COMPLETE = 422,

    // Payload Errors (400-499)
    /** Payload data is incorrect or invalid */
    PAYLOAD_INCORRECT = 400,
    /** Resource already exists */
    RESOURCE_ALREADY_EXISTS = 409,

    // System Errors (500-599)
    /** Internal server error */
    INTERNAL_SERVER_ERROR = 500
}
/**
 * Represents the structure of a standardized error response
 * @interface
 */
export interface ErrorResponse {
    /** Unique error response code */
    response_code: ErrorResponseCode;
    /** Descriptive error message */
    message: string;
    /** Severity level of the error */
    severity: ErrorSeverity;
    /** Timestamp of when the error occurred */
    timestamp: Date;
}

/**
 * Manages error response creation and logging
 * @class
 */
export class ErrorResponseMessage {
    /**
     * Logs an error using the application's logger
     * @private
     * @param {ErrorResponse} error - The error to be logged
     */
    private logError(error: ErrorResponse) {
        logger.error(`Error ${error.response_code}: ${error.message}`, {
            code: error.response_code,
            severity: error.severity
        });
    }

    /**
     * Creates a standardized error response
     * @public
     * @param {ErrorResponseCode} code - The error response code
     * @param {string} message - The error message
     * @param {ErrorSeverity} [severity=ErrorSeverity.MEDIUM] - The error severity (defaults to MEDIUM)
     * @returns {ErrorResponse} The created error response
     */
    public createError(
        code: ErrorResponseCode,
        message: string,
        severity: ErrorSeverity = ErrorSeverity.MEDIUM,
        details?: any
    ): ErrorResponse {
        const error = {
            response_code: code,
            message,
            severity,
            timestamp: new Date(),
            details
        };

        this.logError(error);
        return error;
    }

    /**
     * Creates an error response for incorrect payload
     * @public
     * @param {string} payload - The payload that was incorrect
     * @returns {ErrorResponse} Error response with PAYLOAD_INCORRECT code
     */
    public payloadIncorrect(payload: string): ErrorResponse {
        return this.createError(
            ErrorResponseCode.PAYLOAD_INCORRECT,
            `${payload} is incorrect, check and try again!`,
            ErrorSeverity.HIGH
        );
    }

    /**
     * Creates an error response for incorrect payload
     * @public
     * @param {z.ZodError} error - The payload that was incorrect
     * @returns {ErrorResponse} Error response with PAYLOAD_INCORRECT code
     */
    public badRequest(error: z.ZodError): ErrorResponse {
        return this.createError(
            ErrorResponseCode.PAYLOAD_INCORRECT,
            `Payload is incorrect, check and try again!`,
            ErrorSeverity.HIGH,
            error
        );
    }

    /**
     * Creates an error response for resource not found
     * @public
     * @param {string} resource - The name of the resource that could not be found
     * @returns {ErrorResponse} Error response with NOT_FOUND code
     */
    public resourceNotFound(resource: string): ErrorResponse {
        return this.createError(
            ErrorResponseCode.NOT_FOUND,
            `${resource} not found!`,
            ErrorSeverity.MEDIUM
        );
    }

    /**
     * Creates an error response for inability to complete a request
     * @public
     * @param {string} [reason] - Optional reason for the failure
     * @returns {ErrorResponse} Error response with UNABLE_TO_COMPLETE code
     */
    public unableToComplete(reason?: string): ErrorResponse {
        return this.createError(
            ErrorResponseCode.UNABLE_TO_COMPLETE,
            reason || 'Unable to complete the request',
            ErrorSeverity.HIGH
        );
    }

    /**
     * Creates an error response for unauthorized access
     * @public
     * @param {string} [reason] - Optional reason for unauthorized access
     * @returns {ErrorResponse} Error response with UNAUTHORIZED code
     */
    public unauthorized(reason?: string): ErrorResponse {
        return this.createError(
            ErrorResponseCode.UNAUTHORIZED,
            reason || 'Not authorized!',
            ErrorSeverity.CRITICAL
        );
    }

    /**
     * Creates an error response for resource already exits
     * @public
     * @param {string} resource - The name of the resource that is conflicting
     * @returns {ErrorResponse} Error response with RESOURCE_ALREADY_EXISTS code
     */
    public resourceAlreadyExist(resource?: string, isFullMessage?: boolean): ErrorResponse {
        return this.createError(
            ErrorResponseCode.RESOURCE_ALREADY_EXISTS,
            (isFullMessage && resource) ? resource : (resource ? `${resource} Already Exists` : 'Resource Already Exists'),
            ErrorSeverity.HIGH
        )
    }
}

export default new ErrorResponseMessage();