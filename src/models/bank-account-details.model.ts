import {Model, model, Schema} from "mongoose";
import {MODEL_NAME} from "../common/constant";
import {IBankAccountDetails} from "./interface";

const bankAccountDetailsSchema = new Schema<IBankAccountDetails>({
    /**
     * Optional reference to the user who owns this account (null = admin/company account)
     */
    user: {
        type: Schema.Types.ObjectId,
        ref: MODEL_NAME.USER,
        default: null
    },
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
    accountNumber: { type: String, required: true, trim: true },

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
     * Provider bank code (Paystack bank code for NGN, YellowCard network id elsewhere),
     * set when the bank was picked from the list
     * @type {string}
     */
    bankCode: { type: String, trim: true },

    /**
     * To know if the details is the default for the currency
     * @type {boolean}
     */
    isDefault: { type: Boolean, default: false }
}, {
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
    timestamps: true,
});

const BankAccount: Model<IBankAccountDetails> = model<IBankAccountDetails>(MODEL_NAME.BANK_ACCOUNT_DETAIL, bankAccountDetailsSchema);

export default BankAccount;