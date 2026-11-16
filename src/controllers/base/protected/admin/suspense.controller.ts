import { Request, Response, NextFunction } from 'express';
import BaseController from '../../base-controller';
import RoleMiddleware from '../../../../middlewares/role.middleware';
import ledgerService from '../../../../services/ledger.service';
import errorResponseMessage from '../../../../common/messages/error-response-message';

/**
 * Lists every unattributed credit on SUSPENSE_NGN and lets an admin manually
 * attribute it to a user. Attribution posts a balancing journal entry that
 * moves the funds from SUSPENSE_NGN into the user's wallet liability.
 */
class AdminSuspenseController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.use(RoleMiddleware.isAdmin);

        this.router.get('/', this.list.bind(this));
        this.router.post('/:journalEntryId/attribute', this.attribute.bind(this));
    }

    /**
     * Open suspense entries: credits to SUSPENSE_NGN that have not yet been
     * reversed by an attribution posting.
     */
    private async list(req: Request, res: Response, next: NextFunction) {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const limit = parseInt(req.query.limit as string) || 25;
            const result = await ledgerService.listOpenSuspense({ page, limit });
            return this.sendSuccess(res, result);
        } catch (error) {
            return next(error);
        }
    }

    /** Attribute a suspense credit to a user (see LedgerService.attributeSuspense) */
    private async attribute(req: Request, res: Response, next: NextFunction) {
        try {
            const { userId, note } = req.body || {};
            if (!userId) {
                return next(errorResponseMessage.payloadIncorrect('userId is required'));
            }
            const result = await ledgerService.attributeSuspense({
                journalEntryId: req.params.journalEntryId,
                userId: String(userId),
                note: typeof note === 'string' ? note : undefined,
                adminId: res.locals.user?.id,
            });
            return this.sendSuccess(res, result);
        } catch (error) {
            return next(error);
        }
    }
}

export default new AdminSuspenseController().router;
