import { model, Model, Schema } from "mongoose";
import { IWallet, WalletStatus } from "./interface";
import { MODEL_NAME, WALLET_STATUS } from "../common/constant";

const WALLET_STATUSES = Object.values(WALLET_STATUS);

export const WalletSchema = new Schema<IWallet>(
    {
        user: {
            type: Schema.Types.ObjectId,
            ref: MODEL_NAME.USER,
            required: true,
            index: true
        },
        currency: {
            type: String,
            required: true,
            default: 'NGN',
            enum: ['NGN']
        },
        balance: {
            type: Number,
            required: true,
            default: 0,
            min: [0, 'Balance cannot be negative']
        },
        ledgerBalance: {
            type: Number,
            required: true,
            default: 0,
            min: [0, 'Ledger balance cannot be negative']
        },
        status: {
            type: String,
            enum: WALLET_STATUSES,
            required: true,
            default: WALLET_STATUS.ACTIVE
        },

        // Paystack customer & DVA
        paystackCustomerCode: { type: String },
        paystackCustomerId: { type: Number },
        dvaBankName: { type: String },
        dvaAccountNumber: { type: String, index: true },
        dvaAccountName: { type: String },
        dvaBankId: { type: Number },
        dvaId: { type: Number },
        isDVAProvisioned: { type: Boolean, default: false },

        // PIN security
        pinHash: { type: String, select: false },
        isPinSet: { type: Boolean, default: false },
        pinAttempts: { type: Number, default: 0 },
        pinLockedUntil: { type: Date }
    },
    {
        toObject: { virtuals: true },
        toJSON: { virtuals: true },
        timestamps: true,
        collection: 'wallets'
    }
);

// Unique: one wallet per user per currency
WalletSchema.index({ user: 1, currency: 1 }, { unique: true });
WalletSchema.index({ paystackCustomerCode: 1 });

// Virtual: check if PIN is currently locked
WalletSchema.virtual('isLocked').get(function () {
    if (!this.pinLockedUntil) return false;
    return this.pinLockedUntil.getTime() > Date.now();
});

const Wallet: Model<IWallet> = model<IWallet>(MODEL_NAME.WALLET, WalletSchema);
export default Wallet;
