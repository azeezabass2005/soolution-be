import mongoose, {model, Model, Schema} from "mongoose";
import {IExchangeRate} from "./interface";
import {CURRENCY_CODES, MODEL_NAME} from "../common/constant";

/**
 * Mongoose schema for Exchange Rate model
 *
 * @description Creates a schema for user authentication and basic information
 */
export const ExchangeRateSchema = new Schema<IExchangeRate>(
    {
        /**
         * Code for the currency being converted from
         * @type {string}
         * @enum CurrencyCode
         * @required
         */
        from: { type: String, enum: CURRENCY_CODES, required: true },

        /**
         * Code for the currency being converted to
         * @type {string}
         * @enum CurrencyCode
         * @required
         */
        to: { type: String, enum: CURRENCY_CODES, required: true },

        /**
         * Rate
         * @type {number}
         * @required
         */
        rate: { type: Number, required: true },

        /**
         * isActive
         * @type {boolean}
         * @required
         */
        isActive: { type: Boolean, required: true }
    },
    {
            /** Enable virtual properties when converting to plain object */
            toObject: { virtuals: true },

            /** Enable virtual properties when converting to JSON */
            toJSON: { virtuals: true },

            /** Automatically manage createdAt and unpdatedAt timestamps */
            timestamps: true,
    }
);

/**
 * Exchange Rate Model based on IExchangeRate interface
 *
 * @description Creates and exports the Mongoose model for Exchange Rate
 * @type {Model<IExchangeRate>}
 */
const ExchangeRate: Model<IExchangeRate> = model<IExchangeRate>(MODEL_NAME.EXCHANGE_RATE, ExchangeRateSchema);
export default ExchangeRate;