import { Schema, model, Model, Document } from 'mongoose';
import {
    MODEL_NAME,
    ACCOUNT_TYPE,
    ACCOUNT_STATUS,
} from '../common/constant';

export type AccountType = (typeof ACCOUNT_TYPE)[keyof typeof ACCOUNT_TYPE];
export type AccountStatus = (typeof ACCOUNT_STATUS)[keyof typeof ACCOUNT_STATUS];

export interface IAccount extends Document {
    code: string;
    type: AccountType;
    currency: string;
    name: string;
    ownerUser?: Schema.Types.ObjectId | string;
    ownerWallet?: Schema.Types.ObjectId | string;
    balance: number;
    isSystem: boolean;
    status: AccountStatus;
    description?: string;
    balanceUpdatedAt?: Date;
}

const AccountSchema = new Schema<IAccount>(
    {
        // Unique account code. System accounts use fixed identifiers
        // (e.g. SUSPENSE_NGN); per-user accounts use USER_WALLET_NGN:{userId}.
        code: { type: String, required: true, unique: true, trim: true, index: true },
        type: { type: String, enum: Object.values(ACCOUNT_TYPE), required: true, index: true },
        currency: { type: String, required: true, uppercase: true, trim: true, index: true },
        name: { type: String, required: true, trim: true },
        ownerUser: { type: Schema.Types.ObjectId, ref: MODEL_NAME.USER, index: true },
        ownerWallet: { type: Schema.Types.ObjectId, ref: MODEL_NAME.WALLET, index: true },
        // Cached projection of the account's true balance, which is the sum of
        // its journal entries. Refreshed atomically by LedgerService on every
        // post and by reconciliation jobs.
        balance: { type: Number, required: true, default: 0 },
        isSystem: { type: Boolean, default: false },
        status: { type: String, enum: Object.values(ACCOUNT_STATUS), default: ACCOUNT_STATUS.ACTIVE },
        description: { type: String },
        balanceUpdatedAt: { type: Date },
    },
    {
        toObject: { virtuals: true },
        toJSON: { virtuals: true },
        timestamps: true,
        collection: 'accounts',
    }
);

// Compound index for admin browsing (e.g. all NGN liability accounts)
AccountSchema.index({ type: 1, currency: 1 });

const Account: Model<IAccount> = model<IAccount>(MODEL_NAME.ACCOUNT, AccountSchema);
export default Account;
