import { Model, model, Schema } from "mongoose";
import { MODEL_NAME } from "../common/constant";
import { BENEFICIARY_CURRENCIES, BENEFICIARY_KIND } from "../common/beneficiary.constants";
import { IBeneficiary } from "./interface";

const beneficiarySchema = new Schema<IBeneficiary>(
    {
        user: { type: Schema.Types.ObjectId, ref: MODEL_NAME.USER, required: true, index: true },
        /** Currency the beneficiary receives */
        currency: { type: String, required: true, enum: BENEFICIARY_CURRENCIES },
        kind: { type: String, required: true, enum: Object.values(BENEFICIARY_KIND) },
        /** Optional label, e.g. "Mum" or "Guangzhou supplier" */
        nickname: { type: String, trim: true },

        // Bank
        bankName: { type: String, trim: true },
        /** Provider bank code (Paystack code for NGN, YellowCard network id elsewhere) when picked from the list */
        bankCode: { type: String, trim: true },
        /** Kept as a string so leading zeros survive */
        accountNumber: { type: String, trim: true },
        accountName: { type: String, trim: true },

        // Mobile money
        momoNetwork: { type: String, trim: true },
        momoNumber: { type: String, trim: true },
        momoName: { type: String, trim: true },

        // Alipay / WeChat
        alipayType: { type: String, trim: true },
        alipayNo: { type: String, trim: true },
        alipayName: { type: String, trim: true },
        /** Uploaded once and reused for every send to this beneficiary */
        qrCodeUrl: { type: String },

        lastUsedAt: { type: Date },
    },
    { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

beneficiarySchema.index({ user: 1, currency: 1, updatedAt: -1 });

const Beneficiary: Model<IBeneficiary> = model<IBeneficiary>(MODEL_NAME.BENEFICIARY, beneficiarySchema);

export default Beneficiary;
