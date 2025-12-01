import argon2 from 'argon2';

export interface IHash {
    password: string;
}

export class HashService {

    /**
     * Generate a secure password hash
     * @param password Plain text password
     * @returns Hashed password
     */
    static async hashPassword(password: string): Promise<IHash> {
        try {
            // User argon2 for password hashing
            const hashedPassword = await argon2.hash(password);

            return {
                password: hashedPassword,
            };
        } catch (error) {
            console.error('Password hashing failed', error);
            throw new Error('Password hashing failed');
        }
    }

    /**
     * Verify password against stored hash
     * @param plainPassword Submitted password
     * @param hashedPassword Stored hashed password
     * @returns Boolean indicating password match
     */
    static async verifyPassword(
        plainPassword: string,
        hashedPassword: string
    ): Promise<boolean> {
        try {
            return await argon2.verify(hashedPassword, plainPassword);
        } catch (error) {
            console.error('Password verification failed', error);
            return false;
        }
    }
}

export default HashService;