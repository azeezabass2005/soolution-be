import { tagRepository } from "../repositories/post.repository";
import type { Tag } from "../types/entities";

/** Tags a post can be related to */
class TagService {
    async create(title: string): Promise<Tag> {
        return tagRepository.create(title);
    }

    /** Newest first */
    async list(): Promise<Tag[]> {
        return tagRepository.list();
    }
}

export default TagService;
