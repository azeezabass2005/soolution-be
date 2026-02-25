import multer from 'multer';
import { Request, Response, NextFunction } from 'express';

export class MulterMiddleware {
    // General upload configuration (50MB for general files)
    private static upload = multer({
        storage: multer.memoryStorage(),
        limits: {
            fileSize: 50 * 1024 * 1024,
        },
    });

    // Receipt upload configuration (10MB limit for receipts)
    private static receiptUpload = multer({
        storage: multer.memoryStorage(),
        limits: {
            fileSize: 10 * 1024 * 1024, // 10MB for receipts
        },
    });

    public static single(fieldName: string = 'file') {
        return this.upload.single(fieldName);
    }

    /**
     * Creates a multer middleware specifically for receipt uploads
     * Uses a 10MB file size limit
     * @param fieldName Field name for the file input
     * @returns Multer middleware instance
     */
    public static receipt(fieldName: string = 'receipt') {
        return this.receiptUpload.single(fieldName);
    }

    public static multiple(fieldName: string = 'files', maxCount: number = 10) {
        return this.upload.array(fieldName, maxCount);
    }

    public static fields(fields: { name: string; maxCount?: number }[]) {
        return this.upload.fields(fields);
    }

    public static handleError = (
        error: any,
        req: Request,
        res: Response,
        next: NextFunction
    ): void => {
        if (error instanceof multer.MulterError) {
            switch (error.code) {
                case 'LIMIT_FILE_SIZE':
                    res.status(400).json({
                        success: false,
                        error: 'File size too large',
                    });
                    return;
                case 'LIMIT_FILE_COUNT':
                    res.status(400).json({
                        success: false,
                        error: 'Too many files',
                    });
                    return;
                case 'LIMIT_UNEXPECTED_FILE':
                    res.status(400).json({
                        success: false,
                        error: 'Unexpected file field',
                    });
                    return;
                default:
                    res.status(400).json({
                        success: false,
                        error: 'File upload error',
                    });
                    return;
            }
        }
        next(error);
    };
}