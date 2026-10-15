import { NextFunction, Request, Response } from "express";
import BaseController from "../base-controller";
import { MulterMiddleware } from "../../../middlewares/multer.middleware";
import beneficiaryService from "../../../services/beneficiary.service";

/**
 * The calling user's saved recipients. Send forms pick one instead of
 * re-entering bank, mobile money or Alipay details every time.
 */
class BeneficiaryController extends BaseController {
    constructor() {
        super();
    }

    protected setupRoutes(): void {
        this.router.get("/", this.list.bind(this));
        this.router.post("/", MulterMiddleware.receipt("qrCode"), MulterMiddleware.handleError, this.create.bind(this));
        this.router.post("/:id/used", this.markUsed.bind(this));
        this.router.delete("/:id", this.remove.bind(this));
    }

    private async list(req: Request, res: Response, next: NextFunction) {
        try {
            const currency = typeof req.query.currency === "string" ? req.query.currency : undefined;
            const beneficiaries = await beneficiaryService.list(res.locals.userId, currency);
            this.sendSuccess(res, { beneficiaries });
        } catch (error) {
            next(error);
        }
    }

    private async create(req: Request, res: Response, next: NextFunction) {
        try {
            const beneficiary = await beneficiaryService.create(res.locals.userId, req.body, req.file);
            this.sendSuccess(res, { beneficiary, message: "Beneficiary saved" }, 201);
        } catch (error) {
            next(error);
        }
    }

    /** Called after a send so recent beneficiaries list first */
    private async markUsed(req: Request, res: Response, next: NextFunction) {
        try {
            const beneficiary = await beneficiaryService.getOwned(res.locals.userId, req.params.id);
            await beneficiaryService.markUsed(String(beneficiary._id));
            this.sendSuccess(res, { message: "Updated" });
        } catch (error) {
            next(error);
        }
    }

    private async remove(req: Request, res: Response, next: NextFunction) {
        try {
            await beneficiaryService.remove(res.locals.userId, req.params.id);
            this.sendSuccess(res, { message: "Beneficiary removed" });
        } catch (error) {
            next(error);
        }
    }
}

export default new BeneficiaryController().router;
