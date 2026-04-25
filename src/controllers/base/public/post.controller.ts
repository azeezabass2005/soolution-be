import {Request, Response, NextFunction} from "express";
import BaseController from "../../base/base-controller";
import PostService from "../../../services/post.service";
import errorResponseMessage from "../../../common/messages/error-response-message";
import {IPost} from "../../../models/interface";
import {validatePostCreate} from "../../../validators";

/**
 * Controller handling post-related operations
 * @class PostController
 * @extends BaseController
 */
class PostController extends BaseController {
    private postService: PostService;

    /**
     * Creates an instance of PostController
     */
    constructor() {
        super();
        this.postService = new PostService();
        this.setupRoutes();
    }

    /**
     * Sets up routes for post operations
     * @protected
     */
    protected setupRoutes(): void {
        // Get posts route
        this.router.get("/", this.getPosts.bind(this));

        // Get single post route
        this.router.get("/:id", this.getPostById.bind(this));

        // Update post route
        this.router.patch("/:id", this.updatePost.bind(this));
    }

    /**
     * Retrieves all posts based on query parameters
     * @private
     */
    private async getPosts(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const limit = parseInt(req.query.limit as string) || 10;

            // Build the filter from a strict whitelist — never pass req.query as the Mongo filter
            // (Express parses ?foo[$ne]=x into operator objects and would inject into the query).
            const { category, publicationStatus, user, tag } = req.query;
            const filter: Record<string, unknown> = {};
            if (typeof category === 'string' && category) filter.category = category;
            if (typeof publicationStatus === 'string' && publicationStatus) filter.publicationStatus = publicationStatus;
            if (typeof user === 'string' && user) filter.user = user;
            if (typeof tag === 'string' && tag) filter.tags = tag;

            const posts = await this.postService.paginate(filter, {
                page,
                limit,
                sort: {createdAt: -1},
                populate: ['user']
            });

            this.sendSuccess(res, {posts});
        } catch (error) {
            next(error);
        }
    }

    /**
     * Retrieves a single post by ID
     * @private
     */
    private async getPostById(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const post = await this.postService.findById(req.params.id, {
                populate: ['user']
            });

            if (!post) {
                throw errorResponseMessage.resourceNotFound('Post');
            }

            const relatedPosts = await this.postService.getRelatedPosts(req.params.id, {
                limit: 5,
                includeSameUser: false
            });
            this.sendSuccess(res, {post, relatedPosts});
        } catch (error) {
            next(error);
        }
    }

    /**
     * Updates a post by ID
     * @private
     */
    private async updatePost(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const post = await this.postService.updateById(req.params.id, req.body);

            if (!post) {
                throw errorResponseMessage.resourceNotFound('Post');
            }

            this.sendSuccess(res, {post});
        } catch (error) {
            next(error);
        }
    }
}

// Export an instance of the controller's router
export default new PostController().router;