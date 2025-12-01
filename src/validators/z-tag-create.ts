import z from "zod";
import { Request, Response, NextFunction } from "express";
import zodErrorHandler from "./zod.error";

const ZTagCreate = z.object({
    title: z.string().min(2).max(32),
});

const validate = async (req: Request, res: Response, next: NextFunction) => {
    try {
        ZTagCreate.parse(req.body)
        next()
    } catch (error) {
        zodErrorHandler(error, next)
    }
}

export default validate;