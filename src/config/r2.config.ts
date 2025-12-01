import { S3Client } from '@aws-sdk/client-s3';
import config from "./env.config";

export class R2Config {
    private static instance: S3Client;

    public static getInstance(): S3Client {
        if (!R2Config.instance) {
            R2Config.instance = new S3Client({
                region: 'auto',
                endpoint: config.R2_ENDPOINT || 'https://your-account-id.r2.cloudflarestorage.com',
                credentials: {
                    accessKeyId: config.R2_ACCESS_KEY_ID || '',
                    secretAccessKey: config.R2_SECRET_ACCESS_KEY || '',
                },
            });
        }
        return R2Config.instance;
    }
}