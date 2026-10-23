import { Document, model, Model, Schema } from "mongoose";
import { MODEL_NAME } from "../common/constant";
import { WALLET_CURRENCIES } from "../common/wallet.constants";

export interface IFxQuote extends Document {
    user: Schema.Types.ObjectId | string;
    fromCurrency: string;
    toCurrency: string;
    /** What leaves the source wallet */
    fromAmount: number;
    /** What lands in the destination wallet */
    toAmount: number;
    /** NGN per 1 unit of the non-NGN currency (the rate the user saw) */
    rate: number;
    /** Before the platform markup, for revenue reporting */
    providerRate: number;
    rateSource: "yellowcard" | "ogateway" | "admin";
    expiresAt: Date;
    /** Set once the quote has been exchanged; a quote is single-use */
    usedAt?: Date;
    createdAt?: Date;
}

const FxQuoteSchema = new Schema<IFxQuote>(
    {
        user: { type: Schema.Types.ObjectId, ref: MODEL_NAME.USER, required: true, index: true },
        fromCurrency: { type: String, enum: WALLET_CURRENCIES, required: true },
        toCurrency: { type: String, enum: WALLET_CURRENCIES, required: true },
        fromAmount: { type: Number, required: true, min: 0 },
        toAmount: { type: Number, required: true, min: 0 },
        rate: { type: Number, required: true, min: 0 },
        providerRate: { type: Number, required: true, min: 0 },
        rateSource: { type: String, enum: ["yellowcard", "ogateway", "admin"], required: true },
        expiresAt: { type: Date, required: true },
        usedAt: { type: Date },
    },
    { timestamps: true, collection: "fx_quotes" }
);

// Expired quotes are useless after a day; let Mongo clean them up
FxQuoteSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

const FxQuote: Model<IFxQuote> = model<IFxQuote>(MODEL_NAME.FX_QUOTE, FxQuoteSchema);
export default FxQuote;
