export interface UploadConfig {
    maxFileSize: number;
    allowedMimeTypes: string[];
    allowedExtensions: string[];
    uploadPath: string;
}

export interface UploadResult {
    success: boolean;
    file?: {
        key: string;
        url: string;
        size: number;
        mimeType: string;
        originalName: string;
    };
    error?: string;
}

export interface FileValidationResult {
    isValid: boolean;
    error?: string;
}

export interface FileUploadOptions {
    folder?: string;
    customFilename?: string;
    makePublic?: boolean;
    expiresIn?: number;
}