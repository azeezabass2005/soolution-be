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
        // User-specific routes (authenticated users managing their own saved accounts)
        this.router.get("/user", this.getUserAccounts.bind(this));
        this.router.post("/user", this.createUserAccount.bind(this));
        this.router.patch("/user/:id", this.updateUserAccount.bind(this));
        this.router.delete("/user/:id", this.deleteUserAccount.bind(this));

        // Admin-only routes (company/platform bank accounts)
        this.router.get("/", RoleMiddleware.isAdmin, this.getAllAccountDetails.bind(this));
        this.router.post("/", RoleMiddleware.isAdmin, this.createAccountDetails.bind(this));
        this.router.patch("/:id", RoleMiddleware.isAdmin, this.updateAccountDetails.bind(this));
        this.router.patch("/:id/make-default", RoleMiddleware.isAdmin, this.makeDefaultAccount.bind(this));
        this.router.delete("/:id", RoleMiddleware.isAdmin, this.deleteAccountDetails.bind(this));
    }

    /**
     * Get the calling user's saved payment accounts
     */
    private async getUserAccounts(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const userId = res.locals.userId;
            const accounts = await this.bankAccountDetailsService.getUserAccountDetails(userId);
            this.sendSuccess(res, { accounts });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Create a saved payment account for the calling user
     */
    private async createUserAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const userId = res.locals.userId;
            const account = await this.bankAccountDetailsService.createUserAccountDetails(userId, req.body);
            this.sendSuccess(res, { account });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Update a saved payment account for the calling user
     */
    private async updateUserAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const userId = res.locals.userId;
            const account = await this.bankAccountDetailsService.updateUserAccountDetails(userId, req.params.id, req.body);
            this.sendSuccess(res, { account });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Delete a saved payment account for the calling user
     */
    private async deleteUserAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const userId = res.locals.userId;
            await this.bankAccountDetailsService.deleteUserAccountDetails(userId, req.params.id);
            this.sendSuccess(res, { message: "Account deleted" });
        } catch (error) {
            next(error);
        }
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