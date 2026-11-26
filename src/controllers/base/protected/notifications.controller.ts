import { Request, Response, NextFunction } from "express";
import BaseController from "../base-controller";
import inboxService from "../../../services/inbox.service";
import attentionService from "../../../services/attention.service";
import { accessOf } from "../../../middlewares/role.middleware";
import { ROLE_MAP } from "../../../common/constant";

/**
 * The signed-in person's in-app notifications (mounted at /protected/notifications):
 *   GET  /            newest first (?limit, ?before=<id>), with the unread count
 *   GET  /summary     unread count, and for admins what needs their attention
 *   POST /read        { ids: [...] } or { all: true }
 */
class NotificationsController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.get("/", this.list.bind(this));
        this.router.get("/summary", this.summary.bind(this));
        this.router.post("/read", this.read.bind(this));
        // Clear one notification, or all of them ({ all: true })
        this.router.post("/clear", this.clear.bind(this));
    }

    private async list(req: Request, res: Response, next: NextFunction) {
        try {
            this.sendSuccess(res, await inboxService.list(res.locals.user.id, {
                limit: req.query.limit ? Number(req.query.limit) : undefined,
                before: typeof req.query.before === "string" ? req.query.before : undefined,
            }));
        } catch (error) {
            next(error);
        }
    }

    private async summary(_req: Request, res: Response, next: NextFunction) {
        try {
            const user = res.locals.user;
            const unread = await inboxService.unreadCount(user.id);
            const attention = user.role === ROLE_MAP.ADMIN ? await attentionService.forAdmin(await accessOf(res)) : {};
            this.sendSuccess(res, { unread, attention });
        } catch (error) {
            next(error);
        }
    }

    private async clear(req: Request, res: Response, next: NextFunction) {
        try {
            const ids = req.body?.all ? "all" : Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 200) : [];
            this.sendSuccess(res, await inboxService.clear(res.locals.user.id, ids));
        } catch (error) {
            next(error);
        }
    }

    private async read(req: Request, res: Response, next: NextFunction) {
        try {
            const ids = req.body?.all ? "all" : Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 200) : [];
            this.sendSuccess(res, await inboxService.markRead(res.locals.user.id, ids));
        } catch (error) {
            next(error);
        }
    }
}

export default new NotificationsController().router;
