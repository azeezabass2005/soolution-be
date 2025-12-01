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
        }
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

const Verification: Model<IVerification> = model<IVerification>(MODEL_NAME.VERIFICATION, VerificationSchema);
export default Verification;