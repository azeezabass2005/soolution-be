import { Request, Response, NextFunction } from "express";
import errorResponseMessage, { ErrorSeverity } from "../common/messages/error-response-message";
import path from "path";

/**
 * Receipt File Validation Middleware
 * 
 * Validates receipt uploads for:
 * - File type: images (jpg, jpeg, png) and PDF only
 * - File size: maximum 10MB (reasonable for receipt images and PDFs)
 */
class ReceiptFileValidationMiddleware {
    // Maximum file size: 10MB (should be more than enough for receipt images and PDFs)
    private readonly MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

    // Allowed MIME types for receipts
    private readonly ALLOWED_MIME_TYPES = [
        'image/jpeg',
        'image/jpg',
        'image/png',
        'application/pdf'
    ];

    // Allowed file extensions
    private readonly ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.pdf'];

    /**
     * Validates receipt file upload
     * @param req Express request object
     * @param res Express response object
     * @param next Next middleware function
     */
    validateReceiptFile = (req: Request, res: Response, next: NextFunction): void => {
        try {
            const file = req.file;

            if (!file) {
                return next(errorResponseMessage.payloadIncorrect("Receipt file is required"));
            }

            // Validate file size
            if (file.size > this.MAX_FILE_SIZE) {
                return next(errorResponseMessage.createError(
                    400,
                    `File size exceeds maximum allowed size of ${this.MAX_FILE_SIZE / (1024 * 1024)}MB. Please upload a smaller file.`,
                    ErrorSeverity.HIGH
                ));
            }

            // Validate MIME type
            if (!this.ALLOWED_MIME_TYPES.includes(file.mimetype)) {
                return next(errorResponseMessage.createError(
                    400,
                    `Invalid file type. Only images (JPG, PNG) and PDF files are allowed for receipts. Received: ${file.mimetype}`,
                    ErrorSeverity.HIGH
                ));
            }

            // Validate file extension
            const ext = path.extname(file.originalname).toLowerCase();
            if (!this.ALLOWED_EXTENSIONS.includes(ext)) {
                return next(errorResponseMessage.createError(
                    400,
                    `Invalid file extension. Only .jpg, .jpeg, .png, and .pdf files are allowed. Received: ${ext}`,
                    ErrorSeverity.HIGH
                ));
            }

            // Additional validation: Check if MIME type matches extension
            const mimeTypeMatchesExtension = this.validateMimeTypeExtensionMatch(file.mimetype, ext);
            if (!mimeTypeMatchesExtension) {
                return next(errorResponseMessage.createError(
                    400,
                    "File type mismatch: MIME type does not match file extension. Please ensure the file is not corrupted.",
                    ErrorSeverity.HIGH
                ));
            }

            next();
        } catch (error) {
            next(error);
        }
    };

    /**
     * Validates that MIME type matches the file extension
     * @param mimeType File MIME type
     * @param extension File extension
     * @returns true if MIME type matches extension
     */
    private validateMimeTypeExtensionMatch(mimeType: string, extension: string): boolean {
        const mimeTypeMap: Record<string, string[]> = {
            'image/jpeg': ['.jpg', '.jpeg'],
            'image/jpg': ['.jpg', '.jpeg'],
            'image/png': ['.png'],
            'application/pdf': ['.pdf']
        };

        const allowedExtensions = mimeTypeMap[mimeType];
        return allowedExtensions ? allowedExtensions.includes(extension) : false;
    }
}

export default new ReceiptFileValidationMiddleware();
