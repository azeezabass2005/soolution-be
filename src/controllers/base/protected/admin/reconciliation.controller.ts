import { Request, Response, NextFunction } from 'express';
import BaseController from '../../base-controller';
import RoleMiddleware from '../../../../middlewares/role.middleware';
import reconciliationService from '../../../../services/reconciliation.service';
import errorResponseMessage from '../../../../common/messages/error-response-message';

class AdminReconciliationController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.use(RoleMiddleware.isAdmin);

        this.router.get('/reports', this.listReports.bind(this));
        this.router.get('/reports/:id', this.getReport.bind(this));
        this.router.post('/run', this.runReconciliation.bind(this));

        this.router.get('/alerts', this.listAlerts.bind(this));
        this.router.post('/alerts/:id/acknowledge', this.acknowledgeAlert.bind(this));
    }

    private async listReports(req: Request, res: Response, next: NextFunction) {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const limit = parseInt(req.query.limit as string) || 20;
            const result = await reconciliationService.listReports({ page, limit });
            return this.sendSuccess(res, result);
        } catch (error) {
            return next(error);
        }
    }

    private async getReport(req: Request, res: Response, next: NextFunction) {
        try {
            const report = await reconciliationService.getReport(req.params.id);
            if (!report) throw errorResponseMessage.resourceNotFound('Reconciliation report');
            return this.sendSuccess(res, { report });
        } catch (error) {
            return next(error);
        }
    }

    /**
     * Trigger an on-demand reconciliation. Returns the resulting report id so
     * the admin UI can poll/redirect to the detail page.
     */
    private async runReconciliation(_req: Request, res: Response, next: NextFunction) {
        try {
            const adminUser = res.locals.user;
            const report = await reconciliationService.runFullReconciliation({
                runMode: 'on_demand',
                runBy: adminUser?.id,
            });
            return this.sendSuccess(res, { report }, 201);
        } catch (error) {
            return next(error);
        }
    }

    private async listAlerts(req: Request, res: Response, next: NextFunction) {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const limit = parseInt(req.query.limit as string) || 25;
            const result = await reconciliationService.listAlerts(
                {
                    severity: typeof req.query.severity === 'string' ? req.query.severity : undefined,
                    code: typeof req.query.code === 'string' ? req.query.code : undefined,
                    acknowledged: req.query.acknowledged === 'true' ? true : req.query.acknowledged === 'false' ? false : undefined,
                },
                { page, limit }
            );
            return this.sendSuccess(res, result);
        } catch (error) {
            return next(error);
        }
    }

    private async acknowledgeAlert(req: Request, res: Response, next: NextFunction) {
        try {
            const adminUser = res.locals.user;
            const updated = await reconciliationService.acknowledgeAlert(req.params.id, adminUser?.id);
            if (!updated) throw errorResponseMessage.resourceNotFound('Alert');
            return this.sendSuccess(res, { alert: updated });
        } catch (error) {
            return next(error);
        }
    }
}

export default new AdminReconciliationController().router;
