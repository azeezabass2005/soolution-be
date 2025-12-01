import { Schema, model, Model } from 'mongoose';
import { IUser } from './interface';
import { MODEL_NAME, ROLE_MAP } from '../common/constant';

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
         * KYC verification status
         * @type {boolean}
         * @default false
         */
        isKYCDone: { type: Boolean, default: false },


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
         * @enum ['business', 'spending']
         * @optional
         */
        purpose: { type: String, enum: ['business', 'spending'] },

        /**
         * Type of business if purpose is business
         * @type {string}
         * @enum ['retail', 'industry']
         * @optional
         */
        typeOfBusiness: { type: String, enum: ['retail', 'industry'] },

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
        hearAboutUs: { type: String, enum: ['friends', 'ads', 'others'] },
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

/**
 * User model based on IUser interface
 *
 * @description Creates and exports the Mongoose model for User
 * @type {Model<IUser>}
 */
const User: Model<IUser> = model<IUser>(MODEL_NAME.USER, UserSchema);
export default User;