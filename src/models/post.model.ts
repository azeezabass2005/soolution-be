import { Schema, model, Model } from 'mongoose';
import { IPost, PublicationStatus } from './interface';
import {MODEL_NAME, PUBLICATION_STATUS} from '../common/constant';
import paginate from "mongoose-paginate-v2"

/**
 * Mongoose schema for Post model
 *
 * @description Creates a schema for post
 * @remarks
 * - Includes timestamps for creation and update tracking
 * - Enables virtual property transformations
 */
export const PostSchema = new Schema<IPost>(
    {
        /**
         * Title of the post
         * @type {string}
         * @required
         */
        title: { type: String, required: true },

        /**
         * Content of the post
         * @type {string}
         * @required
         */
        content: { type: String, required: true },

        /**
         * Tags for the post
         * @type {string[]}
         * @default []
         */
        tags: { type: [String], default: [] },

        /**
         * Category of the post
         * @type {string}
         * @required
         */
        category: { type: String, required: true },

        /**
         * User ID of the post creator
         * @type {Schema.Types.ObjectId}
         * @required
         * @ref UserModel
         */
        user: { type: Schema.Types.ObjectId, ref: MODEL_NAME.USER, required: true },

        /**
         * Number of views for the post
         * @type {number}
         * @default 0
         */
        viewCount: { type: Number, default: 0 },

        /**
         * Number of likes for the post
         * @type {number}
         * @default 0
         */
        likeCount: { type: Number, default: 0 },

        /**
         * The current publication status
         * @type {PublicationStatus}
         * @default draft
         */
        publicationStatus: { type: String, enum: Object.values(PUBLICATION_STATUS), default: PUBLICATION_STATUS.DRAFT }

    },
    {
        /** Enable virtual properties when converting to plain object */
        toObject: { virtuals: true },

        /** Enable virtual properties when converting to JSON */
        toJSON: { virtuals: true },

        /** Automatically manage createdAt and updatedAt timestamps */
        timestamps: true,
    }
);

/**
 * Add text index for search
 * @description Adds a text index to the title and content fields
 */
PostSchema.index({ title: 'text', content: 'text' });

PostSchema.plugin(paginate);

/**
 * Post model based on IPost interface
 *
 * @description Creates and exports the Mongoose model for Post
 * @type {Model<IPost>}
 */
const Post: Model<IPost> = model<IPost>(MODEL_NAME.POST, PostSchema);
export default Post;