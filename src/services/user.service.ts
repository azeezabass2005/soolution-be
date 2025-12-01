import DBService from '../utils/db.utils';
import { IUser } from '../models/interface';
import User from '../models/user.model';

/**
 * Service class for User-related database operations
 *
 * @description Extends the generic DBService with User-specific configurations
 * @extends {DBService<IUser>}
 */
class UserService extends DBService<IUser> {
    /**
     * Creates an instance of UserService
     *
     * @constructor
     * @param {string[]} [populatedFields=[]] - Optional fields to populate during queries
     * @example
     * // Create a UserService with populated references
     * new UserService(['profile', 'roles'])
     */
    constructor(populatedFields: string[] = []) {
        // Initialize the service with User model and optional population fields
        super(User, populatedFields);
    }
}

export default UserService;