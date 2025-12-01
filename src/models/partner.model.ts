import mongoose, { model, Model, Schema } from "mongoose";
import {IPartner, PartnerRole} from "./interface";
import { MODEL_NAME } from "../common/constant";
import paginate from "mongoose-paginate-v2";

// Constants for validation
export const PARTNER_ROLES = ["LOGISTICS", "SUPPLIER", "CREATOR", "SKILL", "TALENT", "TUTOR"] as const;
export const PARTNER_STATUSES = ["active", "inactive", "pending", "suspended"] as const;
export const EXPERIENCE_LEVELS = ["BEGINNER", "INTERMEDIATE", "EXPERT"] as const;

/**
 * Mongoose schema for Partner model
 *
 * @description Creates a schema for partners with role-specific data
 */
export const PartnerSchema = new Schema<IPartner>(
    {
        /**
         * Partner's full name
         * @type {string}
         * @required
         * @trim
         */
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 100
        },

        /**
         * Partner's email address
         * @type {string}
         * @required
         * @unique
         */
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
            match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
        },

        /**
         * Partner's phone number
         * @type {string}
         * @optional
         */
        phone: {
            type: String,
            trim: true,
            maxlength: 20
        },

        /**
         * Partner's whatsapp number
         * @type {string}
         * @optional
         */
        whatsappNumber: {
            type: String,
            trim: true,
            maxlength: 20
        },

        /**
         * Country where partner is located
         * @type {string}
         * @required
         */
        country: {
            type: String,
            required: true,
            trim: true,
            maxlength: 50
        },

        /**
         * City where partner is located
         * @type {string}
         * @optional
         */
        city: {
            type: String,
            trim: true,
            maxlength: 50
        },

        /**
         * Partner's role/type
         * @type {string}
         * @enum PartnerRole
         * @required
         */
        role: {
            type: String,
            enum: PARTNER_ROLES,
            required: true
        },

        /**
         * Partner's current status
         * @type {string}
         * @enum PartnerStatus
         * @required
         * @default "PENDING"
         */
        status: {
            type: String,
            enum: PARTNER_STATUSES,
            required: true,
            default: "pending"
        },

        /**
         * Partner's description/bio
         * @type {string}
         * @optional
         */
        description: {
            type: String,
            trim: true,
            maxlength: 1000
        },

        /**
         * URL to partner's profile image
         * @type {string}
         * @optional
         */
        profileImage: {
            type: String,
            trim: true
        },

        /**
         * Partner's website URL
         * @type {string}
         * @optional
         */
        website: {
            type: String,
            trim: true,
            match: [/^https?:\/\/.+/, 'Please enter a valid URL']
        },

        /**
         * Whether partner is verified
         * @type {boolean}
         * @required
         * @default false
         */
        isVerified: {
            type: Boolean,
            required: true,
            default: false
        },

        /**
         * Average rating from reviews (1-5)
         * @type {number}
         * @optional
         * @min 1
         * @max 5
         */
        rating: {
            type: Number,
            min: 1,
            max: 5
        },

        /**
         * Total number of reviews received
         * @type {number}
         * @optional
         * @min 0
         * @default 0
         */
        totalReviews: {
            type: Number,
            min: 0,
            default: 0
        },

        /**
         * Role-specific data stored as flexible object
         * @type {object}
         * @required
         */
        roleData: {
            type: Schema.Types.Mixed,
            required: true,
            default: {}
        },

        /**
         * Whether partner is currently available
         * @type {boolean}
         * @required
         * @default true
         */
        isAvailable: {
            type: Boolean,
            required: true,
            default: true
        },

        /**
         * Last time partner was active
         * @type {Date}
         * @optional
         */
        lastActiveAt: {
            type: Date
        },

        /**
         * When partner joined the platform
         * @type {Date}
         * @optional
         * @default Date.now
         */
        joinedAt: {
            type: Date,
            default: Date.now
        }
    },
    {
        /** Enable virtual properties when converting to plain object */
        toObject: { virtuals: true },

        /** Enable virtual properties when converting to JSON */
        toJSON: { virtuals: true },

        /** Automatically manage createdAt and updatedAt timestamps */
        timestamps: true,

        /** Optimize for queries */
        collection: 'partners'
    }
);

PartnerSchema.plugin(paginate);

// ============= INDEXES =============

// Compound index for efficient role-based queries
PartnerSchema.index({ role: 1, status: 1, isAvailable: 1 });

// Text index for search functionality
PartnerSchema.index({
    name: 'text',
    description: 'text',
    'roleData.skills': 'text',
    'roleData.specialties': 'text',
    'roleData.subjects': 'text',
    'roleData.talents': 'text'
});

// Location-based index
PartnerSchema.index({ country: 1, city: 1 });

// Email index for uniqueness and login queries
PartnerSchema.index({ email: 1 });

// Rating index for sorting
PartnerSchema.index({ rating: -1 });

// ============= VIRTUALS =============

/**
 * Virtual property to get full location string
 */
PartnerSchema.virtual('fullLocation').get(function() {
    return this.city ? `${this.city}, ${this.country}` : this.country;
});

/**
 * Virtual property to check if partner has good rating
 */
PartnerSchema.virtual('hasGoodRating').get(function() {
    return this.rating && this.rating >= 4.0;
});

// ============= METHODS =============

/**
 * Method to update partner's last active timestamp
 */
PartnerSchema.methods.updateLastActive = function() {
    this.lastActiveAt = new Date();
    return this.save();
};

/**
 * Method to verify partner
 */
PartnerSchema.methods.verify = function() {
    this.isVerified = true;
    this.status = 'ACTIVE';
    return this.save();
};

// ============= MIDDLEWARE =============

/**
 * Pre-save middleware for basic data processing
 */
PartnerSchema.pre('save', function(next) {
    // Update last active timestamp on save
    if (this.isModified() && this.status === 'active') {
        this.lastActiveAt = new Date();
    }
    next();
});

/**
 * Partner Model based on IPartner interface
 *
 * @description Creates and exports the Mongoose model for Partner
 * @type {Model<IPartner>}
 */
const Partner: Model<IPartner> = model<IPartner>(MODEL_NAME.PARTNER, PartnerSchema);
export default Partner;

// ============= HELPER FUNCTIONS =============

/**
 * Type guard to check if partner has specific role data
 */
export function hasRoleData<T extends PartnerRole>(
    partner: IPartner,
    role: T
): partner is IPartner & { role: T } {
    return partner.role === role;
}


/**
 * Get partners by role with proper typing
 */
export async function getPartnersByRole<T extends PartnerRole>(
    role: T,
    filters: Partial<IPartner> = {}
) {
    return Partner.find({ role, ...filters });
}