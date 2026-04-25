import mongoose, {Document, Schema} from 'mongoose';
import {
    USER_STATUS,
    PUBLICATION_STATUS, TRANSACTION_STATUS, TRANSACTION_TYPE, DETAIL_TYPE, ALIPAY_PLATFORM,
    WALLET_STATUS, WALLET_TRANSACTION_TYPE, WALLET_TRANSACTION_STATUS
} from "../common/constant";

export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];

export type PublicationStatus = (typeof PUBLICATION_STATUS)[keyof typeof PUBLICATION_STATUS];

export type TransactionStatus = (typeof TRANSACTION_STATUS)[keyof typeof TRANSACTION_STATUS];

export type TransactionType = (typeof TRANSACTION_TYPE)[keyof typeof TRANSACTION_TYPE];

export type DetailType = (typeof DETAIL_TYPE)[keyof typeof DETAIL_TYPE];

export type AlipayPlatform = (typeof ALIPAY_PLATFORM)[keyof typeof ALIPAY_PLATFORM];

export type WalletStatus = (typeof WALLET_STATUS)[keyof typeof WALLET_STATUS];

export type WalletTransactionType = (typeof WALLET_TRANSACTION_TYPE)[keyof typeof WALLET_TRANSACTION_TYPE];

export type WalletTransactionStatus = (typeof WALLET_TRANSACTION_STATUS)[keyof typeof WALLET_TRANSACTION_STATUS];

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
    typeOfBusiness?: 'creators' | 'retail-sales' | 'software' | 'services' | 'entertainment' | 'media' | 'payments' | 'others';
    monthlyVolume?: string;
    hearAboutUs?: 'friends' | 'ads' | 'referrals' | 'events' | 'youtube' | 'instagram' | 'x-twitter' | 'facebook' | 'tiktok' | 'google' | 'others';
    hearAboutUsOther?: string;

    // KYC related fields
    isKYCDone?: boolean;
    isKYCRejected?: boolean;
    kycRejectionReason?: string;
}

export interface IRefreshToken extends Document {
    userId: Schema.Types.ObjectId;
    token: string;
    expiresAt: Date;
    isRevoked: boolean;
    userAgent?: string;
    ipAddress?: string;
}

export type CurrencyCode = 'RMB' | 'GHS' | 'NGN' | 'KES' | 'ZAR' | 'TZS' | 'UGX' | 'XOF' | 'XAF' | 'RWF' | 'BWP' | 'ETB' | 'ZMW' | 'CDF' | 'SLL' | 'MWK' | 'USDT';

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
    alipayNo?: string;
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

    // Bank Transfer specific fields
    institutionType?: 'bank' | 'momo' | 'mpesa';
    bankName?: string;
    accountNumber?: string;
    accountName?: string;

    // Mobile Money specific fields
    momoNetwork?: string;
    momoNumber?: string;
    momoName?: string;

    // Destination country (used by YellowCard disbursement)
    country?: string;

    // YellowCard specific fields
    ycCollectionId?: string;
    ycPaymentId?: string;
    ycSequenceId?: string;
    ycChannelId?: string;
    ycNetworkId?: string;
    ycStatus?: string;
    ycRawPayload?: any;
}

export interface IYellowCardChannel {
    id: string;
    name: string;
    country: string;
    currency: string;
    type: 'collection' | 'payment';
    status: string;
}

export interface IYellowCardRate {
    code: string;
    buy: number;
    sell: number;
    locale: string;
    country: string;
    currency: string;
}

export interface IBankAccountDetails extends Document {
    user?: mongoose.Schema.Types.ObjectId | string;
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

export interface IWallet extends Document {
    user: Schema.Types.ObjectId | string;
    currency: 'NGN';
    balance: number;
    ledgerBalance: number;
    status: WalletStatus;

    // Paystack customer & DVA fields
    paystackCustomerCode?: string;
    paystackCustomerId?: number;
    dvaBankName?: string;
    dvaAccountNumber?: string;
    dvaAccountName?: string;
    dvaBankId?: number;
    dvaId?: number;
    isDVAProvisioned: boolean;

    // PIN security
    pinHash?: string;
    isPinSet: boolean;
    pinAttempts: number;
    pinLockedUntil?: Date;
}

export interface IWalletTransaction extends Document {
    wallet: Schema.Types.ObjectId | string;
    user: Schema.Types.ObjectId | string;
    type: WalletTransactionType;
    status: WalletTransactionStatus;
    amount: number;
    reference: string;
    balanceBefore: number;
    balanceAfter: number;
    description?: string;

    // Paystack references
    paystackReference?: string;
    paystackTransferCode?: string;

    // Recipient bank details (for withdrawals)
    recipientBankCode?: string;
    recipientBankName?: string;
    recipientAccountNumber?: string;
    recipientAccountName?: string;
    paystackRecipientCode?: string;

    // Failure/reversal info
    failureReason?: string;
    reversedTransactionId?: Schema.Types.ObjectId | string;
}

export interface IVerification extends Document {
    user: Schema.Types.ObjectId | string | IUser;
    jobId?: string;
    status?: 'pending' | 'failed' | 'passed';
    reason?: string;
}