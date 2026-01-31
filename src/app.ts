import express, { Express, Request, Response } from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import morgan from 'morgan';
import config from './config/env.config';
import logger from './utils/logger.utils';
import routes from './routes';
import DatabaseService from "./config/db.config";
import ResponseErrorHandler from "./middlewares/error.middleware";
import NotificationService from './utils/notification.utils';


/**
 * Express application wrapper class
 * @class App
 */
class App {
    public app: Express;
    private dbService: DatabaseService;
    private notificationService: NotificationService;
    /**
     * Creates an instance of App
     * Initializes Express application and middlewares
     */
    constructor() {
        this.app = express();
        this.dbService = DatabaseService.getInstance();
        this.notificationService = new NotificationService();
        this.setupMiddlewares();
        this.setupDatabase().then(() => {});
        this.connectWhatsapp().then(() => {})
        this.setupRoutes();
        this.setupErrorHandling();

    }

    /**
     * Configure application middlewares
     * @private
     */
    private setupMiddlewares(): void {
        // Security middlewares
        this.app.use(helmet());
        this.app.use(cors({
            origin: [
                'http://localhost:3000',
                'https://soolution.co',
                'https://www.soolution.co',
                'https://trycloudflared.com'
            ],
            credentials: true,
            exposedHeaders: ['set-cookie']
        }));

        // Rate limiting
        const limiter = rateLimit({
            windowMs: config.RATE_LIMIT_WINDOW_MS,
            limit: config.RATE_LIMIT_MAX,
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
        this.app.use('/api', limiter);

        // Body parsing
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
        await this.dbService.connect()
    }

    /**
     * Configure whatsapp connection
     * @private
     */
    private async connectWhatsapp(): Promise<void> {
        await this.notificationService.disconnectWhatsApp();
        // await this.notificationService.initializeWhatsApp();
    }

    /**
     * Configure application routes
     * @private
     */
    private setupRoutes(): void {
        // Health check endpoint
        this.app.get('/health', (_req: Request, res: Response) => {
            const health = {
                status: 'healthy',
                timestamp: new Date().toISOString(),
                environment: config.NODE_ENV,
                mongodb: mongoose.connection.readyState === 1
            };

            logger.debug('Health check requested', health);
            res.status(200).json(health);
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
    public start(): void {
        this.app.listen(config.PORT, () => {
            logger.info(`Server started`, {
                port: config.PORT,
                environment: config.NODE_ENV,
                nodeVersion: process.version
            });
        });
    }
}

export default App;
