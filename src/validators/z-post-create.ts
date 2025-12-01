import z from "zod";
import { Request, Response, NextFunction } from "express";
import zodErrorHandler from "./zod.error";

const ZPostCreate = z.object({
    title: z.string().min(3).max(63),
    content: z.string().min(63),
    tags: z.array(z.string()).max(8),
    category: z.string().min(3).max(63),
});

const validate = async (req: Request, res: Response, next: NextFunction) => {
    try {
        ZPostCreate.parse(req.body)
        next()
    } catch (error) {
        zodErrorHandler(error, next)
    }
}

export default validate;