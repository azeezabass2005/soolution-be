import mongoose from 'mongoose';
import logger from '../utils/logger.utils';
import config from './env.config';

class DatabaseService {
    private static instance: DatabaseService;

    private constructor() {
        this.setupConnectionHandlers();
    }

    public static getInstance(): DatabaseService {
        if (!DatabaseService.instance) {
            DatabaseService.instance = new DatabaseService();
        }
        return DatabaseService.instance;
    }

    private setupConnectionHandlers(): void {
        mongoose.connection.on('error', (error) => {
            logger.error('MongoDB connection error', {
                error: error instanceof Error ? error.message : error
            });
        });

        mongoose.connection.on('disconnected', () => {
            logger.warn('MongoDB disconnected');
        });

        process.on('SIGINT', async () => {
            try {
                await mongoose.connection.close();
                logger.info('MongoDB connection closed through app termination');
                process.exit(0);
            } catch (error) {
                logger.error('Error during MongoDB connection closure', {
                    error: error instanceof Error ? error.message : error
                });
                process.exit(1);
            }
        });
    }

    public async connect(): Promise<void> {
        try {
            await mongoose.connect(config.MONGODB_URI);
            logger.info('Connected to MongoDB successfully', {
                uri: config.MONGODB_URI.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@') // Hide credentials in logs
            });
        } catch (error) {
            logger.error('MongoDB connection error', {
                error: error instanceof Error ? error.message : error
            });
            process.exit(1);
        }
    }

    public async disconnect(): Promise<void> {
        await mongoose.connection.close();
    }

    public isConnected(): boolean {
        return mongoose.connection.readyState === 1;
    }
}

export default DatabaseService;