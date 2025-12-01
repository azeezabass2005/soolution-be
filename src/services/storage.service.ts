import { PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { R2Config } from '../config/r2.config';
import { UploadResult } from '../types/file.types';
import axios from 'axios';

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
        makePublic: boolean = false
    ): Promise<UploadResult> {
        try {
            const command = new PutObjectCommand({
                Bucket: this.bucketName,
                Key: key,
                Body: buffer,
                ContentType: mimeType,
                ContentDisposition: `attachment; filename="${originalName}"`,
                ACL: makePublic ? 'public-read' : undefined,
                Metadata: {
                    originalName: originalName,
                    uploadedAt: new Date().toISOString(),
                },
            });

            await this.s3Client.send(command);

            const url = makePublic
                ? `${process.env.R2_PUBLIC_URL}/${key}`
                : await this.getFileUrl(key);

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
            return {
                success: false,
                error: `Failed to upload file: ${error instanceof Error ? error.message : 'Unknown error'}`,
            };
        }
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
        const response = await axios.get(url, { responseType: 'arraybuffer' });
        return Buffer.from(response.data);
    }
}