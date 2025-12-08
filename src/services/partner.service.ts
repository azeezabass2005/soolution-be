import DBService from "../utils/db.utils";
import {IPartner} from "../models/interface";
import Partner from "../models/partner.model";
import {FileUploadFactory} from "./file-upload.factory";
import errorResponseMessage from "../common/messages/error-response-message";
import {UploadResult} from "../types/file.types";

class PartnerService extends DBService<IPartner> {
    /**
     * Creates an instance of MarketplaceService
     * @constructor
     */
    constructor() {
        super(Partner);
    }

    private profileUploadService = FileUploadFactory.getProfileUploadService();

    public async createPartnerWithProfileImage (partnerData: Partial<IPartner>, profileImage: Express.Multer.File) {
        const uploadResult = await this.profileUploadService.uploadFile(profileImage as Express.Multer.File, {
            folder: 'profiles/',
            customFilename: `partner_${Date.now()}`,
            makePublic: true,
        })
        console.log(uploadResult, "This is the upload result from cloudflare")
        if(!uploadResult.success) {
            throw errorResponseMessage.unableToComplete("Profile image upload failed");
        }

        return await this.create({...partnerData, profileImage: uploadResult.file!.url})
    }

    public async updatePartnerWithProfileImage (partnerId: string, partnerData: Partial<IPartner>, profileImage: Express.Multer.File) {
        let uploadResult: UploadResult | null = null;
        if(profileImage) {
             uploadResult = await this.profileUploadService.uploadFile(profileImage, {
                folder: 'profiles/',
                customFilename: `partner_${Date.now()}`,
                makePublic: true,
            })
            if(!uploadResult.success) {
                throw errorResponseMessage.unableToComplete("Profile image upload failed");
            }
        }
        return await this.updateById(partnerId,{...partnerData, ...( uploadResult ? {profileImage: uploadResult.file!.url} : {})})
    }

    /**
     * Search partners with flexible text matching
     * @param searchTerm - The term to search for
     * @param filters - Additional filters
     * @param options - Pagination and sorting options
     */
    public async searchPartners(
        searchTerm: string,
        filters: Partial<IPartner> = {},
        options: {
            page?: number;
            limit?: number;
            useTextSearch?: boolean;
        } = {}
    ) {
        const { page = 1, limit = 10, useTextSearch = false } = options;

        let query: any = { ...filters };
        let sortOptions: Record<string, any> = { createdAt: -1 };

        if (searchTerm?.trim()) {
            const cleanedSearchTerm = searchTerm.trim();

            if (useTextSearch && cleanedSearchTerm.length >= 3) {
                // Use text search for better performance on full words
                query.$text = { $search: cleanedSearchTerm };
                sortOptions = { score: { $meta: "textScore" } };
            } else {
                // Use regex for partial matching
                const escapedSearchTerm = cleanedSearchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(escapedSearchTerm, 'i');

                query.$or = [
                    { name: regex },
                    { description: regex },
                    { city: regex },
                    { country: regex },
                    { 'roleData.skills': { $elemMatch: { $regex: regex } } },
                    { 'roleData.specialties': { $elemMatch: { $regex: regex } } },
                    { 'roleData.subjects': { $elemMatch: { $regex: regex } } },
                    { 'roleData.talents': { $elemMatch: { $regex: regex } } },
                    { 'roleData.expertise': regex },
                    { 'roleData.bio': regex },
                    { 'roleData.title': regex },
                ];
            }
        }

        return this.paginate(query, {
            page,
            limit,
            sort: sortOptions
        });
    }
}

export default PartnerService;