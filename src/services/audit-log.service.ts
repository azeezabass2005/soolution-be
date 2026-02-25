import DBService from "../utils/db.utils";
import { IAuditLog } from "../models/audit-log.model";
import AuditLog from "../models/audit-log.model";
import { Types } from "mongoose";

class AuditLogService extends DBService<IAuditLog> {
    /**
     * Creates an instance of AuditLogService
     * @constructor
     */
    constructor() {
        super(AuditLog);
    }

    /**
     * Logs a transaction status change
     * @param transactionId Transaction ID
     * @param userId User ID who made the change
     * @param oldStatus Previous status
     * @param newStatus New status
     * @param ipAddress IP address of the user
     * @param userAgent User agent string
     * @param metadata Additional metadata
     */
    public async logStatusChange(
        transactionId: string,
        userId: string,
        oldStatus: string,
        newStatus: string,
        ipAddress?: string,
        userAgent?: string,
        metadata?: Record<string, any>
    ): Promise<IAuditLog> {
        return await this.create({
            transactionId: new Types.ObjectId(transactionId),
            userId: new Types.ObjectId(userId),
            action: 'status_change',
            beforeValue: { status: oldStatus },
            afterValue: { status: newStatus },
            ipAddress,
            userAgent,
            metadata
        });
    }

    /**
     * Logs a receipt upload
     * @param transactionId Transaction ID
     * @param userId User ID who uploaded the receipt
     * @param receiptType Type of receipt (pay_in, pay_out)
     * @param receiptUrl URL of the uploaded receipt
     * @param ipAddress IP address of the user
     * @param userAgent User agent string
     */
    public async logReceiptUpload(
        transactionId: string,
        userId: string,
        receiptType: 'pay_in' | 'pay_out',
        receiptUrl: string,
        ipAddress?: string,
        userAgent?: string
    ): Promise<IAuditLog> {
        return await this.create({
            transactionId: new Types.ObjectId(transactionId),
            userId: new Types.ObjectId(userId),
            action: 'receipt_upload',
            afterValue: { receiptType, receiptUrl },
            ipAddress,
            userAgent
        });
    }

    /**
     * Logs transaction creation
     * @param transactionId Transaction ID
     * @param userId User ID who created the transaction
     * @param transactionData Transaction data
     * @param ipAddress IP address of the user
     * @param userAgent User agent string
     */
    public async logTransactionCreation(
        transactionId: string,
        userId: string,
        transactionData: Record<string, any>,
        ipAddress?: string,
        userAgent?: string
    ): Promise<IAuditLog> {
        return await this.create({
            transactionId: new Types.ObjectId(transactionId),
            userId: new Types.ObjectId(userId),
            action: 'transaction_created',
            afterValue: transactionData,
            ipAddress,
            userAgent
        });
    }

    /**
     * Logs a generic action
     * @param transactionId Transaction ID (optional)
     * @param userId User ID who performed the action
     * @param action Action name
     * @param beforeValue Value before change
     * @param afterValue Value after change
     * @param ipAddress IP address of the user
     * @param userAgent User agent string
     * @param metadata Additional metadata
     */
    public async logAction(
        transactionId: string | undefined,
        userId: string,
        action: string,
        beforeValue?: any,
        afterValue?: any,
        ipAddress?: string,
        userAgent?: string,
        metadata?: Record<string, any>
    ): Promise<IAuditLog> {
        return await this.create({
            transactionId: transactionId ? new Types.ObjectId(transactionId) : undefined,
            userId: new Types.ObjectId(userId),
            action,
            beforeValue,
            afterValue,
            ipAddress,
            userAgent,
            metadata
        });
    }

    /**
     * Gets audit logs for a transaction
     * @param transactionId Transaction ID
     * @param limit Maximum number of logs to return
     * @returns Array of audit logs
     */
    public async getTransactionLogs(transactionId: string, limit: number = 50): Promise<IAuditLog[]> {
        return await this.find(
            { transactionId: new Types.ObjectId(transactionId) },
            { sort: { createdAt: -1 }, limit }
        );
    }

    /**
     * Gets audit logs for a user
     * @param userId User ID
     * @param limit Maximum number of logs to return
     * @returns Array of audit logs
     */
    public async getUserLogs(userId: string, limit: number = 50): Promise<IAuditLog[]> {
        return await this.find(
            { userId: new Types.ObjectId(userId) },
            { sort: { createdAt: -1 }, limit }
        );
    }
}

export default AuditLogService;
