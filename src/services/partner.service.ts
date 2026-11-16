import partnerRepository, { type NewPartner, type PartnerFilter, type PartnerUpdate } from "../repositories/partner.repository";
import type { Partner } from "../types/entities";
import type { PageRequest, Paginated } from "../db/pagination";
import type { PartnerRole, PartnerStatus } from "../types/enums";
import { FileUploadFactory } from "./file-upload.factory";
import errorResponseMessage from "../common/messages/error-response-message";
import { UploadResult } from "../types/file.types";
import { isUniqueViolation } from "../db/errors";
import logger from "../utils/logger.utils";

const ROLES: PartnerRole[] = ["LOGISTICS", "SUPPLIER", "CREATOR", "SKILL", "TALENT", "TUTOR"];
const STATUSES: PartnerStatus[] = ["active", "inactive", "pending", "suspended"];

const asBoolean = (value: unknown): boolean | undefined => {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
};
const asNumber = (value: unknown): number | undefined => {
    if (value === undefined || value === null || value === "") return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
};
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value.trim() : undefined);

/** Partner fields a create/update request may set (validated by z-partners first) */
function partnerFields(body: Record<string, any>): PartnerUpdate {
    const roleData = typeof body.roleData === "string" ? safeJson(body.roleData) : body.roleData;
    return {
        name: asString(body.name),
        email: asString(body.email),
        phone: asString(body.phone),
        whatsappNumber: asString(body.whatsappNumber),
        country: asString(body.country),
        city: asString(body.city),
        role: ROLES.includes(body.role) ? body.role : undefined,
        status: STATUSES.includes(body.status) ? body.status : undefined,
        description: asString(body.description),
        website: asString(body.website),
        isVerified: asBoolean(body.isVerified),
        rating: asNumber(body.rating),
        totalReviews: asNumber(body.totalReviews),
        roleData: roleData && typeof roleData === "object" && !Array.isArray(roleData) ? roleData : undefined,
        isAvailable: asBoolean(body.isAvailable),
    };
}

function safeJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return undefined;
    }
}

class PartnerService {
    private profileUploadService = FileUploadFactory.getProfileUploadService();

    private async create(fields: PartnerUpdate): Promise<Partner> {
        try {
            return await partnerRepository.create(fields as NewPartner);
        } catch (error) {
            if (isUniqueViolation(error, "partners_email_key")) {
                throw errorResponseMessage.resourceAlreadyExist("Partner with this email");
            }
            throw error;
        }
    }

    public async createPartnerWithProfileImage(partnerData: Record<string, any>, profileImage: Express.Multer.File) {
        const uploadResult = await this.profileUploadService.uploadFile(profileImage, {
            folder: "profiles/",
            customFilename: `partner_${Date.now()}`,
            makePublic: true,
        });
        if (!uploadResult.success) {
            logger.error("Partner profile image upload failed", { error: uploadResult.error });
            throw errorResponseMessage.unableToComplete("Profile image upload failed");
        }

        return this.create({ ...partnerFields(partnerData), profileImage: uploadResult.file!.url });
    }

    public async updatePartnerWithProfileImage(partnerId: string, partnerData: Record<string, any>, profileImage?: Express.Multer.File) {
        let uploadResult: UploadResult | null = null;
        if (profileImage) {
            uploadResult = await this.profileUploadService.uploadFile(profileImage, {
                folder: "profiles/",
                customFilename: `partner_${Date.now()}`,
                makePublic: true,
            });
            if (!uploadResult.success) {
                throw errorResponseMessage.unableToComplete("Profile image upload failed");
            }
        }
        try {
            return await partnerRepository.update(partnerId, {
                ...partnerFields(partnerData),
                ...(uploadResult ? { profileImage: uploadResult.file!.url } : {}),
            });
        } catch (error) {
            if (isUniqueViolation(error, "partners_email_key")) {
                throw errorResponseMessage.resourceAlreadyExist("Partner with this email");
            }
            throw error;
        }
    }

    /** Only known filters are applied; anything else in the query is ignored */
    public toFilter(query: Record<string, unknown>): PartnerFilter {
        return {
            role: ROLES.includes(query.role as PartnerRole) ? (query.role as PartnerRole) : undefined,
            status: STATUSES.includes(query.status as PartnerStatus) ? (query.status as PartnerStatus) : undefined,
            country: asString(query.country) || undefined,
            city: asString(query.city) || undefined,
            isVerified: asBoolean(query.isVerified),
            isAvailable: asBoolean(query.isAvailable),
        };
    }

    /** Newest first */
    public async list(filter: PartnerFilter, page: PageRequest): Promise<Paginated<Partner>> {
        return partnerRepository.paginate(filter, page);
    }

    /** Partial, case-insensitive match on name, description, location and role skills */
    public async searchPartners(searchTerm: string, filter: PartnerFilter = {}, page: PageRequest = {}): Promise<Paginated<Partner>> {
        return partnerRepository.paginate(filter, page, searchTerm);
    }
}

export default PartnerService;
