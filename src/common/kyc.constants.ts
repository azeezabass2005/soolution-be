/**
 * KYC (individual) / KYB (business) application definitions.
 * This is the single source of truth for steps, questions and required documents;
 * it is also sent to the frontend so both sides always agree.
 */

export const KYC_TYPE = {
    INDIVIDUAL: "individual",
    BUSINESS: "business",
} as const;

export const KYC_STATUS = {
    DRAFT: "draft",
    SUBMITTED: "submitted",
    UNDER_REVIEW: "under_review",
    APPROVED: "approved",
    REJECTED: "rejected",
} as const;

export type KycType = (typeof KYC_TYPE)[keyof typeof KYC_TYPE];
export type KycStatus = (typeof KYC_STATUS)[keyof typeof KYC_STATUS];

/** Statuses in which the applicant may still edit their application */
export const KYC_EDITABLE_STATUSES: KycStatus[] = [KYC_STATUS.DRAFT, KYC_STATUS.REJECTED];

/** Statuses an admin may move an application into, and the statuses each may come from */
export const KYC_ADMIN_TRANSITIONS: Record<string, KycStatus[]> = {
    [KYC_STATUS.UNDER_REVIEW]: [KYC_STATUS.SUBMITTED],
    [KYC_STATUS.APPROVED]: [KYC_STATUS.SUBMITTED, KYC_STATUS.UNDER_REVIEW],
    [KYC_STATUS.REJECTED]: [KYC_STATUS.SUBMITTED, KYC_STATUS.UNDER_REVIEW],
};

export const KYC_STEP = {
    GENERAL: "general",
    PERSONAL: "personal",
    UBOS: "ubos",
    DIRECTORS: "directors",
    QUESTIONNAIRE: "questionnaire",
    DOCUMENTS: "documents",
} as const;

export type KycStep = (typeof KYC_STEP)[keyof typeof KYC_STEP];

/** Ordered data steps per application type (the final review step is not stored) */
export const KYC_STEPS: Record<KycType, KycStep[]> = {
    business: [KYC_STEP.GENERAL, KYC_STEP.UBOS, KYC_STEP.DIRECTORS, KYC_STEP.QUESTIONNAIRE, KYC_STEP.DOCUMENTS],
    individual: [KYC_STEP.PERSONAL, KYC_STEP.QUESTIONNAIRE, KYC_STEP.DOCUMENTS],
};

export const BUSINESS_TYPES = [
    "custodial",
    "non_custodial",
    "other_crypto",
    "it_services",
    "financial_services",
    "money_services_business",
    "others",
] as const;

export const TRANSACTION_PURPOSES = [
    "business_operations",
    "investment",
    "trading",
    "services",
    "personal",
    "others",
] as const;

export const LEGAL_ENTITY_TYPES = [
    "llc",
    "sole_proprietorship",
    "partnership",
    "corporation",
    "non_profit",
    "others",
] as const;

export const SOURCES_OF_FUNDS = [
    "employment",
    "business_income",
    "investments",
    "savings",
    "inheritance",
    "others",
] as const;

export const ID_TYPES = ["passport", "national_id", "drivers_license", "voters_card"] as const;

export interface KycQuestion {
    key: string;
    title: string;
    question: string;
    description?: string;
}

const SANCTIONED_COUNTRIES_TEXT = "Including: Abkhazia, Afghanistan, Angola, Balkans, Belarus, Bosnia & Herzegovina, Burundi, Central African Republic, Congo, Cuba, Democratic People's Republic of North Korea, Democratic Republic of the Congo, Ukraine (including regions Donetsk, Crimea and Luhansk), Eritrea, Ethiopia, Guatemala, Guinea, Guinea-Bissau, Haiti, Iran, Iraq, Kosovo, Lebanon, Liberia, Libya, Macedonia (North), Mali, Moldova, Montenegro, Myanmar (Burma), Nagorno-Karabakh, Nicaragua, Niger, Northern Cyprus, Russia, Sahrawi Arab Democratic Republic, Serbia, Slovenia, Somalia, Somaliland, South Ossetia, South Sudan, Sudan, Syria, Tunisia, Türkiye, Vanuatu, Venezuela, Yemen, Zimbabwe";

export const KYC_QUESTIONS: Record<KycType, KycQuestion[]> = {
    business: [
        {
            key: "sanctionedCountries",
            title: "Sanctioned Countries Business Activities",
            question: "Do you have business activities in sanctioned countries?",
            description: SANCTIONED_COUNTRIES_TEXT,
        },
        {
            key: "cisCountries",
            title: "CIS Countries Business Activities",
            question: "Do you have business activities in CIS countries?",
            description: "CIS countries include: Russia, Azerbaijan, Uzbekistan, Turkmenistan, Armenia, Moldova, Ukraine, Tajikistan, Kazakhstan, Kyrgyzstan & Belarus",
        },
        {
            key: "regulatoryFines",
            title: "Regulatory Fines or Sanctions",
            question: "Have you or your organization been issued regulatory fines or sanctions?",
            description: "This includes officers, directors, key employees, or majority shareholders who have been issued regulatory fines or sanctions, or are currently part of any regulatory investigations",
        },
        {
            key: "criminalComplaints",
            title: "Criminal Complaints or Civil Litigation",
            question: "Have you or your organization been involved in criminal complaints or civil litigation?",
            description: "This includes officers, directors, key employees or majority shareholders who have been convicted or are currently part of any civil litigation or criminal complaints",
        },
        {
            key: "bankruptcy",
            title: "Bankruptcy Declaration",
            question: "Have you or your organization declared bankruptcy?",
            description: "This includes officers, directors, key employees, affiliates or majority shareholders who have ever declared bankruptcy",
        },
    ],
    individual: [
        {
            key: "politicallyExposed",
            title: "Politically Exposed Person (PEP)",
            question: "Are you, or is a close family member or associate, a politically exposed person?",
            description: "A PEP is someone who holds or has held a prominent public function, e.g. head of state, senior politician, senior government, judicial or military official, or senior executive of a state-owned company",
        },
        {
            key: "sanctionedCountries",
            title: "Sanctioned Countries Activities",
            question: "Do you send or receive funds to or from sanctioned countries?",
            description: SANCTIONED_COUNTRIES_TEXT,
        },
        {
            key: "criminalComplaints",
            title: "Criminal Complaints or Civil Litigation",
            question: "Have you been convicted of, or are you currently involved in, any criminal complaint or civil litigation?",
        },
        {
            key: "bankruptcy",
            title: "Bankruptcy Declaration",
            question: "Have you ever declared bankruptcy?",
        },
    ],
};

export interface KycDocumentDefinition {
    slot: string;
    label: string;
    description?: string;
    required: boolean;
    requiresIssueDate: boolean;
}

export const KYC_DOCUMENTS: Record<KycType, KycDocumentDefinition[]> = {
    business: [
        {
            slot: "certificate_of_incorporation",
            label: "Certificate of incorporation",
            required: true,
            requiresIssueDate: true,
        },
        {
            slot: "memorandum_articles",
            label: "Memorandum/Articles of Association",
            required: true,
            requiresIssueDate: true,
        },
        {
            slot: "directors_list",
            label: "Self certified director's list",
            description: "Self certified Director's list issued/dated within the last 6 months, mentioning company name and Registration number, duly signed by the Director or the UBO. Director details should include Full name and Citizenship.",
            required: true,
            requiresIssueDate: true,
        },
        {
            slot: "shareholders_registry",
            label: "Self certified shareholders registry",
            description: "Issued/dated within the last 6 months, mentioning company name and Registration number, duly signed by the Director or the UBO",
            required: true,
            requiresIssueDate: true,
        },
        {
            slot: "proof_of_address",
            label: "Proof of address for office address (Legal entity)",
            description: "Utility bill / rent agreement / bank statement issued within 3 months",
            required: true,
            requiresIssueDate: true,
        },
    ],
    individual: [
        {
            slot: "id_front",
            label: "Government-issued ID (front)",
            description: "A clear photo or scan of the front of the ID selected in your personal information",
            required: true,
            requiresIssueDate: false,
        },
        {
            slot: "id_back",
            label: "Government-issued ID (back)",
            description: "Not required for passports",
            required: true,
            requiresIssueDate: false,
        },
        {
            slot: "proof_of_address",
            label: "Proof of address",
            description: "Utility bill / bank statement / tenancy agreement issued within 3 months, showing your name and address",
            required: true,
            requiresIssueDate: true,
        },
        {
            slot: "selfie_with_id",
            label: "Selfie holding your ID",
            description: "A clear photo of your face holding the same ID next to it",
            required: true,
            requiresIssueDate: false,
        },
    ],
};

/** Document slot for a PEP UBO's source-of-funds evidence */
export const UBO_SOURCE_OF_FUNDS_PREFIX = "ubo_source_of_funds_";


export const KYC_DOCUMENT_UPLOAD = {
    maxFileSize: 10 * 1024 * 1024, // 10MB
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
    allowedExtensions: [".jpg", ".jpeg", ".png", ".webp", ".pdf"],
    uploadPath: "kyc/",
};
