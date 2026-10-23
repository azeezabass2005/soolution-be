import { model, Model, Schema } from "mongoose";
import { IWalletTransaction } from "./interface";
import { MODEL_NAME, WALLET_TRANSACTION_TYPE, WALLET_TRANSACTION_STATUS } from "../common/constant";
import paginate from "mongoose-paginate-v2";

const WALLET_TX_TYPES = Object.values(WALLET_TRANSACTION_TYPE);
const WALLET_TX_STATUSES = Object.values(WALLET_TRANSACTION_STATUS);

export const WalletTransactionSchema = new Schema<IWalletTransaction>(
    {
        wallet: {
            type: Schema.Types.ObjectId,
            ref: MODEL_NAME.WALLET,
            required: true,
            index: true
        },
        user: {
            type: Schema.Types.ObjectId,
            ref: MODEL_NAME.USER,
            required: true,
            index: true
        },
        type: {
            type: String,
            enum: WALLET_TX_TYPES,
            required: true
        },
        status: {
            type: String,
            enum: WALLET_TX_STATUSES,
            required: true,
            default: WALLET_TRANSACTION_STATUS.PENDING
        },
        amount: {
            type: Number,
            required: true,
            min: [0, 'Amount must be positive']
        },
        reference: {
            type: String,
            required: true,
            unique: true,
            trim: true
        },
        balanceBefore: {
            type: Number,
            required: true,
            min: 0
        },
        balanceAfter: {
            type: Number,
            required: true,
            min: 0
        },
        description: { type: String },

        // Paystack references
        paystackReference: { type: String, index: true },
        paystackTransferCode: { type: String, index: true },

        // Recipient bank details (withdrawals)
        recipientBankCode: { type: String },
        recipientBankName: { type: String },
        recipientAccountNumber: { type: String },
        recipientAccountName: { type: String },
        paystackRecipientCode: { type: String },

        // Failure/reversal info
        failureReason: { type: String },
        reversedTransactionId: {
            type: Schema.Types.ObjectId,
            ref: MODEL_NAME.WALLET_TRANSACTION
        },

        currency: { type: String, uppercase: true, trim: true },

        // Exchanges
        counterCurrency: { type: String, uppercase: true, trim: true },
        counterAmount: { type: Number, min: 0 },
        rate: { type: Number, min: 0 },
        fxQuoteId: { type: Schema.Types.ObjectId, ref: MODEL_NAME.FX_QUOTE },

        // Sends paid from this wallet
        sendNgnAmount: { type: Number, min: 0 },
        sendNgnFee: { type: Number, min: 0 },
        sendFee: { type: Number, min: 0 },
        providerAccountCode: { type: String },
        transactionId: { type: Schema.Types.ObjectId, ref: MODEL_NAME.TRANSACTION, index: true }
    },
    {
        toObject: { virtuals: true },
        toJSON: { virtuals: true },
        timestamps: true,
        collection: 'wallet_transactions'
    }
);

WalletTransactionSchema.plugin(paginate);

// Indexes
WalletTransactionSchema.index({ reference: 1 });
WalletTransactionSchema.index({ wallet: 1, createdAt: -1 });
WalletTransactionSchema.index({ user: 1, type: 1, createdAt: -1 });
WalletTransactionSchema.index({ paystackReference: 1 });
WalletTransactionSchema.index({ paystackTransferCode: 1 });

const WalletTransaction: Model<IWalletTransaction> = model<IWalletTransaction>(
    MODEL_NAME.WALLET_TRANSACTION,
    WalletTransactionSchema
);
export default WalletTransaction;
