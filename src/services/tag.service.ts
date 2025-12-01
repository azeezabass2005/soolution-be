/**
 * Service class for Tag-related database operations
 *
 * @description Extends the generic DBService with Tag-specific configurations
 * @extends {DBService<ITag>}
 */
import DBService from "../utils/db.utils";
import {ITag} from "../models/interface";
import Tag from "../models/tag.model";

class TagService extends DBService<ITag> {
    /**
     * Creates an instance of TagService
     *
     * @constructor
     */
    constructor() {
        // Initialize the service with the Tag model
        super(Tag, [])
    }
}

export default TagService;