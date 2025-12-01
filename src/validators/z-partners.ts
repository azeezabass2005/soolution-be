import z from "zod";
import { Request, Response, NextFunction } from "express";
import zodErrorHandler from "./zod.error";
import { PARTNER_ROLES, PARTNER_STATUSES, EXPERIENCE_LEVELS } from "../models/partner.model";

const ZBasePartner = z.object({
    name: z
        .string()
        .min(2, "Name must be at least 2 characters")
        .max(100, "Name cannot exceed 100 characters")
        .refine((val) => val !== undefined && val !== null, {
            message: "Name is required"
        }),

    email: z
        .string()
        .email("Invalid email format")
        .refine((email) => {
            const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/;
            return emailRegex.test(email);
        }, "Invalid email format"),

    phone: z
        .string()
        .min(10, "Phone number must be at least 10 digits")
        .max(20, "Phone number cannot exceed 20 characters")
        .optional(),

    whatsappNumber: z
        .string()
        .min(10, "Whatsapp number must be at least 10 digits")
        .max(20, "Whatsapp number cannot exceed 20 characters")
        .optional(),

    country: z
        .string()
        .min(2, "Country is required")
        .max(50, "Country name too long"),

    city: z
        .string()
        .max(50, "City name too long")
        .optional(),

    role: z.enum(PARTNER_ROLES, {
        errorMap: () => ({ message: "Invalid partner role" })
    }),

    status: z.enum(PARTNER_STATUSES, {
        errorMap: () => ({ message: "Invalid partner status" })
    }).optional(),

    description: z
        .string()
        .max(1000, "Description cannot exceed 1000 characters")
        .optional(),

    // profileImage: z
    //     .instanceof(File)
    //     .optional(),

    website: z
        .string()
        .url("Invalid website URL")
        .refine((url) => {
            return /^https?:\/\/.+/.test(url);
        }, "Website must be a valid HTTP/HTTPS URL")
        .optional(),

    isVerified: z.coerce.boolean().optional(),

    rating: z
        .coerce.number()
        .min(1, "Rating must be at least 1")
        .max(5, "Rating cannot exceed 5")
        .optional(),

    totalReviews: z
        .coerce.number()
        .min(0, "Total reviews cannot be negative")
        .optional(),

    isAvailable: z.coerce.boolean().optional()
});

// Role-specific validation schemas
const ZTutorRoleData = z.object({
    subjects: z
        .array(z.string().min(1, "Subject cannot be empty"))
        .min(1, "At least one subject is required for tutors"),

    hourlyRate: z
        .coerce.number()
        .positive("Hourly rate must be a positive number")
        .max(10000, "Hourly rate seems too high")
});

const ZLogisticsRoleData = z.object({
    fleetSize: z
        .coerce.number()
        .int("Fleet size must be a whole number")
        .positive("Fleet size must be a positive number"),

    coverageAreas: z
        .array(z.string().min(1, "Coverage area cannot be empty"))
        .min(1, "At least one coverage area is required for logistics partners")
});

const ZCreatorRoleData = z.object({
    specialties: z
        .array(z.string().min(1, "Specialty cannot be empty"))
        .min(1, "At least one specialty is required for creators"),

    portfolio: z
        .array(z.string().url("Portfolio link must be a valid URL"))
        .optional(),

    socialLinks: z
        .record(z.string().url("Social link must be a valid URL"))
        .optional(),

    availableForHire: z.coerce.boolean().optional()
});

const ZSupplierRoleData = z.object({
    products: z
        .array(z.string().min(1, "Product cannot be empty"))
        .min(1, "At least one product is required for suppliers"),

    categories: z
        .array(z.string().min(1, "Category cannot be empty"))
        .optional(),

    minimumOrderQty: z
        .coerce.number()
        .int("Minimum order quantity must be a whole number")
        .positive("Minimum order quantity must be positive")
        .optional(),

    deliveryRegions: z
        .array(z.string().min(1, "Delivery region cannot be empty"))
        .optional(),

    certifications: z
        .array(z.string().min(1, "Certification cannot be empty"))
        .optional()
});

const ZSkillRoleData = z.object({
    skills: z
        .array(z.string().min(1, "Skill cannot be empty"))
        .min(1, "At least one skill is required for skill providers"),

    experienceLevel: z.enum(EXPERIENCE_LEVELS, {
        errorMap: () => ({ message: "Invalid experience level" })
    }).optional(),

    yearsOfExperience: z
        .coerce.number()
        .int("Years of experience must be a whole number")
        .min(0, "Years of experience cannot be negative")
        .max(50, "Years of experience seems too high")
        .optional(),

    certifications: z
        .array(z.string().min(1, "Certification cannot be empty"))
        .optional(),

    availableForHire: z.coerce.boolean().optional()
});

const ZTalentRoleData = z.object({
    talents: z
        .array(z.string().min(1, "Talent cannot be empty"))
        .min(1, "At least one talent is required for talent partners"),

    portfolio: z
        .array(z.string().url("Portfolio link must be a valid URL"))
        .optional(),

    awards: z
        .array(z.string().min(1, "Award cannot be empty"))
        .optional(),

    agentContact: z
        .string()
        .min(1, "Agent contact cannot be empty")
        .optional(),

    availableForGigs: z.coerce.boolean().optional()
});

const ZCreatePartner = ZBasePartner.extend({
    roleData: z.object({}).passthrough()
}).superRefine((data, ctx) => {
    switch (data.role) {
        case 'TUTOR':
            const tutorResult = ZTutorRoleData.safeParse(data.roleData);
            if (!tutorResult.success) {
                tutorResult.error.errors.forEach(error => {
                    ctx.addIssue({
                        code: "custom",
                        message: error.message,
                        path: ['roleData', ...error.path]
                    });
                });
            }
            break;

        case 'LOGISTICS':
            const logisticsResult = ZLogisticsRoleData.safeParse(data.roleData);
            if (!logisticsResult.success) {
                logisticsResult.error.errors.forEach(error => {
                    ctx.addIssue({
                        code: "custom",
                        message: error.message,
                        path: ['roleData', ...error.path]
                    });
                });
            }
            break;

        case 'CREATOR':
            const creatorResult = ZCreatorRoleData.safeParse(data.roleData);
            if (!creatorResult.success) {
                creatorResult.error.errors.forEach(error => {
                    ctx.addIssue({
                        code: "custom",
                        message: error.message,
                        path: ['roleData', ...error.path]
                    });
                });
            }
            break;

        case 'SUPPLIER':
            const supplierResult = ZSupplierRoleData.safeParse(data.roleData);
            if (!supplierResult.success) {
                supplierResult.error.errors.forEach(error => {
                    ctx.addIssue({
                        code: "custom",
                        message: error.message,
                        path: ['roleData', ...error.path]
                    });
                });
            }
            break;

        case 'SKILL':
            const skillResult = ZSkillRoleData.safeParse(data.roleData);
            if (!skillResult.success) {
                skillResult.error.errors.forEach(error => {
                    ctx.addIssue({
                        code: "custom",
                        message: error.message,
                        path: ['roleData', ...error.path]
                    });
                });
            }
            break;

        case 'TALENT':
            const talentResult = ZTalentRoleData.safeParse(data.roleData);
            if (!talentResult.success) {
                talentResult.error.errors.forEach(error => {
                    ctx.addIssue({
                        code: "custom",
                        message: error.message,
                        path: ['roleData', ...error.path]
                    });
                });
            }
            break;
    }
});

// Update partner schema (more flexible)
const ZUpdatePartner = ZBasePartner.partial().extend({
    roleData: z.object({}).passthrough().optional()
}).superRefine((data, ctx) => {
    // Only validate role data if both role and roleData are provided
    if (data.role && data.roleData) {
        // Same validation logic as create, but for updates
        switch (data.role) {
            case 'TUTOR':
                const tutorResult = ZTutorRoleData.partial().safeParse(data.roleData);
                if (!tutorResult.success) {
                    tutorResult.error.errors.forEach(error => {
                        ctx.addIssue({
                            code: "custom",
                            message: error.message,
                            path: ['roleData', ...error.path]
                        });
                    });
                }
                break;

            case 'LOGISTICS':
                const logisticsResult = ZLogisticsRoleData.partial().safeParse(data.roleData);
                if (!logisticsResult.success) {
                    logisticsResult.error.errors.forEach(error => {
                        ctx.addIssue({
                            code: "custom",
                            message: error.message,
                            path: ['roleData', ...error.path]
                        });
                    });
                }
                break;

            case 'CREATOR':
                const creatorResult = ZCreatorRoleData.partial().safeParse(data.roleData);
                if (!creatorResult.success) {
                    creatorResult.error.errors.forEach(error => {
                        ctx.addIssue({
                            code: "custom",
                            message: error.message,
                            path: ['roleData', ...error.path]
                        });
                    });
                }
                break;

            case 'SUPPLIER':
                const supplierResult = ZSupplierRoleData.partial().safeParse(data.roleData);
                if (!supplierResult.success) {
                    supplierResult.error.errors.forEach(error => {
                        ctx.addIssue({
                            code: "custom",
                            message: error.message,
                            path: ['roleData', ...error.path]
                        });
                    });
                }
                break;

            case 'SKILL':
                const skillResult = ZSkillRoleData.partial().safeParse(data.roleData);
                if (!skillResult.success) {
                    skillResult.error.errors.forEach(error => {
                        ctx.addIssue({
                            code: "custom",
                            message: error.message,
                            path: ['roleData', ...error.path]
                        });
                    });
                }
                break;

            case 'TALENT':
                const talentResult = ZTalentRoleData.partial().safeParse(data.roleData);
                if (!talentResult.success) {
                    talentResult.error.errors.forEach(error => {
                        ctx.addIssue({
                            code: "custom",
                            message: error.message,
                            path: ['roleData', ...error.path]
                        });
                    });
                }
                break;
        }
    }
});

// Partner status update schema
const ZUpdatePartnerStatus = z.object({
    status: z.enum(PARTNER_STATUSES, {
        errorMap: () => ({ message: "Invalid partner status" })
    }),
    reason: z.string().min(1, "Reason for status change is required").optional()
});

// Partner query/filter schema
const ZPartnerQuery = z.object({
    role: z.enum([...PARTNER_ROLES, 'ALL'] as [string, ...string[]]).optional(),
    status: z.enum([...PARTNER_STATUSES, 'ALL'] as [string, ...string[]]).optional(),
    country: z.string().optional(),
    city: z.string().optional(),
    isVerified: z.coerce.boolean().optional(),
    isAvailable: z.coerce.boolean().optional(),
    minRating: z.coerce.number().min(1).max(5).optional(),
    search: z.string().optional(), // For text search
    page: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional()
});

// Validation middleware functions
export const validateCreatePartner = (req: Request, res: Response, next: NextFunction) => {
    try {
        console.log(req.body, "This is from the validate create partner")
        ZCreatePartner.parse(req.body);
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
};

export const validateUpdatePartner = (req: Request, res: Response, next: NextFunction) => {
    try {
        ZUpdatePartner.parse(req.body);
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
};

export const validatePartnerStatusUpdate = (req: Request, res: Response, next: NextFunction) => {
    try {
        ZUpdatePartnerStatus.parse(req.body);
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
};

export const validatePartnerQuery = (req: Request, res: Response, next: NextFunction) => {
    try {
        ZPartnerQuery.parse(req.query);
        next();
    } catch (error) {
        zodErrorHandler(error, next);
    }
};

// Export schemas for reuse
export {
    ZCreatePartner,
    ZUpdatePartner,
    ZUpdatePartnerStatus,
    ZPartnerQuery,
    ZTutorRoleData,
    ZLogisticsRoleData,
    ZCreatorRoleData,
    ZSupplierRoleData,
    ZSkillRoleData,
    ZTalentRoleData
};