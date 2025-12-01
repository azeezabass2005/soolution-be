import { FileValidator } from '../validators/file.validator';
import { StorageService } from './storage.service';
import { UploadConfig, UploadResult, FileUploadOptions } from '../types/file.types';

export class FileUploadService {
    private fileValidator: FileValidator;
    private storageService: StorageService;

    constructor(
        private config: UploadConfig,
        bucketName?: string
    ) {
        this.fileValidator = new FileValidator(config);
        this.storageService = new StorageService(bucketName);
    }

    /**
     * Upload a single file and return the result
     * Can be used within any controller/service
     */
    public async uploadFile(
        file: Express.Multer.File,
        options: FileUploadOptions = {}
    ): Promise<UploadResult> {
        // Validate file
        const validation = this.fileValidator.validateFile(file);
        if (!validation.isValid) {
            return {
                success: false,
                error: validation.error,
            };
        }

        // Generate file key
        const sanitizedName = this.fileValidator.sanitizeFilename(
            file.originalname,
            options.customFilename
        );

        const folder = options.folder || this.config.uploadPath;
        const key = `${folder}${sanitizedName}`;

        // Upload to R2
        return await this.storageService.uploadFile(
            key,
            file.buffer,
            file.mimetype,
            file.originalname,
            options.makePublic
        );
    }

    /**
     * Upload multiple files
     */
    public async uploadMultipleFiles(
        files: Express.Multer.File[],
        options: FileUploadOptions = {}
    ): Promise<UploadResult[]> {
        const uploadPromises = files.map(file => this.uploadFile(file, options));
        return await Promise.all(uploadPromises);
    }

    /**
     * Delete a file by key
     */
    public async deleteFile(key: string): Promise<boolean> {
        return await this.storageService.deleteFile(key);
    }

    /**
     * Get a signed URL for a file
     */
    public async getFileUrl(key: string, expiresIn?: number): Promise<string> {
        return await this.storageService.getFileUrl(key, expiresIn);
    }

    /**
     * Check if a file exists
     */
    public async fileExists(key: string): Promise<boolean> {
        return await this.storageService.fileExists(key);
    }
}