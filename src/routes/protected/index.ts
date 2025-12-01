import { Router, Request, Response, NextFunction } from "express";
import authMiddleware from "../../middlewares/auth.middleware";
import exchangeRateController from "../../controllers/base/protected/exchange-rate-controller";
import logsController from "../../controllers/base/protected/logs.controller";
import userController from "../../controllers/base/protected/user.controller";
import partnerController from "../../controllers/base/protected/partner.controller";
import transactionController from "../../controllers/base/protected/transaction.controller";
import bankAccountDetailsController from "../../controllers/base/protected/bank-account-details.controller";
import verificationController from "../../controllers/base/protected/verification.controller";
import dashboardController from "../../controllers/base/protected/dashboard.controller";

const path = "/protected";
const protectedRouter = Router();

protectedRouter.use(path, async (req: Request, res: Response, next: NextFunction) => {
    try {
        await authMiddleware.validateAuthorization(req, res, next);
        // next()
    } catch (error) {
        next(error);
    }
});

protectedRouter.use(`${path}/exchange-rates`, exchangeRateController);
protectedRouter.use(`${path}/logs`, logsController);
protectedRouter.use(`${path}/users`, userController);
protectedRouter.use(`${path}/partners`, partnerController);
protectedRouter.use(`${path}/transactions`, transactionController);
protectedRouter.use(`${path}/bank-account-details`, bankAccountDetailsController);
protectedRouter.use(`${path}/verify`, verificationController);
protectedRouter.use(`${path}/dashboard`, dashboardController);

export default protectedRouter;