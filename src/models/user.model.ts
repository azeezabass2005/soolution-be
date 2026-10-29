import { Schema, model, Model } from 'mongoose';
import { IUser } from './interface';
import { MODEL_NAME, ROLE_MAP } from '../common/constant';
import { USER_TIER, USER_TIERS } from '../common/tier.constants';
import { IDENTITY_STATUS, IDENTITY_STATUSES } from '../common/identity.constants';

/**
 * Mongoose schema for User model
 *
 * @description Creates a schema for user authentication and basic information
 * @remarks
 * - Includes timestamps for creation and update tracking
 * - Enables virtual property transformations
 */
export const UserSchema = new Schema<IUser>(
    {
        /**
         * Hashed password for user authentication
         * @type {string}
         * @required
         */
        password: { type: String, required: true, select: false },

        /**
         * Email for user authentication
         * @type {string}
         * @required
         */
        email: { type: String, required: true },

        /**
         * First Name of the User
         * @type {string}
         * @required
         */
        firstName: { type: String, required: true },

        /**
         * First Name of the User
         * @type {string}
         * @required
         */
        lastName: { type: String, required: true },

        /**
         * Email verification status
         * @type {boolean}
         * @default false
         */
        isVerified: { type: Boolean, default: false },

        /**
         * Account tier: 0 Unverified (default, can't transact), 1 Individual (BVN verified),
         * 2 Business, 3 Institution. Decides the daily transaction limit.
         * @type {number}
         * @default 0
         */
        tier: { type: Number, enum: USER_TIERS, default: USER_TIER.UNVERIFIED, index: true },

        /**
         * Identity verification (BVN with Smile ID) that unlocks Tier 1.
         * The BVN itself is never stored: only a keyed hash (one BVN per
         * account) and its last 4 digits for display.
         */
        identity: {
            type: {
                _id: false,
                status: { type: String, enum: IDENTITY_STATUSES, default: IDENTITY_STATUS.UNVERIFIED },
                bvnHash: { type: String, select: false },
                bvnLast4: { type: String },
                /** Name returned for the BVN */
                verifiedName: { type: String },
                verifiedAt: { type: Date },
                /** How it was verified: Smile ID, an earlier check or KYC review */
                method: { type: String },
                failureReason: { type: String },
            },
            default: () => ({ status: IDENTITY_STATUS.UNVERIFIED }),
        },

        /**
         * Tier changes: approvals and admin overrides
         */
        tierHistory: {
            type: [{
                _id: false,
                tier: { type: Number, enum: USER_TIERS, required: true },
                reason: { type: String, required: true },
                by: { type: Schema.Types.ObjectId, ref: MODEL_NAME.USER },
                at: { type: Date, default: Date.now },
            }],
            default: undefined,
        },

        /**
         * KYC verification status
         * @type {boolean}
         * @default false
         */
        isKYCDone: { type: Boolean, default: false },

        /**
         * KYC rejection status
         * @type {boolean}
         * @default false
         */
        isKYCRejected: { type: Boolean, default: false },

        /**
         * Reason for KYC rejection
         * @type {string}
         * @optional
         */
        kycRejectionReason: { type: String },


        /**
         * Account registration progress
         * @type {boolean}
         * @default false
         */
        isCompleted: { type: Boolean, default: false },

        /**
         * Role to manage authorization to resources
         * @type {number}
         * @required
         * @default ROLE_MAP.USER
         */
        role: { type: Number, enum: Object.values(ROLE_MAP), default: ROLE_MAP.USER },

        /**
         * User account status
         * @type {string}
         * @enum UserStatus
         */
        status: { type: String, enum: ['active', 'inactive', 'suspended', 'pending', 'deactivated'], default: 'active' },
        /** Tokens issued before this are refused (signing out everywhere, password reset, reused refresh token) */
        sessionsValidAfter: { type: Date },

        /**
         * Last login timestamp
         * @type {string}
         */
        lastLogin: { type: String },

        /**
         * User's phone number
         * @type {string}
         */
        phoneNumber: { type: String },

        /**
         * User's whatsapp number for whatsapp related notifications
         * @type {string}
         */
        whatsappNumber: { type: String },

        /**
         * User's country of origin
         * @type {string}
         * @optional
         */
        countryOfOrigin: { type: String },

        /**
         * User's country of residence
         * @type {string}
         * @optional
         */
        countryOfResidence: { type: String },

        /**
         * Purpose of account usage
         * @type {string}
         * @enum ['business', 'personal', 'travel', 'investment', 'savings', 'others'] ('spending' on older accounts)
         * @optional
         */
        purpose: { type: String, enum: ['business', 'personal', 'travel', 'investment', 'savings', 'others', 'spending'] },

        /**
         * Type of business if purpose is business
         * @type {string}
         * @enum ['creators', 'retail-sales', 'software', 'services', 'entertainment', 'media', 'payments', 'others']
         * @optional
         */
        typeOfBusiness: { type: String, enum: ['creators', 'retail-sales', 'software', 'services', 'entertainment', 'media', 'payments', 'others'] },

        /**
         * Expected monthly transaction volume
         * @type {string}
         * @optional
         */
        monthlyVolume: { type: String },

        /**
         * How user heard about the service
         * @type {string}
         * @enum ['friends', 'ads', 'others']
         * @optional
         */
        hearAboutUs: { type: String, enum: ['friends', 'ads', 'search-engines', 'social-media', 'referrals', 'events', 'youtube', 'instagram', 'x-twitter', 'facebook', 'tiktok', 'google', 'others'] },

        /**
         * Free-text specification when hearAboutUs is 'others'
         * @type {string}
         * @optional
         */
        hearAboutUsOther: { type: String },

        // ===================== TRANSACTION PIN =====================
        // Single 4-digit PIN per user, required to authorize any outbound
        // money movement (Alipay send, bank-transfer SEND, YellowCard send,
        // wallet withdrawal). Hash is excluded from default queries.
        transactionPinHash: { type: String, select: false },
        isTransactionPinSet: { type: Boolean, default: false },
        transactionPinAttempts: { type: Number, default: 0 },
        transactionPinLockedUntil: { type: Date },
    },
    {
        /** Enable virtual properties when converting to plain object */
        toObject: { virtuals: true },

        /** Enable virtual properties when converting to JSON */
        toJSON: { virtuals: true },

        /** Automatically manage createdAt and updatedAt timestamps */
        timestamps: true,
    }
);

// One BVN per account: only verified accounts carry the hash
UserSchema.index(
    { 'identity.bvnHash': 1 },
    { unique: true, partialFilterExpression: { 'identity.bvnHash': { $type: 'string' } } }
);

// Virtual: PIN is currently locked due to too many failed attempts
UserSchema.virtual('isTransactionPinLocked').get(function (this: IUser) {
    if (!this.transactionPinLockedUntil) return false;
    return this.transactionPinLockedUntil.getTime() > Date.now();
});

/**
 * User model based on IUser interface
 *
 * @description Creates and exports the Mongoose model for User
 * @type {Model<IUser>}
 */
const User: Model<IUser> = model<IUser>(MODEL_NAME.USER, UserSchema);
export default User;