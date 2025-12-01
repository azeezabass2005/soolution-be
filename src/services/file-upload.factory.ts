import { FileUploadService } from './file-upload.service';
import { defaultUploadConfig, profileImageConfig, documentConfig } from '../config/upload.config';
import {UploadConfig} from "../types/file.types";

export class FileUploadFactory {
    private static profileUploadService: FileUploadService;
    private static documentUploadService: FileUploadService;
    private static generalUploadService: FileUploadService;

    /**
     * Get service for profile image uploads
     */
    public static getProfileUploadService(): FileUploadService {
        if (!this.profileUploadService) {
            this.profileUploadService = new FileUploadService(profileImageConfig);
        }
        return this.profileUploadService;
    }

    /**
     * Get service for document uploads
     */
    public static getDocumentUploadService(): FileUploadService {
        if (!this.documentUploadService) {
            this.documentUploadService = new FileUploadService(documentConfig);
        }
        return this.documentUploadService;
    }

    /**
     * Get service for general file uploads
     */
    public static getGeneralUploadService(): FileUploadService {
        if (!this.generalUploadService) {
            this.generalUploadService = new FileUploadService(defaultUploadConfig);
        }
        return this.generalUploadService;
    }

    /**
     * Create a custom upload service with specific config
     */
    public static createCustomUploadService(config: UploadConfig, bucketName?: string): FileUploadService {
        return new FileUploadService(config, bucketName);
    }
}
