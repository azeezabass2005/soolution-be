import mongoose, {Document, Schema} from 'mongoose';
import {
    USER_STATUS,
    PUBLICATION_STATUS, TRANSACTION_STATUS, TRANSACTION_TYPE, DETAIL_TYPE, ALIPAY_PLATFORM
} from "../common/constant";

export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];

export type PublicationStatus = (typeof PUBLICATION_STATUS)[keyof typeof PUBLICATION_STATUS];

export type TransactionStatus = (typeof TRANSACTION_STATUS)[keyof typeof TRANSACTION_STATUS];

export type TransactionType = (typeof TRANSACTION_TYPE)[keyof typeof TRANSACTION_TYPE];

export type DetailType = (typeof DETAIL_TYPE)[keyof typeof DETAIL_TYPE];

export type AlipayPlatform = (typeof ALIPAY_PLATFORM)[keyof typeof ALIPAY_PLATFORM];

export interface IUser extends Document {
    username: string;
    firstName: string;
    lastName: string;
    password: string;
    email: string;
    isVerified: boolean;
    isCompleted: boolean;
    role: number;
    status: UserStatus;
    lastLogin: string;
    phoneNumber: string;
    whatsappNumber: string;
    countryOfOrigin?: string;
    countryOfResidence?: string;
    purpose?: 'business' | 'spending';
    typeOfBusiness?: 'retail' | 'industry';
    monthlyVolume?: string;
    hearAboutUs?: 'friends' | 'ads' | 'others';

    // KYC related fields
    isKYCDone?: boolean;
}

export interface IRefreshToken extends Document {
    userId: Schema.Types.ObjectId;
    token: string;
    expiresAt: Date;
    isRevoked: boolean;
    userAgent?: string;
    ipAddress?: string;
}

export type CurrencyCode = 'RMB' | 'GHS' | 'NGN' | 'KES' | 'ZAR' | 'TZS' | 'UGX' | 'XOF' | 'XAF' | 'RWF' | 'USDT';

export interface IExchangeRate extends Document {
    from: CurrencyCode;
    to: CurrencyCode;
    rate: number;
    isActive?: boolean;
}

export type PartnerRole =
    | "LOGISTICS"
    | "SUPPLIER"
    | "CREATOR"
    | "SKILL"
    | "TALENT"
    | "TUTOR";

export type ExperienceLevel = "BEGINNER" | "INTERMEDIATE" | "EXPERT";

export type PartnerStatus = "active" | "inactive" | "pending" | "suspended";

export interface IPartner {
    name: string;
    email: string;
    phone?: string;
    whatsappNumber?: string;
    country: string;
    city?: string;
    role: PartnerRole;
    status: PartnerStatus;
    description?: string;
    profileImage?: string | Express.Multer.File;
    website?: string;
    isVerified: boolean;
    rating?: number; // Average rating from 1-5
    totalReviews?: number;

    // Role-specific data stored as flexible object
    roleData: {
        // For TUTOR
        subjects?: string[];
        hourlyRate?: number;

        // For LOGISTICS
        fleetSize?: number;
        coverageAreas?: string[];

        // For CREATOR
        specialties?: string[];
        portfolio?: string[];
        socialLinks?: Record<string, string>;
        availableForHire?: boolean;

        // For SUPPLIER
        products?: string[];
        categories?: string[];
        minimumOrderQty?: number;
        deliveryRegions?: string[];
        certifications?: string[];

        // For SKILL
        skills?: string[];
        experienceLevel?: ExperienceLevel;
        yearsOfExperience?: number;

        // For TALENT
        talents?: string[];
        awards?: string[];
        agentContact?: string;
        availableForGigs?: boolean;
    };

    // Common fields for availability
    isAvailable: boolean;
    lastActiveAt?: Date;
    joinedAt?: Date;
}


export interface IPost extends Document {
    title: string;
    content: string;
    tags: string[];
    category: string;
    user: mongoose.Schema.Types.ObjectId;
    viewCount: number;
    likeCount: number;
    publicationStatus: PublicationStatus;
}

export interface ITag extends Document {
    title: string;
}

export interface ITransaction extends Document {
    user: Schema.Types.ObjectId | string | IUser;
    reference: string;
    amount: number;
    currency: string;
    detailType: DetailType;
    status: TransactionStatus;
    initiatedAt: Date;
    completedAt?: Date;
    failedAt?: Date;
    details?: ITransactionDetail;

    // New Fields
    fromCurrency: string;
}

export interface ITransactionDetail extends Document {
    transactionId: Schema.Types.ObjectId | string;
    type: DetailType;
    // Alipay specific fields
    platform?: AlipayPlatform;
    alipayId?: string;
    alipayName?: string;
    qrCodeUrl?: string;
    // This is the receipt the admin uploads after the RMB is sent to the alipay the user filled
    payInReceiptUrl?: string;
    // This is the receipt the user use to pay the NGN or GHS
    // It already contains all the sender details like name, bank and the likes.
    payOutReceiptUrl?: string;
    // This is for the alipay, the bank account the user is to pay the money into
    bankAccountDetails: IBankAccountDetails;
    fromAmount: number;

    // TODO: Other types of transaction details will be here
}

export interface IBankAccountDetails {
    currency: string;
    accountNumber: number;
    accountName: string;
    bankName: string;
    isDefault: boolean;
}

// export interface ITransaction {
//     user: Schema.Types.ObjectId | string | IUser;
//     reference: string;
//     providerTransactionId?: string;
//     amount: number;
//     currency: string;
//     paymentMethod: string;
//     status: TransactionStatus;
//     transactionType: TransactionType;
//
//     virtualAccount?: {
//         accountNumber?: string;
//         bankName?: string;
//         expiryDate?: Date;
//     };
//
//     logs: {
//         amount: number;
//         status: string;
//         receivedAt: Date;
//         rawPayload: any;
//     }[];
//
//     metadata?: any;
//     initiatedAt: Date;
//     completedAt?: Date;
//     failedAt?: Date;
// }

export interface IWallet {
    // TODO: Find out all the information that needs to be stored on wallet
    currency: 'GHS' | 'NGN', // This will only be GHS for now, other currencies will be introduced later
    balance: number;
    user: Schema.Types.ObjectId;

}

export interface IVerification extends Document {
    user: Schema.Types.ObjectId | string | IUser;
    jobId?: string;
    status?: 'pending' | 'failed' | 'passed';
    reason?: string;
}