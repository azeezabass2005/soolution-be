import z, {ZodError} from "zod";
import {Request, Response, NextFunction} from "express";
import errorResponseMessage from "../common/messages/error-response-message";
import zodErrorHandler from "./zod.error";

const ZLogin = z.object({
    email: z
        .string()
        .email("Invalid email format")
        .refine((email) => {
            // Additional email format check using a more comprehensive regex
            const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}$/;
            return emailRegex.test(email);
        }, "Invalid email format"),
    password: z.string().optional()
})

const validate = (req: Request, res: Response, next: NextFunction) => {
    try {
        ZLogin.parse(req.body);
        next()
    } catch (error) {
        zodErrorHandler(error, next)
    }
}

export default validate;