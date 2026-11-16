import auditLogRepository from "../repositories/audit-log.repository";
import type { Executor } from "../db/client";
import type { AuditLog } from "../types/entities";

/** Audit trail for status changes, uploads and other sensitive actions */
class AuditLogService {
    /** Logs a transaction status change */
    public async logStatusChange(
        transactionId: string,
        userId: string,
        oldStatus: string,
        newStatus: string,
        ipAddress?: string,
        userAgent?: string,
        metadata?: Record<string, any>
    ): Promise<AuditLog> {
        return auditLogRepository.create({
            transactionId,
            userId,
            action: "status_change",
            beforeValue: { status: oldStatus },
            afterValue: { status: newStatus },
            ipAddress,
            userAgent,
            metadata,
        });
    }

    /** Logs a receipt upload */
    public async logReceiptUpload(
        transactionId: string,
        userId: string,
        receiptType: "pay_in" | "pay_out",
        receiptUrl: string,
        ipAddress?: string,
        userAgent?: string
    ): Promise<AuditLog> {
        return auditLogRepository.create({
            transactionId,
            userId,
            action: "receipt_upload",
            afterValue: { receiptType, receiptUrl },
            ipAddress,
            userAgent,
        });
    }

    /** Logs transaction creation */
    public async logTransactionCreation(
        transactionId: string,
        userId: string,
        transactionData: Record<string, any>,
        ipAddress?: string,
        userAgent?: string
    ): Promise<AuditLog> {
        return auditLogRepository.create({
            transactionId,
            userId,
            action: "transaction_created",
            afterValue: transactionData,
            ipAddress,
            userAgent,
        });
    }

    /** Logs a generic action (pass `tx` to make it part of a database transaction) */
    public async logAction(
        transactionId: string | undefined,
        userId: string | undefined,
        action: string,
        beforeValue?: any,
        afterValue?: any,
        ipAddress?: string,
        userAgent?: string,
        metadata?: Record<string, any>,
        tx?: Executor
    ): Promise<AuditLog> {
        return auditLogRepository.create(
            { transactionId, userId, action, beforeValue, afterValue, ipAddress, userAgent, metadata },
            tx
        );
    }

    /** Audit logs for a transaction, newest first */
    public async getTransactionLogs(transactionId: string, limit: number = 50): Promise<AuditLog[]> {
        return auditLogRepository.listForTransaction(transactionId, limit);
    }

    /** Audit logs for a user, newest first */
    public async getUserLogs(userId: string, limit: number = 50): Promise<AuditLog[]> {
        return auditLogRepository.listForUser(userId, limit);
    }
}

export default AuditLogService;
