import path from 'path';
import { UploadConfig, FileValidationResult } from '../types/file.types';

export class FileValidator {
    constructor(private config: UploadConfig) {}

    public validateFile(file: Express.Multer.File): FileValidationResult {
        // Check if file exists
        if (!file) {
            return {
                isValid: false,
                error: 'No file provided'
            };
        }

        // Check file size
        if (file.size > this.config.maxFileSize) {
            return {
                isValid: false,
                error: `File size exceeds maximum allowed size of ${this.config.maxFileSize / (1024 * 1024)}MB`
            };
        }

        // Check MIME type
        if (!this.config.allowedMimeTypes.includes(file.mimetype)) {
            return {
                isValid: false,
                error: `File type ${file.mimetype} is not allowed`
            };
        }

        // Check file extension
        const ext = path.extname(file.originalname).toLowerCase();
        if (!this.config.allowedExtensions.includes(ext)) {
            return {
                isValid: false,
                error: `File extension ${ext} is not allowed`
            };
        }

        return { isValid: true };
    }

    public sanitizeFilename(filename: string, customName?: string): string {
        const ext = path.extname(filename).toLowerCase();

        if (customName) {
            // Use custom name if provided
            const sanitized = customName
                .replace(/[^a-zA-Z0-9.-]/g, '_')
                .replace(/_{2,}/g, '_')
                .toLowerCase();
            return `${sanitized}_${Date.now()}${ext}`;
        }

        // Default sanitization
        const sanitized = filename
            .replace(/[^a-zA-Z0-9.-]/g, '_')
            .replace(/_{2,}/g, '_')
            .toLowerCase();

        const timestamp = Date.now();
        const name = path.basename(sanitized, ext);

        return `${name}_${timestamp}${ext}`;
    }
}