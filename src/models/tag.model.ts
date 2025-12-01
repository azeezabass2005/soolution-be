/**
 * Mongoose schema for Tag model
 *
 * @description Creates a schema for tag which a post can be related to
 */
import {Model, model, Schema} from "mongoose";
import {ITag} from "./interface";
import {MODEL_NAME} from "../common/constant";

export const TagSchema = new Schema<ITag>(
    {
        /**
         * Title which is the value of the tag
         * @type {string}
         * @required
         */
        title: { type: String, required: true }
    }
);

/**
 * Tag model based on ITag interface
 *
 * @description Creates and exports the Mongoose model for Tag
 * @type {Model<ITag>}
 */
const Tag: Model<ITag> = model(MODEL_NAME.TAG, TagSchema);
export default Tag;