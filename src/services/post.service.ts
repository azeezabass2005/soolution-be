import DBService from '../utils/db.utils';
import {IPost} from '../models/interface';
import Post from "../models/post.model";
import {HydratedDocument, PipelineStage} from "mongoose";
import errorResponseMessage from "../common/messages/error-response-message";

/**
 * Service class for User-related database operations
 *
 * @description Extends the generic DBService with User-specific configurations
 * @extends {DBService<IPost>}
 */
class PostService extends DBService<IPost> {
    /**
     * Creates an instance of PostService
     *
     * @constructor
     * @param {string[]} [populatedFields=[]] - Optional fields to populate during queries
     */
    constructor(populatedFields: string[] = []) {
        // Initialize the service with User model and optional population fields
        super(Post, populatedFields);
    }

    /**
     * Calculate time decay score based on post age
     * Newer posts get higher scores
     */
    private getTimeDecayExpression() {
        const DAY_IN_MS = 24 * 60 * 60 * 1000;
        return {
            $divide: [
                1,
                {
                    $add: [
                        1,
                        {
                            $divide: [
                                {$subtract: [new Date(), "$publishedAt"]},
                                DAY_IN_MS
                            ]
                        }
                    ]
                }
            ]
        };
    }

    /**
     * Find posts related to a given post based on tags and other criteria
     *
     * @param {string} postId - ID of the post to find related content for
     * @param {Object} options - Options for customizing related posts query
     * @param {number} options.limit - Maximum number of related posts to return
     * @param {boolean} options.includeSameUser - Whether to include posts from the same user
     * @returns {Promise<HydratedDocument<IPost>[]>} Array of related posts
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
    ): Promise<HydratedDocument<IPost>[]> {
        const {
            limit = 5,
            includeSameUser = false,
            categoryWeight = 3,    // Category matching is important
            tagWeight = 2,         // Tag matching is also significant
            textSimilarityWeight = 1.5,  // Text similarity adds relevance
            engagementWeight = 1,   // Engagement provides social proof
            timeDecayWeight = 0.5   // Time decay slightly influences ranking
        } = options;

        const originalPost = await this.findById(postId, {
            populate: ['user']
        });

        if (!originalPost) {
            throw errorResponseMessage.resourceNotFound('Post');
        }

        const pipeline: PipelineStage[] = [
            {
                $match: {
                    _id: {$ne: originalPost._id},
                    ...((!includeSameUser && originalPost.user) ?
                        {user: {$ne: originalPost.user}} : {}),
                }
            },

            {
                $addFields: {
                    categoryScore: {
                        $cond: {
                            if: {$eq: ["$category", originalPost.category]},
                            then: categoryWeight,
                            else: 0
                        }
                    },

                    tagScore: {
                        $multiply: [
                            {
                                $size: {
                                    $setIntersection: ["$tags", originalPost.tags || []]
                                }
                            },
                            tagWeight
                        ]
                    },

                    // Text similarity score using text index
                    textScore: {
                        $multiply: [
                            {$meta: "textScore"},
                            textSimilarityWeight
                        ]
                    },

                    engagementScore: {
                        $multiply: [
                            {
                                $divide: [
                                    {$add: ["$viewCount", {$multiply: ["$likeCount", 2]}]},
                                    100
                                ]
                            },
                            engagementWeight
                        ]
                    },

                    timeDecayScore: {
                        $multiply: [
                            this.getTimeDecayExpression(),
                            timeDecayWeight
                        ]
                    }
                }
            },

            {
                $match: {
                    $text: {
                        $search: `${originalPost.title} ${originalPost.content}`
                    }
                }
            },

            {
                $addFields: {
                    finalScore: {
                        $add: [
                            "$categoryScore",
                            "$tagScore",
                            "$textScore",
                            "$engagementScore",
                            "$timeDecayScore"
                        ]
                    }
                }
            },

            // Sort by final score
            {
                $sort: {
                    finalScore: -1
                }
            },

            // Limit results
            {$limit: limit},

            // Populate user
            {
                $lookup: {
                    from: 'users',
                    localField: 'user',
                    foreignField: '_id',
                    as: 'user'
                }
            },
            {$unwind: '$user'},

            {
                $project: {
                    _id: 1,
                    title: 1,
                    content: 1,
                    tags: 1,
                    category: 1,
                    user: 1,
                    viewCount: 1,
                    likeCount: 1,
                    publishedAt: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    scores: {
                        category: "$categoryScore",
                        tags: "$tagScore",
                        text: "$textScore",
                        engagement: "$engagementScore",
                        timeDecay: "$timeDecayScore",
                        final: "$finalScore"
                    }
                }
            }
        ];

        return this.aggregate(pipeline);
    }

    /**
     * Increment view count for a post
     */
    public async incrementViewCount(postId: string): Promise<void> {
        await this.updateById(postId, {$inc: {viewCount: 1}});
    }

    /**
     * Increment like count for a post
     */
    public async updateLikeCount(postId: string, likeUpdateType = "increment"): Promise<void> {
        if(likeUpdateType === "decrement") {
            await this.updateById(postId, {$inc: {likeCount: 1}});
        } else {
            await this.updateById(postId, {dec: {likeCount: 1}});
        }
    }
}

export default PostService;