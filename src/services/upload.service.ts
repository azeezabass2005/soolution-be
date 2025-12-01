import multer from 'multer';
import { FileValidator } from '../validators/file.validator';
import { StorageService } from './storage.service';
import { UploadConfig, UploadResult } from '../types/file.types';

export class UploadService {
    private fileValidator: FileValidator;
    private storageService: StorageService;
    private multerUpload: multer.Multer;

    constructor(
        private config: UploadConfig,
        bucketName?: string
    ) {
        this.fileValidator = new FileValidator(config);
        this.storageService = new StorageService(bucketName);
        this.multerUpload = multer({
            storage: multer.memoryStorage(),
            limits: {
                fileSize: config.maxFileSize,
            },
        });
    }

    public getMulterMiddleware() {
        return this.multerUpload.single('file');
    }

    public getMultipleFilesMiddleware(maxCount: number = 10) {
        return this.multerUpload.array('files', maxCount);
    }

    public async uploadSingleFile(file: Express.Multer.File): Promise<UploadResult> {
        // Validate file
        const validation = this.fileValidator.validateFile(file);
        if (!validation.isValid) {
            return {
                success: false,
                error: validation.error,
            };
        }

        // Generate sanitized filename
        const sanitizedName = this.fileValidator.sanitizeFilename(file.originalname);
        const key = `${this.config.uploadPath}${sanitizedName}`;

        // Upload to R2
        return await this.storageService.uploadFile(
            key,
            file.buffer,
            file.mimetype,
            file.originalname
        );
    }

    public async uploadMultipleFiles(files: Express.Multer.File[]): Promise<UploadResult[]> {
        const uploadPromises = files.map(file => this.uploadSingleFile(file));
        return await Promise.all(uploadPromises);
    }

    public async deleteFile(key: string): Promise<boolean> {
        return await this.storageService.deleteFile(key);
    }

    public async getFileUrl(key: string, expiresIn?: number): Promise<string> {
        return await this.storageService.getFileUrl(key, expiresIn);
    }
}