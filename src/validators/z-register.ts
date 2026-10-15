import z, {ZodError} from "zod";
import {Request, Response, NextFunction} from "express";
import errorResponseMessage from "../common/messages/error-response-message";
import zodErrorHandler from "./zod.error";

const ZRegister = z.object({
    firstName: z
        .string()
        .min(3, "First name must be at least 3 characters")
        .refine((val) => val !== undefined && val !== null, {
            message: "First name is required"
        }),
    lastName: z
        .string()
        .min(3, "Last name must be at least 3 characters")
        .refine((val) => val !== undefined && val !== null, {
            message: "Last name is required"
        }),

    email: z
        .string()
        .email("Invalid email format")
        .refine((email) => {
            const emailRegex = /^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/;
            return emailRegex.test(email);
        }, "Invalid email format"),
    password: z.string().min(8, "Password must be at least 8 characters."),
    // WhatsApp Number - Temporarily disabled for registration
    // TODO: Can be restored by uncommenting the line below if needed in the future
    // whatsappNumber: z.string().min(11, "Whatsapp Number must be at least 11 digits"),
})

export const SIGNUP_PURPOSES = ['business', 'personal', 'travel', 'investment', 'savings', 'others'] as const;
export const HEAR_ABOUT_US_OPTIONS = ['friends', 'ads', 'search-engines', 'social-media', 'referrals', 'events', 'youtube', 'instagram', 'x-twitter', 'facebook', 'tiktok', 'google', 'others'] as const;

/**
 * The second sign-up step. It only asks what's needed to open a Tier 1 account;
 * identity and business details (nationality, industry, volumes) are collected
 * by the KYC / KYB application when the user upgrades their tier. The older
 * fields are still accepted so earlier clients keep working.
 */
const ZPostRegister = z.object({
    phoneNumber: z.string().trim().min(11, "Phone Number must be at least 11 digits").max(20, "Phone Number is too long"),
    countryOfResidence: z.string().trim().min(2, "Country of residence is required").max(56),
    purpose: z.enum(SIGNUP_PURPOSES, {
        errorMap: () => ({message: "Please select a valid purpose"})
    }),
    hearAboutUs: z.enum(HEAR_ABOUT_US_OPTIONS, {
        errorMap: () => ({message: "Please select a valid option for how you heard about us"})
    }),
    hearAboutUsOther: z.string().trim().max(200, "Please keep this under 200 characters").optional(),
    countryOfOrigin: z.string().trim().min(2).max(56).optional(),
    typeOfBusiness: z.enum(['creators', 'retail-sales', 'software', 'services', 'entertainment', 'media', 'payments', 'others']).optional(),
    monthlyVolume: z.string().trim().max(60).optional(),
})
    .superRefine((data, ctx) => {
        if (data.hearAboutUs === "others" && !data.hearAboutUsOther) {
            ctx.addIssue({
                code: "custom",
                message: "Please tell us how you heard about us",
                path: ["hearAboutUsOther"]
            })
        }
    })

/** The validated sign-up fields only (unknown keys such as role or tier are dropped) */
export const parsePostRegistration = (body: unknown) => ZPostRegister.parse(body);

const ZUpdateUser = z.object({
    status: z.enum(['active', 'inactive', 'deactivated', 'suspended'], {
        errorMap: () => ({message: "Status can either be 'Active', 'Suspended' or 'Deactivated'"})
    }),
    role: z.enum(['ADMIN', 'USER'], {
        errorMap: () => ({message: "Role can either be 'User' or 'Administrator'"})
    })
})

const validateRegistration = (req: Request, res: Response, next: NextFunction) => {
    try {
        ZRegister.parse(req.body);
        next()
    } catch (error) {
        zodErrorHandler(error, next)
    }
}

export const validatePostRegistration = (req: Request, res: Response, next: NextFunction) => {
    try {
        ZPostRegister.parse(req.body);
        next()
    } catch (error) {
        zodErrorHandler(error, next)
    }
}

export const validateUpdateUser = (req: Request, res: Response, next: NextFunction) => {
    try {
        ZUpdateUser.parse(req.body);
        next()
    } catch (error) {
        zodErrorHandler(error, next)
    }
}

export default validateRegistration;