import z from "zod";
import errorResponseMessage from "../common/messages/error-response-message";
import {NextFunction} from "express";

const zodErrorHandler = (error: any, next: NextFunction) => {
    if (error instanceof z.ZodError) {
        next(errorResponseMessage.badRequest(error))
    } else if (error instanceof Error) {
        next(errorResponseMessage.unableToComplete(error.message))
    } else {
        next(errorResponseMessage.unableToComplete())
    }
}

export default zodErrorHandler;