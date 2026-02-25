import { model, Model, Schema, Document } from "mongoose";
import { MODEL_NAME } from "../common/constant";

export interface IIdempotencyKey extends Document {
    key: string;
    userId: Schema.Types.ObjectId;
    transactionId?: Schema.Types.ObjectId;
    expiresAt: Date;
    createdAt: Date;
}

/**
 * Mongoose schema for IdempotencyKey model
 *
 * @description Stores idempotency keys to prevent duplicate transaction creation
 */
export const IdempotencyKeySchema = new Schema<IIdempotencyKey>(
    {
        /**
         * Unique idempotency key (provided by client)
         * @type {string}
         * @required
         * @unique
         */
        key: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            index: true
        },

        /**
         * Reference to the user who created the transaction
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
         * Reference to the transaction created with this key
         * @type {ObjectId}
         * @ref Transaction
         */
        transactionId: {
            type: Schema.Types.ObjectId,
            ref: MODEL_NAME.TRANSACTION,
            index: true
        },

        /**
         * Expiration timestamp for the idempotency key
         * @type {Date}
         * @required
         */
        expiresAt: {
            type: Date,
            required: true,
            index: { expireAfterSeconds: 0 } // TTL index for automatic deletion
        }
    },
    {
        timestamps: true
    }
);

// Compound index for efficient lookups
IdempotencyKeySchema.index({ userId: 1, key: 1 });
IdempotencyKeySchema.index({ expiresAt: 1 });

/**
 * IdempotencyKey Model based on IIdempotencyKey interface
 *
 * @description Creates and exports the Mongoose model for IdempotencyKey
 * @type {Model<IIdempotencyKey>}
 */
const IdempotencyKey = model<IIdempotencyKey>(MODEL_NAME.IDEMPOTENCY_KEY || "IdempotencyKey", IdempotencyKeySchema);

export default IdempotencyKey;
