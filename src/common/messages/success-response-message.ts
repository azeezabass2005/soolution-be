import logger from "../../utils/logger.utils";

/**
 * Represents the severity levels of success
 * @enum {string}
 */
export enum SuccessSeverity {
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
 * Defines standardized success response codes across different categories
 * @enum {number}
 */
export enum SuccessResponseCode {
    // Authentication Successes (1-100)
    /** Login successful */
    LOGIN_SUCCESSFUL = 1,
    /** Token refreshed successful */
    TOKEN_REFRESHED = 2,

    // Resource Operations (101-200)
    /** Creation of resource successful */
    CREATED = 101,
    /** Updating of resource successful */
    UPDATED = 102,
    /** Deletion of resource successful */
    DELETED = 103,
    /** Retrieval of resource successful */
    RETRIEVED = 104,

    // Transaction Successes (201-300)
    /** Completion of transaction successful */
    TRANSACTION_COMPLETED = 201,
    /** Batch Process completed successfully */
    BATCH_PROCESSED = 202,
    /** Validation successful */
    VALIDATION_PASSED = 203,

    // System Successes (301-400)
    /** System ready */
    SYSTEM_READY = 301,
    /** Configuration updated successfully */
    CONFIGURATION_UPDATED = 302
}

/**
 * Represents the structure of a standardized success response
 */
export interface SuccessResponse {
    /** Unique success response code */
    response_code: SuccessResponseCode;
    /** Descriptive success message */
    message: string;
    /** Severity level of the success */
    severity: SuccessSeverity;
    /** Timestamp of when the success occurred */
    timestamp: Date;
    /** Data that is returned by the success if any */
    data?: any;
}

/**
 * Manages success response creation and logging
 * @class
 */
export class SuccessResponseMessage {
    /**
     * Logs a success using the application's logger
     * @param {SuccessResponse} success
     * @private
     */
    private logSuccess(success: SuccessResponse) {
        logger.info(`Success ${success.response_code}: ${success.message}`, {
            code: success.response_code,
            severity: success.severity
        });
    }

    /**
     * Creates a standardized success response
     * @param {SuccessResponseCode} code - The success response code
     * @param {string} message - The error message
     * @param {any} data - The data returned by the success if any
     * @param {SuccessSeverity} [severity=SuccessSeverity.MEDIUM] - The success severity (defaults to medium)
     * @returns {SuccessResponse} The created success response
     */
    public createSuccess(
        code: SuccessResponseCode,
        message: string,
        data?: any,
        severity: SuccessSeverity = SuccessSeverity.MEDIUM
    ): SuccessResponse {
        const successResponse = {
            response_code: code,
            message,
            severity,
            timestamp: new Date(),
            data
        };

        this.logSuccess(successResponse);
        return successResponse;
    }

    /**
     * Creates a success response for the created resources
     * @param {string} resource - The resource that was created
     * @param {any} data - The data returned by the resource creation
     * @returns {SuccessResponse} Success response with CREATED code
     */
    public resourceCreated(resource: string, data?: any): SuccessResponse {
        return this.createSuccess(
            SuccessResponseCode.CREATED,
            `${resource} created successfully!`,
            data,
            SuccessSeverity.HIGH
        );
    }

    /**
     * Creates a success response for the updated resources
     * @param {string} resource - The resource that was updated
     * @param {any} data - The data returned by the resource updated
     * @returns {SuccessResponse} Success response with UPDATED code
     */
    public resourceUpdated(resource: string, data?: any): SuccessResponse {
        return this.createSuccess(
            SuccessResponseCode.UPDATED,
            `${resource} updated successfully!`,
            data,
            SuccessSeverity.MEDIUM
        );
    }

    /**
     * Creates a success response for the deleted resource
     * @param {string} resource - The resource that was created
     * @returns {SuccessResponse} Success response with DELETED code
     */
    public resourceDeleted(resource: string): SuccessResponse {
        return this.createSuccess(
            SuccessResponseCode.DELETED,
            `${resource} deleted successfully!`,
            null,
            SuccessSeverity.LOW
        );
    }

    /**
     * Creates a success response for successful authentication
     * @param {string} username - The username of the authenticated user
     * @returns {SuccessResponse} Success response with LOGIN_SUCCESSFUL code
     */
    public authenticationSuccess(username: string): SuccessResponse {
        return this.createSuccess(
            SuccessResponseCode.LOGIN_SUCCESSFUL,
            `Welcome back, ${username}!`,
            { username },
            SuccessSeverity.HIGH
        );
    }

    /**
     * Creates a success response for generic successes
     * @param {string} message - This is the message for the generic success
     * @param {any} data - The data returned by the generic success
     * @returns {SuccessResponse} Success response with CREATED code
     */
    public genericSuccess(message: string, data?: any): SuccessResponse {
        return this.createSuccess(
            SuccessResponseCode.SYSTEM_READY,
            message,
            data,
            SuccessSeverity.LOW
        );
    }
}

export default new SuccessResponseMessage();