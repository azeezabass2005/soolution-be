import {Model, model, Schema} from "mongoose";
import {MODEL_NAME} from "../common/constant";
import {IBankAccountDetails} from "./interface";

const bankAccountDetailsSchema = new Schema<IBankAccountDetails>({
    /**
     * Currency code fo the bank
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
     * Account Number
     * @type {number}
     * @required
     */
    accountNumber: { type: Number, required: true },

    /**
     * Account Name
     * @type {string}
     * @required
     */
    accountName: { type: String, required: true },

    /**
     * Bank Name
     * @type {string}
     * @required
     */
    bankName: { type: String, required: true },

    /**
     * To know if the details is the default for the currency
     * @type {boolean}
     */
    isDefault: { type: Boolean, default: false }
}, {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
});

const BankAccount: Model<IBankAccountDetails> = model<IBankAccountDetails>(MODEL_NAME.BANK_ACCOUNT_DETAIL, bankAccountDetailsSchema);

export default BankAccount;