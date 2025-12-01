import { Schema, model, Model } from 'mongoose';
import { IRefreshToken } from './interface';
import { MODEL_NAME } from '../common/constant';

/**
 * Mongoose schema for RefreshToken model
 *
 * @description Manages refresh tokens for user authentication and session management
 * @remarks
 * - Tracks user sessions with metadata like userAgent and ipAddress
 * - Includes timestamps for creation and update tracking
 */
export const RefreshTokenSchema = new Schema<IRefreshToken>(
    {
        /**
         * Reference to the User associated with the refresh token
         * @type {ObjectId}
         * @required
         */
        userId: { type: Schema.Types.ObjectId, ref: MODEL_NAME.USER, required: true },

        /**
         * Unique token string for authentication
         * @type {string}
         * @required
         */
        token: { type: String, required: true, unique: true },

        /**
         * Expiration date for the token
         * @type {Date}
         * @required
         */
        expiresAt: { type: Date, required: true },

        /**
         * Indicates whether the token is revoked
         * @type {boolean}
         * @default false
         */
        isRevoked: { type: Boolean, default: false },

        /**
         * User agent string from the client when the token was issued
         * @type {string}
         * @optional
         */
        userAgent: { type: String },

        /**
         * IP address from the client when the token was issued
         * @type {string}
         * @optional
         */
        ipAddress: { type: String },
    },
    {
        /** Automatically manage createdAt and updatedAt timestamps */
        timestamps: true,
    }
);

/**
 * RefreshToken model based on IRefreshToken interface
 *
 * @description Creates and exports the Mongoose model for RefreshToken
 * @type {Model<IRefreshToken>}
 */
const RefreshToken: Model<IRefreshToken> = model<IRefreshToken>(MODEL_NAME.REFRESH_TOKEN, RefreshTokenSchema);
export default RefreshToken;
