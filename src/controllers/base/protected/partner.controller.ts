import BaseController from "../base-controller";
import PartnerService from "../../../services/partner.service";
import {Request, Response, NextFunction} from "express";
import {IPartner} from "../../../models/interface";
import errorResponseMessage from "../../../common/messages/error-response-message";
import {MulterMiddleware} from "../../../middlewares/multer.middleware";
import {validateCreatePartner, validateUpdatePartner} from "../../../validators/z-partners";
import {ROLE_MAP} from "../../../common/constant";

/**
 * Controller handling marketplace related operations
 * @class PartnerController
 * @extends BaseController
 */
class PartnerController extends BaseController {
    private partnerService: PartnerService;

    constructor() {
        super();
        this.partnerService = new PartnerService();
        this.setupRoutes();
    }


    /**
     * Sets up routes for partner related operations
     * @protected
     */
    protected setupRoutes(): void {
        this.router.get("/", this.getPartners.bind(this));
        this.router.post("/", MulterMiddleware.single('profileImage'), MulterMiddleware.handleError, validateCreatePartner, this.createPartner.bind(this));
        this.router.patch("/:id", MulterMiddleware.single('profileImage'), MulterMiddleware.handleError, validateUpdatePartner, this.updatePartner.bind(this));
        this.router.patch("/update-status/:id", this.updatePartner.bind(this));
    }

    /**
     * Retrieves all partners and might take in queries
     * @private
     */
    private async getPartners(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const { page, limit, searchTerm, ...otherQueries } = req.query;
            const user = res.locals;

            if (otherQueries.status && user?.role === ROLE_MAP.USER) {
                otherQueries.status = 'active';
            }

            let partners;

            if (searchTerm) {
                partners = await this.partnerService.searchPartners(
                    searchTerm.toString(),
                    otherQueries,
                    {
                        page: parseInt(page as string) || 1,
                        limit: parseInt(limit as string) || 10,
                        useTextSearch: false
                    }
                );
            } else {
                partners = await this.partnerService.paginate(otherQueries, {
                    page: parseInt(page as string) || 1,
                    limit: parseInt(limit as string) || 10,
                    sort: { createdAt: -1 }
                });
            }

            return this.sendSuccess(res, partners)

        } catch (error) {
            return next(error);
        }
    }

    /**
     * Creates a new partner
     * @private
     */
    private async createPartner(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const partnerData: Partial<IPartner> = req.body;

            if(!req.file) {
                 next(errorResponseMessage.payloadIncorrect("Profile Image is required"));
                 return;
            }

            const partner = await this.partnerService.createPartnerWithProfileImage(partnerData, req.file as Express.Multer.File);

            // const partner = req.body;

            return this.sendSuccess(res, {
                partner,
                message: 'Partner created successfully'
            })
        } catch (error) {
            return next(error)
        }
    }

    /**
     * Updates an existing partner or partner status
     * @private
     */
    private async updatePartner(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const partner = await this.partnerService.updatePartnerWithProfileImage(req.params.id, req.body, req.file as Express.Multer.File);
            if (!partner) {
                next(errorResponseMessage.resourceNotFound("Partner not found"));
                return;
            }
            return this.sendSuccess(res, {
                partner,
                message: 'Partner updated successfully'
            })
        } catch (error) {
            next(error)
        }
    }
}

export default new PartnerController().router;