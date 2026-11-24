import {Router} from "express";
import authController from "../../controllers/base/public/auth.controller";
import postController from "../../controllers/base/public/post.controller"
import tagController from "../../controllers/base/public/tag.controller";
import exchangeRateController from "../../controllers/base/public/exchange-rate.controller";
import webhookController from "../../controllers/base/public/webhook.controller";
import receiptController from "../../controllers/base/public/receipt.controller";
import payController from "../../controllers/base/public/pay.controller";
import statusController from "../../controllers/base/public/status.controller";
import publicAdminInviteController from "../../controllers/base/public/admin-invite.controller";

const path = "/public";

const publicRouter = Router()

publicRouter.use(`${path}/auth`, authController)

publicRouter.use(`${path}/posts`, postController)

publicRouter.use(`${path}/tags`, tagController)

publicRouter.use(`${path}/exchange-rates`, exchangeRateController);

publicRouter.use(`${path}/webhook`, webhookController);

publicRouter.use(`${path}/receipts`, receiptController);

publicRouter.use(`${path}/pay`, payController);

publicRouter.use(`${path}/admin-invites`, publicAdminInviteController);

publicRouter.use(`${path}/status`, statusController);


export default publicRouter