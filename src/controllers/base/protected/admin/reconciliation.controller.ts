import { Request, Response, NextFunction } from 'express';
import BaseController from '../../base-controller';
import RoleMiddleware from '../../../../middlewares/role.middleware';
import reconciliationService from '../../../../services/reconciliation.service';
import ReconciliationReport from '../../../../models/reconciliation-report.model';
import LedgerAlert from '../../../../models/ledger-alert.model';
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
            // @ts-ignore — paginate plugin
            const result = await ReconciliationReport.paginate({}, {
                page, limit, sort: { startedAt: -1 },
                customLabels: {
                    totalDocs: 'itemsCount', docs: 'data', limit: 'perPage',
                    page: 'currentPage', nextPage: 'next', prevPage: 'prev',
                    totalPages: 'pageCount', pagingCounter: 'serialNumber', meta: 'paginator',
                },
            });
            return this.sendSuccess(res, result);
        } catch (error) {
            return next(error);
        }
    }

    private async getReport(req: Request, res: Response, next: NextFunction) {
        try {
            const report = await ReconciliationReport.findById(req.params.id);
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
                runBy: adminUser?._id?.toString(),
            });
            return this.sendSuccess(res, { report }, 201);
        } catch (error) {
            return next(error);
        }
    }

    private async listAlerts(req: Request, res: Response, next: NextFunction) {
        try {
            const filter: any = {};
            if (typeof req.query.severity === 'string') filter.severity = req.query.severity;
            if (typeof req.query.code === 'string') filter.code = req.query.code;
            if (req.query.acknowledged === 'false') filter.acknowledgedAt = { $exists: false };
            if (req.query.acknowledged === 'true') filter.acknowledgedAt = { $exists: true };

            const page = parseInt(req.query.page as string) || 1;
            const limit = parseInt(req.query.limit as string) || 25;
            // @ts-ignore — paginate plugin
            const result = await LedgerAlert.paginate(filter, {
                page, limit, sort: { createdAt: -1 },
                customLabels: {
                    totalDocs: 'itemsCount', docs: 'data', limit: 'perPage',
                    page: 'currentPage', nextPage: 'next', prevPage: 'prev',
                    totalPages: 'pageCount', pagingCounter: 'serialNumber', meta: 'paginator',
                },
            });
            return this.sendSuccess(res, result);
        } catch (error) {
            return next(error);
        }
    }

    private async acknowledgeAlert(req: Request, res: Response, next: NextFunction) {
        try {
            const adminUser = res.locals.user;
            const updated = await LedgerAlert.findByIdAndUpdate(
                req.params.id,
                { acknowledgedAt: new Date(), acknowledgedBy: adminUser?._id },
                { new: true }
            );
            if (!updated) throw errorResponseMessage.resourceNotFound('Alert');
            return this.sendSuccess(res, { alert: updated });
        } catch (error) {
            return next(error);
        }
    }
}

export default new AdminReconciliationController().router;
