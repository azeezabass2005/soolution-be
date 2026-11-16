import './polyfills';
import logger from './utils/logger.utils';
import App from './app';

const server = new App();

process.on('exit', (code) => {
    logger.info(`Process exiting with code: ${code}`);
});

/** Finish in-flight requests and close the database pool before exiting */
const shutdown = (signal: string) => {
    logger.info(`Server shutting down (${signal})`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server
        .stop()
        .catch((error) => logger.error('Error during shutdown', { error: error instanceof Error ? error.message : String(error) }))
        .finally(() => process.exit(0));
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const startServer = async () => {
    try {
        await server.start();
    } catch (error) {
        logger.error('Failed to start server', {
            error: error instanceof Error ? error.message : error
        });
        process.exit(1);
    }
};

startServer();
