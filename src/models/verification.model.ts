import mongoose, { Model, Schema } from "mongoose";
import { IVerification } from "./interface";
import { MODEL_NAME } from "../common/constant";
import { model } from "mongoose";

export const VerificationSchema = new Schema<IVerification>(
    {
        /**
         * The user's id
         * @type {mongoose.Types.ObjectId}
         * @required
         */
        user: {
            type: mongoose.Types.ObjectId,
            ref: MODEL_NAME.USER,
            required: true,
        },

        /**
         * The verification job id
         * @type {string}
         * @optional
         */
        jobId: {
            type: String,
            required: false
        },

        /**
         * The current status of the verification
         * @type {string}
         * @enum 'pending' 'failed' | 'passed'
         * @optional
         */
        status: {
            type: String,
            enum: ['pending', 'failed', 'passed'],
            default: 'pending'
        },

        /**
         * Reason for the current status
         * @type {string}
         * @optional
         */
        reason: {
            type: String,
        },

        /** What was checked; older records (before BVN checks) have none */
        kind: { type: String, enum: ['bvn'] },

        /** Keyed hash and last 4 digits of the submitted BVN (never the BVN itself) */
        idHash: { type: String, select: false },
        idLast4: { type: String },

        /** Smile ID's own job ID, result code and per-check outcomes, for support */
        smileJobId: { type: String },
        resultCode: { type: String },
        resultText: { type: String },
        actions: { type: Schema.Types.Mixed },

        /** Name the BVN is registered to */
        nameOnId: { type: String },

        /** Where the final result came from */
        resultSource: { type: String, enum: ['webhook', 'poll'] },
        completedAt: { type: Date },
        lastPolledAt: { type: Date },

        /** Set when an admin resets attempts, so this failure no longer counts */
        excludedFromAttempts: { type: Boolean, default: false },
    },
    {
        /** Enable virtual properties when converting to plain object */
        toObject: { virtuals: true },

        /** Enable virtual properties when converting to JSON */
        toJSON: { virtuals: true },

        /** Automatically manage createdAt and updatedAt timestamps */
        timestamps: true,
    }
)

VerificationSchema.index({ user: 1, createdAt: -1 });
// At most one BVN check in flight per user
VerificationSchema.index({ user: 1, kind: 1 }, { unique: true, partialFilterExpression: { kind: 'bvn', status: 'pending' } });

const Verification: Model<IVerification> = model<IVerification>(MODEL_NAME.VERIFICATION, VerificationSchema);
export default Verification;