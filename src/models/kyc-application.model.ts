import mongoose, { model, Model, Schema } from "mongoose";
import paginate from "mongoose-paginate-v2";
import { IKycApplication } from "./interface";
import { MODEL_NAME } from "../common/constant";
import { KYC_STATUS, KYC_TYPE } from "../common/kyc.constants";

const KycDocumentSchema = new Schema(
    {
        /** Which requirement this file satisfies, e.g. "certificate_of_incorporation" */
        slot: { type: String, required: true },
        /** Private storage key; URLs are signed on demand */
        key: { type: String, required: true },
        originalName: { type: String, required: true },
        mimeType: { type: String, required: true },
        size: { type: Number, required: true },
        issueDate: { type: Date },
        uploadedAt: { type: Date, default: Date.now },
    },
    { _id: false }
);

const KycReviewEventSchema = new Schema(
    {
        status: { type: String, enum: Object.values(KYC_STATUS), required: true },
        note: { type: String },
        by: { type: mongoose.Types.ObjectId, ref: MODEL_NAME.USER },
        at: { type: Date, default: Date.now },
    },
    { _id: false }
);

/**
 * A user's KYC (individual) or KYB (business) application.
 * Each step is saved as the user goes, so progress survives logouts.
 */
export const KycApplicationSchema = new Schema<IKycApplication>(
    {
        /**
         * The applicant; a user has at most one application
         * @type {mongoose.Types.ObjectId}
         * @required
         */
        user: { type: mongoose.Types.ObjectId, ref: MODEL_NAME.USER, required: true, unique: true },

        /**
         * Individual (KYC) or business (KYB)
         * @type {string}
         * @required
         */
        type: { type: String, enum: Object.values(KYC_TYPE), required: true },

        /**
         * Current status of the application
         * @type {string}
         * @default 'draft'
         */
        status: { type: String, enum: Object.values(KYC_STATUS), default: KYC_STATUS.DRAFT, index: true },

        /**
         * Business name or individual's full name, kept for admin listing and search
         * @type {string}
         */
        displayName: { type: String },

        /**
         * Data steps that passed full validation
         * @type {string[]}
         */
        completedSteps: { type: [String], default: [] },

        /** Business general information (KYB) */
        general: { type: Schema.Types.Mixed, default: {} },

        /** Personal information (KYC) */
        personal: { type: Schema.Types.Mixed, default: {} },

        /** Ultimate beneficial owners (KYB) */
        ubos: { type: Schema.Types.Mixed, default: [] },

        /** Directors (KYB) */
        directors: { type: Schema.Types.Mixed, default: [] },

        /** Yes/No compliance answers keyed by question */
        questionnaire: { type: Schema.Types.Mixed, default: {} },

        /** Uploaded documents, one per slot */
        documents: { type: [KycDocumentSchema], default: [] },

        /** Reason given by an admin when rejecting */
        rejectionReason: { type: String },

        submittedAt: { type: Date },
        reviewedAt: { type: Date },
        reviewedBy: { type: mongoose.Types.ObjectId, ref: MODEL_NAME.USER },

        /** Audit trail of submissions and admin decisions */
        history: { type: [KycReviewEventSchema], default: [] },
    },
    {
        /** Enable virtual properties when converting to plain object */
        toObject: { virtuals: true },

        /** Enable virtual properties when converting to JSON */
        toJSON: { virtuals: true },

        /** Automatically manage createdAt and updatedAt timestamps */
        timestamps: true,
        minimize: false,
    }
);

KycApplicationSchema.plugin(paginate);

const KycApplication: Model<IKycApplication> = model<IKycApplication>(MODEL_NAME.KYC_APPLICATION, KycApplicationSchema);
export default KycApplication;
