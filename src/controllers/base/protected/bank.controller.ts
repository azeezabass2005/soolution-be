import { NextFunction, Request, Response } from "express";
import BaseController from "../base-controller";
import bankDirectoryService from "../../../services/bank-directory.service";

/** Banks to pick from, per currency, and account-name lookups */
class BankController extends BaseController {
    constructor() {
        super();
    }

    protected setupRoutes(): void {
        this.router.get("/", this.list.bind(this));
        this.router.post("/resolve", this.resolve.bind(this));
    }

    private async list(req: Request, res: Response, next: NextFunction) {
        try {
            const directory = await bankDirectoryService.list(String(req.query.currency || "NGN"));
            this.sendSuccess(res, directory);
        } catch (error) {
            next(error);
        }
    }

    private async resolve(req: Request, res: Response, next: NextFunction) {
        try {
            const { currency, bankCode, accountNumber } = req.body || {};
            const account = await bankDirectoryService.resolve(String(currency || ""), String(bankCode || ""), String(accountNumber || ""));
            this.sendSuccess(res, { account });
        } catch (error) {
            next(error);
        }
    }
}

export default new BankController().router;
