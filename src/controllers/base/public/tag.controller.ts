/**
 * Controller handling tag-related operations
 * @class TagController
 * @extends BaseController
 */ import TagService from "../../../services/tag.service";
import BaseController from "../base-controller";
import {validateTagCreate} from "../../../validators";
import {Request, Response, NextFunction} from "express";
import {ITag} from "../../../models/interface";

class TagController extends BaseController {
    private tagService: TagService;

    /**
     * Creates an instance of the TagController
     */
    constructor() {
        super();
        this.tagService = new TagService();
        this.setupRoutes();
    }

    /**
     * Sets up routes for tag operations
     * @protected
     */
    protected setupRoutes(): void {
        // Create tag route
        this.router.post("/", validateTagCreate, this.createTag.bind(this));

        // Gets tag route
        this.router.get("/", this.getTags.bind(this));
    }

    /**
     * Creates a new tag
     * @private
     */
    private async createTag(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const tagData: Partial<ITag> = req.body;
            console.log(tagData);
            const tag = await this.tagService.save({
                ...tagData,
            });
            if(!tag) {
                throw new Error("Failed to create tag");
            }

            this.sendSuccess(res, {
                tag: tag,
            });
        } catch (error) {
            next(error);
        }
    }

    /**
     * Retrieves all posts based on query parameters
     * @private
     */
    private async getTags(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const tags = await this.tagService.find();
            this.sendSuccess(res, {tags})
        } catch (error) {
            next(error);
        }
    }
}

export default new TagController().router;