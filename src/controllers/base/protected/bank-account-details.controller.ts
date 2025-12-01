import BaseController from "../base-controller";
import BankAccountDetailsService from "../../../services/bank-account-details.service";
import { Request, Response, NextFunction } from "express";
import RoleMiddleware from "../../../middlewares/role.middleware";

class BankAccountDetailsController extends BaseController {

    bankAccountDetailsService: BankAccountDetailsService;

    constructor() {
        super()
        this.bankAccountDetailsService = new BankAccountDetailsService();
    }

    protected setupRoutes(): void {
        // All routes are admin-only
        this.router.get("/", RoleMiddleware.isAdmin, this.getAllAccountDetails.bind(this));
        this.router.post("/", RoleMiddleware.isAdmin, this.createAccountDetails.bind(this));
        this.router.patch("/:id", RoleMiddleware.isAdmin, this.updateAccountDetails.bind(this));
        this.router.patch("/:id/make-default", RoleMiddleware.isAdmin, this.makeDefaultAccount.bind(this));
        this.router.delete("/:id", RoleMiddleware.isAdmin, this.deleteAccountDetails.bind(this));
    }

    /**
     * Get all account details
     */
    private async getAllAccountDetails(req: Request, res: Response, next: NextFunction): Promise<void> {
        const accountDetails = await this.bankAccountDetailsService.getAccountDetails();
        this.sendSuccess(res, {accountDetails})
    }

    /**
     * Method to create an account details
     */
    private async createAccountDetails(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const accountDetails = await this.bankAccountDetailsService.createAccountDetails(req.body);
            return this.sendSuccess(res, {
                message: "Account details created",
                accountDetails: accountDetails,
            });
        } catch (error: any) {
            return next(error);
        }
    }

    /**
     * Method to update account details
     */
    private async updateAccountDetails(req: Request, res: Response, next: NextFunction): Promise<void> {
        const accountDetails = await this.bankAccountDetailsService.updateAccountDetails(req.params.id!, req.body!);
        return this.sendSuccess(res, {
            message: "Account details updated",
            accountDetails: accountDetails,
        })
    }

    /**
     * Make an account details default
     */
    private async makeDefaultAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
        const accountDetails = await this.bankAccountDetailsService.makeDefaultAccountDetails(req.params.id);
        return this.sendSuccess(res, {
            message: "Account details updated",
            accountDetails: accountDetails,
        })
    }

    /**
     * Delete account details
     */
    private async deleteAccountDetails(req: Request, res: Response, next: NextFunction): Promise<void> {
        const accountDetails = await this.bankAccountDetailsService.deleteAccountDetails(req.params.id);
        return this.sendSuccess(res, {
            message: "Account details deleted",
            accountDetails: accountDetails,
        })
    }
}

export default new BankAccountDetailsController().router;