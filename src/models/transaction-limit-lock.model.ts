import { model, Model, Schema } from "mongoose";
import { MODEL_NAME } from "../common/constant";

export interface ITransactionLimitLock {
    /** One lock per user: the user's id */
    _id: string;
    /** Identifies the holder, so only it can release the lock */
    token: string;
    expiresAt: Date;
}

/**
 * Short-lived per-user lock held while a transaction is checked against the
 * daily limit and created, so parallel requests can't both pass the check.
 * Expired locks are taken over; stale documents are removed by the TTL index.
 */
const TransactionLimitLockSchema = new Schema<ITransactionLimitLock>(
    {
        _id: { type: String, required: true },
        token: { type: String, required: true },
        expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 3600 } },
    },
    { versionKey: false }
);

const TransactionLimitLock: Model<ITransactionLimitLock> = model<ITransactionLimitLock>(
    MODEL_NAME.TRANSACTION_LIMIT_LOCK,
    TransactionLimitLockSchema
);
export default TransactionLimitLock;
