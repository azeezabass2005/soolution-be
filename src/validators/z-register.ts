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
            const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/;
            return emailRegex.test(email);
        }, "Invalid email format"),
    password: z.string().min(8, "Password must be at least 8 characters."),
    phoneNumber: z.string().min(11, "Phone Number must be at least 11 digits"),
    whatsappNumber: z.string().min(11, "Whatsapp Number must be at least 11 digits"),
})

const ZPostRegister = z.object({
    countryOfOrigin: z.string().min(2, "Country of origin is required"),
    countryOfResidence: z.string().min(2, "Country of residence is required"),
    purpose: z.enum(['business', 'personal', 'travel', 'investment', 'savings', 'others' ], {
        errorMap: () => ({message: "Please select a valid purpose'"})
    }),
    typeOfBusiness: z.enum(['retail', 'industry']).optional(),
    monthlyVolume: z.string().optional(),
    hearAboutUs: z.enum(['friends', 'ads', 'search-engines', 'social-media', 'referrals', 'events', 'others'], {
        errorMap: () => ({message: "How you hear about us can either be 'Friends', 'Ads' or 'Others'"})
    })
})
    .superRefine((data, ctx) => {
        if (data.purpose === "business" && !data.typeOfBusiness) {
            ctx.addIssue({
                code: "custom",
                message: "Type of business is required when purpose is 'Business'",
                path: ["typeOfBusiness"]
            })
        }
        if (data.purpose === "business" && !data.monthlyVolume) {
            ctx.addIssue({
                code: "custom",
                message: "Monthly Revenue Range is required when purpose is 'Business'",
                path: ["monthlyVolume"]
            })
        }
    })

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