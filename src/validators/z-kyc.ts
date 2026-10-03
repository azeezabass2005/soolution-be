import z from "zod";
import {
    BUSINESS_TYPES,
    ID_TYPES,
    KYC_QUESTIONS,
    KYC_STEP,
    KycStep,
    KycType,
    LEGAL_ENTITY_TYPES,
    SOURCES_OF_FUNDS,
    TRANSACTION_PURPOSES,
} from "../common/kyc.constants";

const requiredText = (label: string, max: number = 200) =>
    z.string({ required_error: `${label} is required` }).trim().min(1, `${label} is required`).max(max, `${label} is too long`);

const optionalText = (max: number = 200) => z.string().trim().max(max).optional().or(z.literal(""));

const isoDate = (label: string) =>
    z.string({ required_error: `${label} is required` })
        .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be a valid date`)
        .refine((value) => !isNaN(new Date(value).getTime()), `${label} must be a valid date`)
        .refine((value) => new Date(value) <= new Date(), `${label} cannot be in the future`);

const adultDateOfBirth = isoDate("Date of birth").refine((value) => {
    const eighteenYearsAgo = new Date();
    eighteenYearsAgo.setFullYear(eighteenYearsAgo.getFullYear() - 18);
    return new Date(value) <= eighteenYearsAgo;
}, "Must be at least 18 years old");

const countryCode = z.string({ required_error: "Country is required" }).regex(/^[A-Z]{2}$/, "Country is required");

const email = z.string({ required_error: "Email address is required" }).trim().email("Invalid email address").max(200);

const phoneNumber = z.string({ required_error: "Phone number is required" }).trim().regex(/^\+?[0-9 ()-]{7,20}$/, "Invalid phone number");

const url = (label: string) => z.string({ required_error: `${label} is required` }).trim().url(`${label} must be a valid URL (include https://)`).max(500);

const entityId = z.string().regex(/^[a-zA-Z0-9-]{8,64}$/, "Invalid id");

const AddressSchema = z.object({
    street: requiredText("Building/Street"),
    city: requiredText("City", 100),
    state: requiredText("State/Province", 100),
    postcode: requiredText("Postcode", 20),
    country: countryCode,
});

const withOther = <T extends z.ZodRawShape>(shape: T, field: string, otherField: string, label: string) =>
    z.object(shape).superRefine((data: any, ctx) => {
        if (data[field] === "others" && !data[otherField]?.trim()) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: [otherField], message: `Please specify the ${label}` });
        }
    });

export const ZBusinessGeneral = withOther({
    applicantName: requiredText("Name of the applicant"),
    applicantEmail: email,
    businessName: requiredText("Business name"),
    tradeName: optionalText(),
    registrationNumber: requiredText("Registration number", 100),
    taxNumber: requiredText("Tax registration number", 100),
    businessType: z.enum(BUSINESS_TYPES, { errorMap: () => ({ message: "Business type is required" }) }),
    businessTypeOther: optionalText(),
    purpose: z.enum(TRANSACTION_PURPOSES, { errorMap: () => ({ message: "Purpose is required" }) }),
    purposeOther: optionalText(),
    legalEntityType: z.enum(LEGAL_ENTITY_TYPES, { errorMap: () => ({ message: "Legal entity type is required" }) }),
    website: z.string().trim().url("Website must be a valid URL (include https://)").max(500).optional().or(z.literal("")),
    address: AddressSchema,
    description: z.string({ required_error: "Description is required" }).trim()
        .min(100, "Description must be at least 100 characters")
        .max(3000, "Description is too long"),
}, "businessType", "businessTypeOther", "business type")
    .superRefine((data, ctx) => {
        if (data.purpose === "others" && !data.purposeOther?.trim()) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["purposeOther"], message: "Please specify the purpose" });
        }
    });

export const ZPersonal = withOther({
    firstName: requiredText("First name", 100),
    middleName: optionalText(100),
    lastName: requiredText("Last name", 100),
    dateOfBirth: adultDateOfBirth,
    nationality: countryCode,
    email,
    phoneNumber,
    occupation: requiredText("Occupation", 100),
    sourceOfFunds: z.enum(SOURCES_OF_FUNDS, { errorMap: () => ({ message: "Source of funds is required" }) }),
    sourceOfFundsOther: optionalText(),
    purpose: z.enum(TRANSACTION_PURPOSES, { errorMap: () => ({ message: "Purpose is required" }) }),
    idType: z.enum(ID_TYPES, { errorMap: () => ({ message: "ID type is required" }) }),
    idNumber: requiredText("ID number", 50),
    address: AddressSchema,
}, "sourceOfFunds", "sourceOfFundsOther", "source of funds");

const ownershipPercentage = z.coerce.number({ invalid_type_error: "Ownership percentage is required" })
    .gt(0, "Ownership percentage must be greater than 0")
    .max(100, "Ownership percentage cannot exceed 100");

export const ZUbo = z.discriminatedUnion("kind", [
    z.object({
        id: entityId,
        kind: z.literal("individual"),
        fullName: requiredText("Name"),
        dateOfBirth: adultDateOfBirth,
        country: countryCode,
        email,
        phoneNumber,
        ownershipPercentage,
        isPep: z.boolean({ required_error: "Please say whether this person is a PEP" }),
    }),
    z.object({
        id: entityId,
        kind: z.literal("company"),
        companyName: requiredText("Company name"),
        registrationNumber: requiredText("Registration number", 100),
        country: countryCode,
        email,
        ownershipPercentage,
    }),
]);

export const ZDirector = z.object({
    id: entityId,
    fullName: requiredText("Full name"),
    dateOfBirth: adultDateOfBirth,
    country: countryCode,
    street: requiredText("Building/Street"),
    city: requiredText("City", 100),
    state: requiredText("State/Province", 100),
    postcode: requiredText("Postcode", 20),
    email,
    socialProfileUrl: url("Social media profile URL"),
});

const uniqueIds = (items: { id: string }[]) => new Set(items.map((item) => item.id)).size === items.length;

const uboList = (min: number) => z.array(ZUbo)
    .min(min, "Add at least one beneficial owner")
    .max(20, "You can add at most 20 beneficial owners")
    .refine(uniqueIds, "Duplicate beneficial owner")
    .refine((ubos) => ubos.reduce((sum, ubo) => sum + ubo.ownershipPercentage, 0) <= 100, "Total ownership cannot exceed 100%");

const directorList = (min: number) => z.array(ZDirector)
    .min(min, "Add at least one director")
    .max(20, "You can add at most 20 directors")
    .refine(uniqueIds, "Duplicate director");

const questionnaire = (type: KycType) => z.object(
    Object.fromEntries(KYC_QUESTIONS[type].map((q) => [
        q.key,
        z.enum(["yes", "no"], { errorMap: () => ({ message: "Please answer this question" }) }),
    ]))
).extend({ additionalInfo: optionalText(2000) });

/**
 * Drafts (partially filled forms) are stored as-is so nothing typed is lost;
 * only a flat record of short primitive values is accepted.
 */
const draftValue = z.union([z.string().max(5000), z.number(), z.boolean(), z.null()]);
const ZDraftForm = z.record(z.union([draftValue, z.record(draftValue)]))
    .refine((value) => Object.keys(value).length <= 50, "Too many fields");

/**
 * Returns the schema for a step's data.
 * `complete` = the user pressed "Save & Continue" and the step must be fully valid.
 */
export const getStepSchema = (type: KycType, step: KycStep, complete: boolean): z.ZodTypeAny | null => {
    switch (step) {
        case KYC_STEP.GENERAL:
            return type === "business" ? (complete ? ZBusinessGeneral : ZDraftForm) : null;
        case KYC_STEP.PERSONAL:
            return type === "individual" ? (complete ? ZPersonal : ZDraftForm) : null;
        case KYC_STEP.UBOS:
            return type === "business" ? uboList(complete ? 1 : 0) : null;
        case KYC_STEP.DIRECTORS:
            return type === "business" ? directorList(complete ? 1 : 0) : null;
        case KYC_STEP.QUESTIONNAIRE:
            return complete ? questionnaire(type) : ZDraftForm;
        case KYC_STEP.DOCUMENTS:
            // Documents are uploaded individually; completion is checked against the uploads
            return z.any();
        default:
            return null;
    }
};

export const ZKycStart = z.object({
    type: z.enum(["individual", "business"], { errorMap: () => ({ message: "Choose individual or business" }) }),
});

export const ZKycReview = z.object({
    status: z.enum(["under_review", "approved", "rejected"], { errorMap: () => ({ message: "Invalid status" }) }),
    note: z.string().trim().max(2000).optional(),
}).superRefine((data, ctx) => {
    if (data.status === "rejected" && !data.note) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["note"], message: "Please give a reason for rejecting" });
    }
});
