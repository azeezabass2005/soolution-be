import { NextFunction, Request, Response } from "express";
import BaseController from "../base-controller";
import paymentLinkService from "../../../services/payment-link.service";

/**
 * The calling user's payment links. A link lets someone pay them without an
 * account: the payer opens it and fills in the details the user would
 * otherwise enter in the receive form.
 */
class PaymentLinkController extends BaseController {
    constructor() {
        super();
    }

    protected setupRoutes(): void {
        this.router.get("/", this.list.bind(this));
        this.router.post("/", this.create.bind(this));
        this.router.patch("/:id", this.update.bind(this));
    }

    private async list(_req: Request, res: Response, next: NextFunction) {
        try {
            const links = await paymentLinkService.list(res.locals.userId);
            this.sendSuccess(res, { links });
        } catch (error) {
            next(error);
        }
    }

    private async create(req: Request, res: Response, next: NextFunction) {
        try {
            const link = await paymentLinkService.create(res.locals.userId, req.body);
            this.sendSuccess(res, { link, message: "Payment link created" }, 201);
        } catch (error) {
            next(error);
        }
    }

    /** Turn a link off (or back on) */
    private async update(req: Request, res: Response, next: NextFunction) {
        try {
            const link = await paymentLinkService.update(res.locals.userId, req.params.id, req.body);
            this.sendSuccess(res, { link, message: link.active ? "Link turned on" : "Link turned off" });
        } catch (error) {
            next(error);
        }
    }
}

export default new PaymentLinkController().router;
