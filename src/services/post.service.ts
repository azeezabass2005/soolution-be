import postRepository, { type PostFilter, type PostUpdate, type PostWithUser, type RelatedPost } from "../repositories/post.repository";
import type { PageRequest, Paginated } from "../db/pagination";
import type { PublicationStatus } from "../types/enums";
import { PUBLICATION_STATUS } from "../common/constant";
import errorResponseMessage from "../common/messages/error-response-message";

const PUBLICATION_STATUSES = Object.values(PUBLICATION_STATUS) as string[];

class PostService {
    /** Newest first, with the author */
    async list(filter: PostFilter, page: PageRequest): Promise<Paginated<PostWithUser>> {
        return postRepository.paginate(filter, page);
    }

    async findById(postId: string): Promise<PostWithUser | undefined> {
        return postRepository.findById(postId);
    }

    /** Only these fields can be edited (never the author or counters) */
    async update(postId: string, body: Record<string, unknown>) {
        const patch: PostUpdate = {};
        if (typeof body.title === "string") patch.title = body.title;
        if (typeof body.content === "string") patch.content = body.content;
        if (typeof body.category === "string") patch.category = body.category;
        if (Array.isArray(body.tags) && body.tags.every((tag) => typeof tag === "string")) patch.tags = body.tags as string[];
        if (typeof body.publicationStatus === "string") {
            if (!PUBLICATION_STATUSES.includes(body.publicationStatus)) {
                throw errorResponseMessage.payloadIncorrect(`publicationStatus must be one of ${PUBLICATION_STATUSES.join(", ")}`);
            }
            patch.publicationStatus = body.publicationStatus as PublicationStatus;
        }
        return postRepository.update(postId, patch);
    }

    /**
     * Posts related to a given post, ranked by shared category and tags, text
     * similarity, engagement and recency.
     */
    public async getRelatedPosts(
        postId: string,
        options: {
            limit?: number;
            includeSameUser?: boolean;
            categoryWeight?: number;
            tagWeight?: number;
            textSimilarityWeight?: number;
            engagementWeight?: number;
            timeDecayWeight?: number;
        } = {}
    ): Promise<RelatedPost[]> {
        const {
            limit = 5,
            includeSameUser = false,
            categoryWeight = 3, // Category matching is important
            tagWeight = 2, // Tag matching is also significant
            textSimilarityWeight = 1.5, // Text similarity adds relevance
            engagementWeight = 1, // Engagement provides social proof
            timeDecayWeight = 0.5, // Time decay slightly influences ranking
        } = options;

        const originalPost = await postRepository.findById(postId);
        if (!originalPost) {
            throw errorResponseMessage.resourceNotFound("Post");
        }

        const author = typeof originalPost.user === "string" ? originalPost.user : originalPost.user.id;
        return postRepository.findRelated(
            { ...originalPost, user: author },
            {
                limit,
                includeSameUser,
                weights: { category: categoryWeight, tag: tagWeight, text: textSimilarityWeight, engagement: engagementWeight, timeDecay: timeDecayWeight },
            }
        );
    }

    /** Increment view count for a post */
    public async incrementViewCount(postId: string): Promise<void> {
        await postRepository.incrementCounter(postId, "viewCount", 1);
    }

    /** Like (or unlike) a post */
    public async updateLikeCount(postId: string, likeUpdateType = "increment"): Promise<void> {
        await postRepository.incrementCounter(postId, "likeCount", likeUpdateType === "decrement" ? -1 : 1);
    }
}

export default PostService;
