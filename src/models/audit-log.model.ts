import { model, Model, Schema, Document } from "mongoose";
import { MODEL_NAME } from "../common/constant";

export interface IAuditLog extends Document {
    transactionId?: Schema.Types.ObjectId;
    userId: Schema.Types.ObjectId;
    action: string;
    beforeValue?: any;
    afterValue?: any;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, any>;
    createdAt: Date;
}

/**
 * Mongoose schema for AuditLog model
 *
 * @description Stores audit logs for all transaction status changes and critical operations
 */
export const AuditLogSchema = new Schema<IAuditLog>(
    {
        /**
         * Reference to the transaction (if applicable)
         * @type {ObjectId}
         * @ref Transaction
         */
        transactionId: {
            type: Schema.Types.ObjectId,
            ref: MODEL_NAME.TRANSACTION,
            index: true
        },

        /**
         * Reference to the user who performed the action
         * @type {ObjectId}
         * @ref User
         * @required
         */
        userId: {
            type: Schema.Types.ObjectId,
            ref: MODEL_NAME.USER,
            required: true,
            index: true
        },

        /**
         * Action performed (e.g., 'status_change', 'receipt_upload', 'transaction_created', 'transaction_completed')
         * @type {string}
         * @required
         */
        action: {
            type: String,
            required: true,
            index: true
        },

        /**
         * Value before the change (for status changes, amount changes, etc.)
         * @type {any}
         */
        beforeValue: {
            type: Schema.Types.Mixed
        },

        /**
         * Value after the change
         * @type {any}
         */
        afterValue: {
            type: Schema.Types.Mixed
        },

        /**
         * IP address of the user who performed the action
         * @type {string}
         */
        ipAddress: {
            type: String
        },

        /**
         * User agent of the client
         * @type {string}
         */
        userAgent: {
            type: String
        },

        /**
         * Additional metadata for the audit log
         * @type {Object}
         */
        metadata: {
            type: Schema.Types.Mixed
        }
    },
    {
        timestamps: true
    }
);

// Compound indexes for efficient querying
AuditLogSchema.index({ transactionId: 1, createdAt: -1 });
AuditLogSchema.index({ userId: 1, createdAt: -1 });
AuditLogSchema.index({ action: 1, createdAt: -1 });
AuditLogSchema.index({ createdAt: -1 }); // For time-based queries

/**
 * AuditLog Model based on IAuditLog interface
 *
 * @description Creates and exports the Mongoose model for AuditLog
 * @type {Model<IAuditLog>}
 */
const AuditLog = model<IAuditLog>(MODEL_NAME.AUDIT_LOG || "AuditLog", AuditLogSchema);

export default AuditLog;
