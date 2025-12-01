import Jwt, { JwtPayload } from 'jsonwebtoken';
import dotenv from 'dotenv';
import {
    ITokenPayload,
    IVerifyTokenPayload,
    TokenType,
    ITokenOptions
} from './interface';
import { IUser } from '../models/interface';

dotenv.config()

/**
 * Utility functions for token-related operations
 */
export class TokenUtils {
    /**
     * Adds specified number of days to the current date
     * @param days Number of days to add
     * @returns Future date
     */
    static addDaysToDate(days: number): Date {
        const date = new Date(Date.now());
        date.setDate(date.getDate() + days);
        return date;
    }

    /**
     * Generates a random token for additional security
     * @param length Length of the token (default: 32)
     * @returns Randomly generated token string
     */
    static generateRandomToken(length: number = 32): string {
        return Array.from(crypto.getRandomValues(new Uint8Array(length)))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    /**
     * Generates a random refresh token id for refresh token persistent storage
     * @returns Randomly generated token string
     */
    static generateRefreshTokenId(): string {
        return this.generateRandomToken(32);
    }

    static getRefreshTokenExpiry(): Date {
        return this.addDaysToDate(7);
    }
}

/**
 * Represents a token management class with advanced features
 */
class Token {
    private readonly token: string;

    /**
     * Creates an instance of Token
     * @param token Optional existing token
     */
    constructor(token?: string) {
        this.token = token || '';
    }

    /**
     * Creates an access token for user authentication
     * @param user User object to generate token for
     * @param options Token creation options
     * @returns Generated JWT token
     */
    createToken(
        user: IUser,
        options: ITokenOptions = {
            type: TokenType.ACCESS,
            expiresIn: '168h'
        }
    ): string {
        const { type = TokenType.ACCESS, expiresIn = '1h' } = options;

        const payload: ITokenPayload = {
            userId: user?._id as string,
            email: user?.email,
            role: user?.role,
            username: user?.username,
        };

        return Jwt.sign(
            {
                data: payload,
                type
            },
            this.getSecretKey(),
            {
                expiresIn,
                algorithm: 'HS256'
            }
        );
    }

    /**
     * Creates a verification token
     * @param user User details for verification
     * @returns Verification JWT token
     */
    createVerifyToken(user: {
        userId: string;
        email: string;
        username: string;
        role: number;
    }): string {
        const payload: IVerifyTokenPayload = {
            ...user,
            date: TokenUtils.addDaysToDate(3)
        };

        return Jwt.sign(
            {
                data: payload,
                type: TokenType.VERIFY
            },
            this.getSecretKey(),
            {
                expiresIn: '72h',
                algorithm: 'HS256'
            }
        );
    }



    /**
     * Verifies the JWT token
     * @param ignoreExpiration Whether to ignore token expiration
     * @returns Decoded token payload
     */
    async verifyToken(ignoreExpiration: boolean = false): Promise<JwtPayload> {
        return new Promise((resolve, reject) => {
            Jwt.verify(
                this.token,
                this.getSecretKey(),
                {
                    ignoreExpiration,
                    algorithms: ['HS256']
                },
                (err, decoded) => {
                    if (err) {
                        reject({
                            state: 2,
                            error: err,
                            message: 'Token verification failed'
                        });
                    } else {
                        resolve(decoded as JwtPayload);
                    }
                }
            );
        });
    }

    /**
     * Retrieves the secret key from environment variables
     * @returns JWT secret key
     * @throws {Error} If TOKEN_SECRET is not set
     */
    private getSecretKey(): string {
        const secret = process.env["JWT_SECRET"];
        if (!secret) {
            throw new Error('TOKEN_SECRET is not defined in environment variables');
        }
        return secret;
    }
}

/**
 * Builder class for creating Token instances
 */
class TokenBuilder {
    private token?: string;

    /**
     * Sets the token for the builder
     * @param token Token string
     * @returns TokenBuilder instance
     */
    setToken(token: string): TokenBuilder {
        this.token = token;
        return this;
    }

    /**
     * Builds and returns a Token instance
     * @returns Token instance
     */
    build(): Token {
        return new Token(this.token);
    }
}

export default TokenBuilder;