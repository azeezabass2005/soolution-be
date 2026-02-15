import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { R2Config } from '../config/r2.config';
import { UploadResult } from '../types/file.types';
import axios from 'axios';
import https from 'https';

export class StorageService {
    private s3Client = R2Config.getInstance();
    private bucketName: string;

    constructor(bucketName: string = process.env.R2_BUCKET_NAME || 'default-bucket') {
        this.bucketName = bucketName;
    }

    public async uploadFile(
        key: string,
        buffer: Buffer,
        mimeType: string,
        originalName: string,
        makePublic: boolean = false,
        retries: number = 3
    ): Promise<UploadResult> {
        let lastError: Error | null = null;
        
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                // R2 doesn't support ACL parameter - public access is configured at bucket level
                // For images, use 'inline' instead of 'attachment' so they display in browser
                const isImage = mimeType.startsWith('image/');
                const contentDisposition = isImage 
                    ? `inline; filename="${originalName}"`
                    : `attachment; filename="${originalName}"`;

                const command = new PutObjectCommand({
                    Bucket: this.bucketName,
                    Key: key,
                    Body: buffer,
                    ContentType: mimeType,
                    ContentDisposition: contentDisposition,
                    // Note: R2 doesn't support ACL - public access must be configured at bucket level
                    Metadata: {
                        originalName: originalName,
                        uploadedAt: new Date().toISOString(),
                    },
                });

                await this.s3Client.send(command);

                // Construct URL - ensure no double slashes
                const publicUrl = process.env.R2_PUBLIC_URL?.replace(/\/$/, ''); // Remove trailing slash
                const cleanKey = key.startsWith('/') ? key.substring(1) : key; // Remove leading slash
                const url = makePublic
                    ? `${publicUrl}/${cleanKey}`
                    : await this.getFileUrl(key);

                // Verify file exists (for public files)
                if (makePublic) {
                    try {
                        const exists = await this.fileExists(key);
                        if (!exists) {
                            console.warn(`⚠️ File uploaded but not found at key: ${key}`);
                        } else {
                            console.log(`✅ File successfully uploaded: ${key} -> ${url}`);
                        }
                    } catch (verifyError) {
                        console.warn(`⚠️ Could not verify file existence: ${verifyError}`);
                    }
                }

                return {
                    success: true,
                    file: {
                        key,
                        url,
                        size: buffer.length,
                        mimeType,
                        originalName,
                    },
                };
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                
                // If it's a 503 or timeout error and we have retries left, wait and retry
                if (attempt < retries) {
                    const isRetryableError = 
                        (error as any)?.$metadata?.httpStatusCode === 503 ||
                        (error as any)?.$metadata?.httpStatusCode === 500 ||
                        (error as any)?.code === 'ECONNRESET' ||
                        (error as any)?.code === 'ETIMEDOUT' ||
                        (error as any)?.name === 'TimeoutError';
                    
                    if (isRetryableError) {
                        // Exponential backoff: wait 1s, 2s, 4s
                        const waitTime = Math.pow(2, attempt - 1) * 1000;
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                        continue;
                    }
                }
                
                // If not retryable or out of retries, break and return error
                break;
            }
        }

        return {
            success: false,
            error: `Failed to upload file after ${retries} attempts: ${lastError?.message || 'Unknown error'}. ${lastError instanceof Error && lastError.message.includes('503') ? 'R2 service is temporarily unavailable. Please try again in a few moments.' : ''}`,
        };
    }

    public async deleteFile(key: string): Promise<boolean> {
        try {
            const command = new DeleteObjectCommand({
                Bucket: this.bucketName,
                Key: key,
            });

            await this.s3Client.send(command);
            return true;
        } catch (error) {
            console.error('Failed to delete file:', error);
            return false;
        }
    }

    public async getFileUrl(key: string, expiresIn: number = 3600): Promise<string> {
        try {
            const command = new GetObjectCommand({
                Bucket: this.bucketName,
                Key: key,
            });

            return await getSignedUrl(this.s3Client, command, { expiresIn });
        } catch (error) {
            throw new Error(`Failed to generate file URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    public async fileExists(key: string): Promise<boolean> {
        try {
            const command = new GetObjectCommand({
                Bucket: this.bucketName,
                Key: key,
            });

            await this.s3Client.send(command);
            return true;
        } catch (error) {
            return false;
        }
    }

    public async downloadFile(url: string): Promise<Buffer> {
        try {
            const response = await axios.get(url, { 
                responseType: 'arraybuffer',
                httpsAgent: process.env.NODE_ENV !== 'production' ? new https.Agent({
                    rejectUnauthorized: false // Allow self-signed certificates in development
                }) : undefined
            });
            return Buffer.from(response.data);
        } catch (error) {
            // If download fails in development, try without SSL verification as fallback
            if (process.env.NODE_ENV !== 'production') {
                const response = await axios.get(url, { 
                    responseType: 'arraybuffer',
                    httpsAgent: new https.Agent({
                        rejectUnauthorized: false
                    })
                });
                return Buffer.from(response.data);
            }
            throw error;
        }
    }
}