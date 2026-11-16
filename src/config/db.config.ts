import logger from '../utils/logger.utils';
import config from './env.config';
import { closeDatabase, connectDatabase, isDatabaseConnected } from '../db/client';

/** Hide credentials when logging a connection string */
const redact = (url: string) => url.replace(/\/\/([^:/@]+):([^@]+)@/, '//***:***@');

class DatabaseService {
    private static instance: DatabaseService;

    private constructor() {}

    public static getInstance(): DatabaseService {
        if (!DatabaseService.instance) {
            DatabaseService.instance = new DatabaseService();
        }
        return DatabaseService.instance;
    }

    /** Opens the PostgreSQL pool; throws (and the server doesn't start) if it can't connect */
    public async connect(): Promise<void> {
        try {
            await connectDatabase({
                url: config.DATABASE_URL,
                ssl: config.DATABASE_SSL,
                sslRejectUnauthorized: config.DATABASE_SSL_REJECT_UNAUTHORIZED,
                poolMax: config.DATABASE_POOL_MAX,
                statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
            });
            logger.info('Connected to PostgreSQL', { url: redact(config.DATABASE_URL), poolMax: config.DATABASE_POOL_MAX });
        } catch (error) {
            logger.error('PostgreSQL connection error', {
                url: redact(config.DATABASE_URL),
                error: error instanceof Error ? error.message : error,
            });
            throw error;
        }
    }

    public async disconnect(): Promise<void> {
        await closeDatabase();
        logger.info('PostgreSQL connection pool closed');
    }

    public isConnected(): boolean {
        return isDatabaseConnected();
    }
}

export default DatabaseService;
