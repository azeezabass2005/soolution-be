import { Model, model, Schema } from "mongoose";
import { MODEL_NAME } from "../common/constant";
import { PAYMENT_LINK_CURRENCIES, PAYMENT_LINK_DESCRIPTION_MAX, PAYMENT_LINK_TITLE_MAX, PAYMENT_LINK_TO_CURRENCY, PAYMENT_LINK_USAGE } from "../common/payment-link.constants";
import { IPaymentLink } from "./interface";

const paymentLinkSchema = new Schema<IPaymentLink>(
    {
        user: { type: Schema.Types.ObjectId, ref: MODEL_NAME.USER, required: true, index: true },
        slug: { type: String, required: true, unique: true, trim: true },
        currency: { type: String, required: true, enum: PAYMENT_LINK_CURRENCIES },
        toCurrency: { type: String, required: true, default: PAYMENT_LINK_TO_CURRENCY },
        /** Unset means the payer chooses the amount */
        amount: { type: Number, min: 0 },
        /** What the payer is paying for, shown as the page heading. Empty means "Pay {owner's name}". */
        title: { type: String, trim: true, maxlength: PAYMENT_LINK_TITLE_MAX },
        /** Older links: the note from before titles. Shown as the title when there isn't one. */
        description: { type: String, trim: true, maxlength: PAYMENT_LINK_DESCRIPTION_MAX },
        active: { type: Boolean, default: true },
        usage: { type: String, enum: Object.values(PAYMENT_LINK_USAGE), default: PAYMENT_LINK_USAGE.REUSABLE },
    },
    { timestamps: true }
);

paymentLinkSchema.index({ user: 1, createdAt: -1 });

const PaymentLink: Model<IPaymentLink> = model<IPaymentLink>(MODEL_NAME.PAYMENT_LINK, paymentLinkSchema);

export default PaymentLink;
