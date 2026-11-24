import { Request, Response, NextFunction } from "express";
import BaseController from "../../base-controller";
import RoleMiddleware from "../../../../middlewares/role.middleware";
import adminAccessService from "../../../../services/admin-access.service";

/**
 * Roles & staff (super admins only), mounted at /protected/admin/team:
 *   GET    /permissions           what roles can include
 *   GET    /roles                 roles with member counts
 *   POST   /roles                 create { name, description?, permissions[] }
 *   PUT    /roles/:id             update
 *   DELETE /roles/:id             delete (refused while anyone has it)
 *   GET    /staff                 everyone on the team
 *   POST   /staff                 add an existing account { email, role: "super_admin" | roleId }
 *   PATCH  /staff/:userId         change their role { role }
 *   DELETE /staff/:userId         take them off the team
 *   GET    /invites               open invitations
 *   POST   /invites               invite by email { email, role }
 *   DELETE /invites/:id           revoke
 */
class AdminTeamController extends BaseController {
    constructor() {
        super();
        this.setupRoutes();
    }

    protected setupRoutes(): void {
        this.router.use(RoleMiddleware.isAdmin);
        this.router.get("/permissions", this.handle(() => adminAccessService.permissionCatalog()));
        this.router.get("/roles", this.handle(() => adminAccessService.listRoles()));
        this.router.post("/roles", this.handle((req, res) => adminAccessService.createRole(req.body, res.locals.user.id), 201));
        this.router.put("/roles/:id", this.handle((req, res) => adminAccessService.updateRole(req.params.id, req.body, res.locals.user.id)));
        this.router.delete("/roles/:id", this.handle((req, res) => adminAccessService.deleteRole(req.params.id, res.locals.user.id)));
        this.router.get("/staff", this.handle(() => adminAccessService.listStaff()));
        this.router.post("/staff", this.handle((req, res) => adminAccessService.assign(req.body, res.locals.user.id)));
        this.router.patch("/staff/:userId", this.handle((req, res) => adminAccessService.changeRole(req.params.userId, req.body, res.locals.user.id)));
        this.router.delete("/staff/:userId", this.handle((req, res) => adminAccessService.removeFromTeam(req.params.userId, res.locals.user.id)));
        this.router.get("/invites", this.handle(() => adminAccessService.listInvites()));
        this.router.post("/invites", this.handle((req, res) => adminAccessService.invite(req.body, res.locals.user.id), 201));
        this.router.delete("/invites/:id", this.handle((req, res) => adminAccessService.revokeInvite(req.params.id, res.locals.user.id)));
    }

    private handle(fn: (req: Request, res: Response) => Promise<unknown> | unknown, status = 200) {
        return async (req: Request, res: Response, next: NextFunction) => {
            try {
                this.sendSuccess(res, await fn(req, res), status);
            } catch (error) {
                next(error);
            }
        };
    }
}

export default new AdminTeamController().router;
