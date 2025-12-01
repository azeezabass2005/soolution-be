import winston from 'winston';
import path from 'path';
import DailyRotateFile from 'winston-daily-rotate-file';

/**
 * Custom log levels with associated severity
 */
const logLevels = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4,
};

/**
 * Color mapping for different log levels
 * @type {Object.<string, string>}
 */
const logColors: { [s: string]: string; } = {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    debug: 'blue',
};

/**
 * Creates a custom log format for consistent logging
 * @type {winston.Logform.Format}
 */
const logFormat: winston.Logform.Format = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.printf(({ timestamp, level, message, ...metadata }) => {
        let msg = `${timestamp} [${level}]: ${message} `;
        const metaString = Object.keys(metadata).length
            ? JSON.stringify(metadata)
            : '';
        return msg + metaString;
    })
);

/**
 * Console transport for logging
 * @type {winston.transports.ConsoleTransportInstance}
 */
const consoleTransport: winston.transports.ConsoleTransportInstance = new winston.transports.Console({
    format: winston.format.combine(
        winston.format.colorize({ all: true }),
        logFormat
    ),
    level: 'debug'
});

/**
 * Error log file transport with daily rotation
 * @type {DailyRotateFile}
 */
const errorFileTransport: DailyRotateFile = new DailyRotateFile({
    filename: path.join(process.cwd(), 'logs', 'error-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    level: 'error',
    maxSize: '20m',
    maxFiles: '14d'
});

/**
 * HTTP log file transport with daily rotation
 * @type {DailyRotateFile}
 */
const httpFileTransport: DailyRotateFile = new DailyRotateFile({
    filename: path.join(process.cwd(), 'logs', 'http-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    level: 'http',
    maxSize: '20m',
    maxFiles: '14d'
});

/**
 * Combined log file transport with daily rotation
 * @type {DailyRotateFile}
 */
const combinedFileTransport: DailyRotateFile = new DailyRotateFile({
    filename: path.join(process.cwd(), 'logs', 'combined-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    level: 'info',
    maxSize: '20m',
    maxFiles: '30d'
});

/**
 * Create a comprehensive logger with multiple transports
 * @type {winston.Logger}
 */
const logger: winston.Logger = winston.createLogger({
    levels: logLevels,
    format: logFormat,
    transports: [
        consoleTransport,
        errorFileTransport,
        httpFileTransport,
        combinedFileTransport
    ],
    exceptionHandlers: [
        new winston.transports.File({
            filename: path.join(process.cwd(), 'logs', 'exceptions.log')
        })
    ],
    rejectionHandlers: [
        new winston.transports.File({
            filename: path.join(process.cwd(), 'logs', 'rejections.log')
        })
    ],
    exitOnError: false
});

// Add colors to Winston
winston.addColors(logColors);

export default logger;