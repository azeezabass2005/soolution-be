import express, { Express, Request, Response } from 'express';
import type { Server } from 'http';
import { environmentMismatch } from "./utils/environment-check.utils";
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import morgan from 'morgan';
import config from './config/env.config';
import logger from './utils/logger.utils';
import routes from './routes';
import DatabaseService from "./config/db.config";
import { addLegacyIdAliases } from "./utils/json.utils";
import ResponseErrorHandler from "./middlewares/error.middleware";
import providerRedaction from "./middlewares/provider-redaction.middleware";
import NotificationService from './utils/notification.utils';
import { bootstrapSystemAccounts } from './services/account.bootstrap';
import { registerJobs, unregisterJobs } from './jobs';

const PRODUCTION_ORIGINS = [
    'https://solutionpay.co',
    'https://www.solutionpay.co',
];

/**
 * Browser origins allowed to call the API with cookies. CORS_ORIGIN (a
 * comma-separated list) replaces the default production list, e.g. on
 * staging. Outside production, localhost:3000 is always allowed.
 */
function allowedOrigins(): string[] {
    const configured = config.CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter((origin) => origin && origin !== '*');
    const origins = configured.length ? configured : PRODUCTION_ORIGINS;
    return config.NODE_ENV === 'production' ? origins : [...origins, 'http://localhost:3000'];
}

/**
 * Express application wrapper class
 * @class App
 */
class App {
    public app: Express;
    private dbService: DatabaseService;
    private notificationService: NotificationService;
    private server: Server | null = null;
    /**
     * Creates an instance of App
     * Builds the Express application (middlewares, routes, error handling).
     * Nothing external is touched until `start()`, so tests can use `app` directly.
     */
    constructor() {
        this.app = express();
        this.dbService = DatabaseService.getInstance();
        this.notificationService = new NotificationService();
        this.setupMiddlewares();
        this.setupRoutes();
        this.setupErrorHandling();
    }

    /**
     * Configure application middlewares
     * @private
     */
    private setupMiddlewares(): void {
        // One reverse proxy (Traefik) sits in front: trust its X-Forwarded-For
        // so req.ip, rate limits and audit logs see the real client address
        this.app.set('trust proxy', 1);

        // Security middlewares
        this.app.use(helmet());
        this.app.use(cors({
            origin: allowedOrigins(),
            credentials: true,
            exposedHeaders: ['set-cookie']
        }));

        // Rate limiting
        const limiter = rateLimit({
            windowMs: config.RATE_LIMIT_WINDOW_MS,
            limit: config.RATE_LIMIT_MAX,
            standardHeaders: true,
            legacyHeaders: false,
            handler: (req: Request, res: Response) => {
                logger.warn('Rate limit exceeded', {
                    ip: req.ip,
                    path: req.path
                });
                res.status(429).json({
                    success: false,
                    message: 'Too many requests, please try again later'
                });
            }
        });
        // Customers never see our providers' names or raw records (admins do)
        this.app.use(providerRedaction);

        this.app.use('/api', limiter);

        // Body parsing — capture raw body for webhook signature verification
        this.app.use(express.json({
            limit: '10mb',
            verify: (req: any, _res, buf) => {
                req.rawBody = buf.toString();
            },
        }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

        // Responses carry `_id` next to `id` for every record, as they did with
        // Mongo, so existing clients reading either keep working
        this.app.set('json replacer', addLegacyIdAliases);

        // Compression
        this.app.use(compression());

        // Request logging
        // TODO: I will uncomment this line back the stuff being logged are too much and making 
        // this.app.use(morgan('combined', {
        //     stream: {
        //         write: (message: string) => {
        //             logger.http(message.trim());
        //         }
        //     }
        // }));
    }

    /**
     * Configure database connection
     * @private
     */
    private async setupDatabase(): Promise<void> {
        // Fails fast: the API is useless without its database. Schema changes
        // are applied by `npm run db:migrate` before the server starts.
        await this.dbService.connect();
        // System ledger accounts must exist before any money path runs.
        // Idempotent — only creates missing accounts.
        await bootstrapSystemAccounts();
        // Background source-of-truth jobs (reconciliation + stale sweeper).
        // Skipped under tests if needed by setting DISABLE_JOBS=true.
        if (process.env.DISABLE_JOBS !== 'true') {
            try {
                registerJobs();
            } catch (error) {
                logger.error('Failed to register background jobs', {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    /**
     * Configure whatsapp connection
     * @private
     */
    private async connectWhatsapp(): Promise<void> {
        // await this.notificationService.disconnectWhatsApp();
        await this.notificationService.initializeWhatsApp();
    }

    /**
     * Verify email service connection
     * @private
     */
    private async verifyEmailService(): Promise<void> {
        try {
            const isVerified = await this.notificationService.emailService.verifyConnection();
            if (isVerified) {
                logger.info('Email service verified and ready');
            }
        } catch (error) {
            logger.warn('Email service verification failed', {
                error: error instanceof Error ? error.message : String(error)
            });
            logger.warn('Email functionality may not work properly. Please check your email configuration.');
        }
    }

    /**
     * Configure application routes
     * @private
     */
    private setupRoutes(): void {
        // Health check endpoint
        this.app.get('/health', (_req: Request, res: Response) => {
            const database = this.dbService.isConnected();
            const health = {
                status: database ? 'healthy' : 'unhealthy',
                timestamp: new Date().toISOString(),
                environment: config.NODE_ENV,
                database,
            };

            logger.debug('Health check requested', health);
            res.status(database ? 200 : 503).json(health);
        });

        // API routes
        this.app.use(`/api/${config.API_VERSION}`, routes);
    }

    /**
     * Configure error handling
     * @private
     */
    private setupErrorHandling(): void {
        // this.app.use(errorHandler);

        ResponseErrorHandler.initialize(this.app)

        // Handle 404 errors
        this.app.use((req: Request, res: Response) => {
            logger.warn('Route not found', {
                method: req.method,
                path: req.path,
                ip: req.ip
            });

            res.status(404).json({
                success: false,
                message: 'Resource not found'
            });
        });

        // Handle uncaught exceptions
        process.on('uncaughtException', (error: Error) => {
            logger.error('Uncaught Exception', {
                error: {
                    name: error.name,
                    message: error.message,
                    stack: error.stack
                }
            });
            process.exit(1);
        });

        // Handle unhandled rejections
        process.on('unhandledRejection', (reason: any) => {
            logger.error('Unhandled Rejection', {
                reason: reason instanceof Error ? {
                    name: reason.name,
                    message: reason.message,
                    stack: reason.stack
                } : reason
            });
        });
    }

    /**
     * Start the application server
     * @public
     */
    public async start(): Promise<void> {
        // Staging and production must never send people to each other's site
        const mismatch = environmentMismatch(config.COOKIE_DOMAIN, config.FRONTEND_URL);
        if (mismatch) logger.error(`CONFIG MISMATCH: ${mismatch}. Fix FRONTEND_URL for this environment.`);
        await this.setupDatabase();
        this.connectWhatsapp().catch((error) => logger.error('WhatsApp connection failed', { error: error instanceof Error ? error.message : String(error) }));
        this.verifyEmailService().then(() => {});
        await new Promise<void>((resolve) => {
            this.server = this.app.listen(config.PORT, () => {
                logger.info(`Server started`, {
                    port: config.PORT,
                    environment: config.NODE_ENV,
                    nodeVersion: process.version
                });
                resolve();
            });
        });
    }

    /**
     * Stop taking requests, stop the background jobs and close the database pool
     * @public
     */
    public async stop(): Promise<void> {
        unregisterJobs();
        if (this.server) {
            const server = this.server;
            this.server = null;
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        await this.dbService.disconnect();
    }
}

export default App;
