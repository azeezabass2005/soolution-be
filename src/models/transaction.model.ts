import mongoose, { model, Model, Schema } from "mongoose";
import { ITransaction, TransactionStatus, DetailType } from "./interface";
import {DETAIL_TYPE, MODEL_NAME, TRANSACTION_STATUS} from "../common/constant";
import paginate from "mongoose-paginate-v2";

// Constants for validation
export const TRANSACTION_STATUSES = Object.values(TRANSACTION_STATUS);
export const DETAIL_TYPES = Object.values(DETAIL_TYPE);

/**
 * Mongoose schema for Transaction model
 *
 * @description Creates a schema for transactions with flexible detail handling
 */
export const TransactionSchema = new Schema<ITransaction>(
    {
        /**
         * Reference to the user who initiated the transaction
         * @type {ObjectId}
         * @ref User
         * @required
         */
        user: {
            type: Schema.Types.ObjectId,
            ref: MODEL_NAME.USER,
            required: true,
            index: true
        },

        /**
         * Unique transaction reference/identifier
         * @type {string}
         * @required
         * @unique
         */
        reference: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            maxlength: 100
        },

        /**
         * Transaction amount
         * @type {number}
         * @required
         * @min 0
         */
        amount: {
            type: Number,
            required: true,
            min: [0, 'Amount must be positive'],
            validate: {
                validator: function(value: number) {
                    return Number.isFinite(value) && value > 0;
                },
                message: 'Amount must be a valid positive number'
            }
        },


        /**
         * Currency code (e.g., USD, NGN, GHS, CNY)
         * @type {string}
         * @required
         */
        currency: {
            type: String,
            required: true,
            uppercase: true,
            trim: true,
            minlength: 3,
            maxlength: 4,
            match: [/^[A-Z]{3,4}$/, 'Currency must be a 3-letter code or 4 for USDT']
        },

        /**
         * From currency code (e.g., USD, NGN, GHS, CNY)
         * @type {string}
         * @required
         */
        fromCurrency: {
            type: String,
            required: true,
            uppercase: true,
            trim: true,
            minlength: 3,
            maxlength: 4,
            match: [/^[A-Z]{3,4}$/, 'Currency must be a 3-letter code or 4 for USDT']
        },



        /**
         * Type of transaction detail
         * @type {string}
         * @enum DetailType
         * @required
         */
        detailType: {
            type: String,
            enum: DETAIL_TYPES,
            required: true
        },

        /**
         * Current status of the transaction
         * @type {string}
         * @enum TransactionStatus
         * @required
         * @default "PENDING"
         */
        status: {
            type: String,
            enum: TRANSACTION_STATUSES,
            required: true,
            default: TRANSACTION_STATUS.PENDING
        },

        /**
         * When the transaction was initiated
         * @type {Date}
         * @required
         * @default Date.now
         */
        initiatedAt: {
            type: Date,
            required: true,
            default: Date.now
        },

        /**
         * When the transaction was completed
         * @type {Date}
         * @optional
         */
        completedAt: {
            type: Date
        },

        /**
         * When the transaction failed
         * @type {Date}
         * @optional
         */
        failedAt: {
            type: Date
        }
    },
    {
        /** Enable virtual properties when converting to plain object */
        toObject: { virtuals: true },

        /** Enable virtual properties when converting to JSON */
        toJSON: { virtuals: true },

        /** Automatically manage createdAt and updatedAt timestamps */
        timestamps: true,

        /** Optimize for queries */
        collection: 'transactions'
    }
);

TransactionSchema.plugin(paginate);

// ============= INDEXES =============

// Compound index for efficient user-based queries
TransactionSchema.index({ user: 1, status: 1, detailType: 1 });

// Reference index for quick lookups
TransactionSchema.index({ reference: 1 });

// Status and date indexes for reporting and filtering
TransactionSchema.index({ status: 1, initiatedAt: -1 });
TransactionSchema.index({ detailType: 1, initiatedAt: -1 });

// Date-based indexes for time-range queries
TransactionSchema.index({ initiatedAt: -1 });
TransactionSchema.index({ completedAt: -1 });

// Amount and currency index for financial reporting
TransactionSchema.index({ currency: 1, amount: 1 });

// ============= VIRTUALS =============

/**
 * Virtual field to populate the transaction details
 */
TransactionSchema.virtual("details", {
    ref: MODEL_NAME.TRANSACTION_DETAIL,     // The model to use
    localField: "_id",            // Transaction._id
    foreignField: "transactionId",// TransactionDetail.transactionId
    justOne: true                 // Important: only ONE detail per transaction
});

/**
 * Virtual property to check if transaction is pending
 */
TransactionSchema.virtual('isPending').get(function() {
    return this.status === TRANSACTION_STATUS.PENDING;
});

/**
 * Virtual property to check if transaction is completed
 */
TransactionSchema.virtual('isCompleted').get(function() {
    return this.status === TRANSACTION_STATUS.COMPLETED;
});

/**
 * Virtual property to check if transaction is failed
 */
TransactionSchema.virtual('isFailed').get(function() {
    return this.status === TRANSACTION_STATUS.FAILED;
});

/**
 * Virtual property to get processing duration in milliseconds
 */
TransactionSchema.virtual('processingDuration').get(function() {
    if (!this.completedAt && !this.failedAt) return null;

    const endTime = this.completedAt || this.failedAt;
    return endTime!.getTime() - this.initiatedAt.getTime();
});

/**
 * Virtual property to format amount with currency
 */
TransactionSchema.virtual('formattedAmount').get(function() {
    return `${this.currency} ${this.amount.toFixed(2)}`;
});

// ============= METHODS =============

/**
 * Method to mark transaction as completed
 */
TransactionSchema.methods.markAsCompleted = function() {
    this.status = TRANSACTION_STATUS.COMPLETED;
    this.completedAt = new Date();
    this.failedAt = undefined;
    return this.save();
};

/**
 * Method to mark transaction as failed
 */
TransactionSchema.methods.markAsFailed = function() {
    this.status = TRANSACTION_STATUS.FAILED;
    this.failedAt = new Date();
    this.completedAt = undefined;
    return this.save();
};

/**
 * Method to mark transaction as processing
 */
TransactionSchema.methods.markAsProcessing = function() {
    this.status = TRANSACTION_STATUS.PROCESSING;
    this.completedAt = undefined;
    this.failedAt = undefined;
    return this.save();
};

/**
 * Method to check if transaction can be updated
 */
TransactionSchema.methods.canBeUpdated = function() {
    return this.status === TRANSACTION_STATUS.PENDING || this.status === TRANSACTION_STATUS.PROCESSING;
};

// ============= MIDDLEWARE =============

/**
 * Pre-save middleware for transaction validation and processing
 */
TransactionSchema.pre('save', function(next) {
    // Ensure only one completion timestamp is set
    if (this.status === TRANSACTION_STATUS.COMPLETED) {
        if (!this.completedAt) {
            this.completedAt = new Date();
        }
        this.failedAt = undefined;
    } else if (this.status === TRANSACTION_STATUS.FAILED) {
        if (!this.failedAt) {
            this.failedAt = new Date();
        }
        this.completedAt = undefined;
    } else if (this.status === TRANSACTION_STATUS.PENDING || this.status === TRANSACTION_STATUS.PROCESSING) {
        this.completedAt = undefined;
        this.failedAt = undefined;
    }

    next();
});


/**
 * Transaction Model based on ITransaction interface
 *
 * @description Creates and exports the Mongoose model for Transaction
 * @type {Model<ITransaction>}
 */
const Transaction: Model<ITransaction> = model<ITransaction>(MODEL_NAME.TRANSACTION, TransactionSchema);
export default Transaction;
