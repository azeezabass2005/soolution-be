import mongoose, { model, Model, Schema } from "mongoose";
import { ITransactionDetail, DetailType, AlipayPlatform } from "./interface";
import {ALIPAY_PLATFORM, DETAIL_TYPE, MODEL_NAME} from "../common/constant";
import paginate from "mongoose-paginate-v2";

// Constants for validation
export const DETAIL_TYPES = Object.values(DETAIL_TYPE);
export const ALIPAY_PLATFORMS = Object.values(ALIPAY_PLATFORM);

/**
 * Mongoose schema for TransactionDetail model
 *
 * @description Creates a schema for transaction details with type-specific data
 */
export const TransactionDetailSchema = new Schema<ITransactionDetail>(
    {
        /**
         * Reference to the associated transaction
         * @type {ObjectId}
         * @ref Transaction
         * @required
         */
        transactionId: {
            type: Schema.Types.ObjectId,
            ref: 'Transaction',
            required: true,
            index: true
        },

        /**
         * Type of transaction detail
         * @type {string}
         * @enum DETAIL_TYPE
         * @required
         */
        type: {
            type: String,
            enum: DETAIL_TYPES,
            required: true
        },

        // ============= ALIPAY SPECIFIC FIELDS =============

        /**
         * Alipay platform used for the transaction
         * @type {string}
         * @enum AlipayPlatform
         * @optional
         */
        platform: {
            type: String,
            enum: ALIPAY_PLATFORMS,
            required: function() {
                return this.type === DETAIL_TYPE.ALIPAY;
            }
        },

        /**
         * Alipay account number
         * @type {string}
         * @optional
         */
        alipayNo: {
            type: String,
            trim: true,
            maxlength: 50,
            required: false
        },

        /**
         * Alipay account name
         * @type {string}
         * @optional
         */
        alipayName: {
            type: String,
            trim: true,
            maxlength: 100,
            required: false
        },

        /**
         * QR code URL for Alipay payment
         * @type {string}
         * @optional
         */
        qrCodeUrl: {
            type: String,
            trim: true,
            match: [/^https?:\/\/.+/, 'Please enter a valid URL']
        },

        /**
         * Receipt URL uploaded by user after paying to admin designated account.
         * @type {string}
         * @optional
         */
        payInReceiptUrl: {
            type: String,
            trim: true,
            match: [/^https?:\/\/.+/, 'Please enter a valid URL']
        },

        /**
         * Payment receipt URL uploaded by admin for paying to the alipay account the user specify
         * @type {string}
         * @optional
         */
        payOutReceiptUrl: {
            type: String,
            trim: true,
            match: [/^https?:\/\/.+/, 'Please enter a valid URL']
        },

                /**
         * Amount of the currency the user is converting from
         * @type {number}
         * @optional
         * @min 0
         */
        fromAmount: {
            type: Number,
            min: [0, 'Amount must be positive'],
            validate: {
                validator: function(value: number) {
                    return Number.isFinite(value) && value > 0;
                },
                message: 'Amount must be a valid positive number'
            }
        },

        /**
         * Bank account details the user is to pay into
         * @type {IBankAccountDetails}
         */
        bankAccountDetails: {
            type: Schema.Types.Mixed,
            default: {}
        }

        // TODO: Add other transaction detail types here as needed
        // Example: Bank transfer details, Card payment details, etc.
    },
    {
        /** Enable virtual properties when converting to plain object */
        toObject: { virtuals: true },

        /** Enable virtual properties when converting to JSON */
        toJSON: { virtuals: true },

        /** Automatically manage createdAt and updatedAt timestamps */
        timestamps: true,

        /** Optimize for queries */
        collection: 'transactiondetails'
    }
);

TransactionDetailSchema.plugin(paginate);

// ============= INDEXES =============

// Primary index for transaction-based queries
TransactionDetailSchema.index({ transactionId: 1, type: 1 });

// Type-based index for filtering details by type
TransactionDetailSchema.index({ type: 1 });

// Alipay-specific indexes
TransactionDetailSchema.index({ platform: 1, alipayNo: 1 });
TransactionDetailSchema.index({ alipayNo: 1 }, { sparse: true });

// Compound index for efficient type-specific queries
TransactionDetailSchema.index({ type: 1, platform: 1 }, { sparse: true });

// ============= METHODS =============

/**
 * Method to validate required fields based on type
 */
TransactionDetailSchema.methods.validateRequiredFields = function() {
    if (this.type === DETAIL_TYPE.ALIPAY) {
        const missing = [];
        if (!this.platform) missing.push('platform');
        // alipayNo is now optional
        // if (!this.alipayNo) missing.push('alipayNo');
        // alipayName is now optional
        // if (!this.alipayName) missing.push('alipayName');

        if (missing.length > 0) {
            throw new Error(`Missing required Alipay fields: ${missing.join(', ')}`);
        }
    }

    return true;
};


// TODO: I will come back to the type issue here when we have  another detail type to add
/**
 * Pre-save middleware for validation and data processing
 */
// TransactionDetailSchema.pre('save', function(next) {
//     try {
//         // Validate required fields based on type
//         this.validateRequiredFields();
//
//         // Clean up fields that don't apply to current type
//         if (this.type !== DETAIL_TYPE.ALIPAY) {
//             this.platform = undefined;
//             this.alipayNo = undefined;
//             this.alipayName = undefined;
//             this.qrCodeUrl = undefined;
//         }
//
//         next();
//     } catch (error) {
//         next(error as Error);
//     }
// });

/**
 * TransactionDetail Model based on ITransactionDetail interface
 *
 * @description Creates and exports the Mongoose model for TransactionDetail
 * @type {Model<ITransactionDetail>}
 */
const TransactionDetail: Model<ITransactionDetail> = model<ITransactionDetail>(
    MODEL_NAME.TRANSACTION_DETAIL,
    TransactionDetailSchema
);

export default TransactionDetail;