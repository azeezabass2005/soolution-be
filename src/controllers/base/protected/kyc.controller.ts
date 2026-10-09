import { Request, Response, NextFunction } from "express";
import BaseController from "../base-controller";
import KycApplicationService from "../../../services/kyc-application.service";
import kycLimitService from "../../../services/kyc-limit.service";
import { MulterMiddleware } from "../../../middlewares/multer.middleware";
import errorResponseMessage, { ErrorSeverity } from "../../../common/messages/error-response-message";
import { ROLE_MAP } from "../../../common/constant";
import { KYC_STEP, KycStep } from "../../../common/kyc.constants";
import { ZKycReview, ZKycStart } from "../../../validators/z-kyc";
import zodErrorHandler from "../../../validators/zod.error";

/**
 * KYC (individual) / KYB (business) applications.
 * `/me` routes are for the applicant; the rest are admin-only.
 */
class KycController extends BaseController {

    private kycService: KycApplicationService;

    constructor() {
        super();
        this.kycService = new KycApplicationService();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        if (!this.kycService) return;

        // Applicant routes
        this.router.get("/me", this.getMyApplication.bind(this));
        this.router.post("/me", this.startApplication.bind(this));
        this.router.patch("/me/steps/:step", this.saveStep.bind(this));
        this.router.post("/me/documents/:slot", MulterMiddleware.single("file"), MulterMiddleware.handleError, this.uploadDocument.bind(this));
        this.router.delete("/me/documents/:slot", this.removeDocument.bind(this));
        this.router.post("/me/submit", this.submit.bind(this));
        // Whether an amount needs KYC for the signed-in user (send/receive forms pre-check)
        this.router.get("/limit", this.checkLimit.bind(this));

        // Admin routes
        this.router.get("/", this.requireAdmin, this.listApplications.bind(this));
        this.router.get("/:id", this.requireAdmin, this.getApplication.bind(this));
        this.router.patch("/:id/status", this.requireAdmin, this.reviewApplication.bind(this));
    }

    private requireAdmin(_req: Request, res: Response, next: NextFunction): void {
        if (res.locals.user?.role !== ROLE_MAP.ADMIN) {
            return next(errorResponseMessage.createError(403, "You don't have permission to perform this action", ErrorSeverity.HIGH));
        }
        next();
    }

    private async getMyApplication(_req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const application = await this.kycService.findOne({ user: res.locals.userId });
            this.sendSuccess(res, { application: application ? await this.kycService.toClient(application) : null });
        } catch (error) {
            next(error);
        }
    }

    private async startApplication(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { type } = ZKycStart.parse(req.body);
            const application = await this.kycService.start(res.locals.userId, type);
            this.sendSuccess(res, { application: await this.kycService.toClient(application) }, 201);
        } catch (error) {
            zodErrorHandlerOr(error, next);
        }
    }

    private async saveStep(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const step = req.params.step as KycStep;
            if (!Object.values(KYC_STEP).includes(step)) {
                return next(errorResponseMessage.resourceNotFound("Step"));
            }
            const application = await this.kycService.saveStep(res.locals.userId, step, req.body?.data, req.body?.complete === true);
            this.sendSuccess(res, {
                message: req.body?.complete ? "Saved" : "Progress saved",
                application: await this.kycService.toClient(application),
            });
        } catch (error) {
            next(error);
        }
    }

    private async uploadDocument(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const application = await this.kycService.uploadDocument(res.locals.userId, req.params.slot, req.file, req.body?.issueDate);
            this.sendSuccess(res, {
                message: "Document uploaded",
                application: await this.kycService.toClient(application),
            });
        } catch (error) {
            next(error);
        }
    }

    private async removeDocument(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const application = await this.kycService.removeDocument(res.locals.userId, req.params.slot);
            this.sendSuccess(res, {
                message: "Document removed",
                application: await this.kycService.toClient(application),
            });
        } catch (error) {
            next(error);
        }
    }

    private async submit(_req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const application = await this.kycService.submit(res.locals.user);
            this.sendSuccess(res, {
                message: "Application submitted successfully",
                application: await this.kycService.toClient(application),
            });
        } catch (error) {
            next(error);
        }
    }

    private async checkLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const amount = Number(req.query.amount);
            const currency = typeof req.query.currency === "string" ? req.query.currency : "";
            if (!isFinite(amount) || amount <= 0 || !/^[A-Za-z]{3,4}$/.test(currency)) {
                return next(errorResponseMessage.payloadIncorrect("A positive amount and a currency code are required"));
            }
            // Optional second side of the transaction (e.g. the RMB amount alongside its NGN cost)
            const altAmount = Number(req.query.altAmount);
            const altCurrency = typeof req.query.altCurrency === "string" ? req.query.altCurrency : "";
            const amounts = [{ amount, currency }];
            if (isFinite(altAmount) && altAmount > 0 && /^[A-Za-z]{3,4}$/.test(altCurrency)) amounts.push({ amount: altAmount, currency: altCurrency });
            this.sendSuccess(res, await kycLimitService.check(res.locals.userId, amounts));
        } catch (error) {
            next(error);
        }
    }

    private async listApplications(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { status, type, search, page, limit } = req.query;
            const result = await this.kycService.adminList({
                status: status as string | undefined,
                type: type as string | undefined,
                search: search as string | undefined,
                page: page ? parseInt(page as string, 10) || 1 : 1,
                limit: limit ? parseInt(limit as string, 10) || 20 : 20,
            });
            this.sendSuccess(res, result);
        } catch (error) {
            next(error);
        }
    }

    private async getApplication(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            this.sendSuccess(res, { application: await this.kycService.adminGet(req.params.id) });
        } catch (error) {
            next(error);
        }
    }

    private async reviewApplication(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { status, note } = ZKycReview.parse(req.body);
            const application = await this.kycService.adminReview(res.locals.user, req.params.id, status, note);
            this.sendSuccess(res, { message: `Application marked as ${status.replace("_", " ")}`, application });
        } catch (error) {
            zodErrorHandlerOr(error, next);
        }
    }
}

/** Zod errors become 400s; everything else (including thrown ErrorResponses) passes through */
const zodErrorHandlerOr = (error: unknown, next: NextFunction) => {
    if (error && typeof error === "object" && "issues" in error) return zodErrorHandler(error, next);
    next(error);
};

export default new KycController().router;
