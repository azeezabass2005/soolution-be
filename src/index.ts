import logger from './utils/logger.utils';
import App from './app';


process.on('exit', (code) => {
    logger.info(`Process exiting with code: ${code}`);
});

process.on('SIGINT', () => {
    logger.info('Server interrupted (SIGINT)');
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Server terminated (SIGTERM)');
    process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});


const startServer = async () => {
    try {
        const server = new App();
        server.start();
    } catch (error) {
        logger.error('Failed to start server', {
            error: error instanceof Error ? error.message : error
        });
        process.exit(1);
    }
}

startServer();