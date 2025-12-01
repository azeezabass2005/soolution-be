import {Router} from "express";
import authController from "../../controllers/base/public/auth.controller";
import postController from "../../controllers/base/public/post.controller"
import tagController from "../../controllers/base/public/tag.controller";
import exchangeRateController from "../../controllers/base/public/exchange-rate.controller";
import webhookController from "../../controllers/base/public/webhook.controller";

const path = "/public";

const publicRouter = Router()

publicRouter.use(`${path}/auth`, authController)

publicRouter.use(`${path}/posts`, postController)

publicRouter.use(`${path}/tags`, tagController)

publicRouter.use(`${path}/exchange-rates`, exchangeRateController);

publicRouter.use(`${path}/webhook`, webhookController);


export default publicRouter