import BaseController from "../base-controller";
import { Request, Response, NextFunction } from "express";
import * as fs from "fs";
import * as path from "path";
import archiver from "archiver";
import errorResponseMessage from "../../../common/messages/error-response-message";
import RoleMiddleware from "../../../middlewares/role.middleware";

/**
 * Controller handling log download operations
 * @class LogController
 * @extends BaseController
 */
class LogController extends BaseController {

    /**
     * Creates an instance of the LogController
     */
    constructor() {
        super();
        this.setupRoutes();
    }

    /**
     * Sets up routes for log operations
     * @protected
     */
    protected setupRoutes(): void {
        // Download logs as zip route
        this.router.get("/download", RoleMiddleware.isAdmin, this.downloadLogs.bind(this));
    }

    /**
     * Downloads the logs folder as a zip file
     * @private
     */
    private async downloadLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const logsPath = path.join(process.cwd(), "logs");

            // Check if logs directory exists
            if (!fs.existsSync(logsPath)) {
                throw errorResponseMessage.resourceNotFound('Logs')
            }

            // Set response headers for zip download
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `logs-${timestamp}.zip`;

            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

            // Create zip archive
            const archive = archiver('zip', {
                zlib: { level: 9 } // Maximum compression
            });

            // Handle archive errors
            archive.on('error', (err) => {
                throw err;
            });

            // Pipe archive to response
            archive.pipe(res);

            // Add logs directory to archive
            archive.directory(logsPath, false);

            // Finalize the archive
            await archive.finalize();

        } catch (error) {
            next(error);
        }
    }
}

export default new LogController().router;