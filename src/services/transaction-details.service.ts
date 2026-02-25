/**
 * Service class for Order-related operations
 *
 * @description Extends the generic DBService with Order-specific operations
 * @extends {DBService<ITransactionDetail>}
 */
import DBService from "../utils/db.utils";
import {ITransactionDetail} from "../models/interface";
import TransactionDetail from "../models/transaction-details.model";
import { ClientSession } from "mongoose";

class TransactionDetailsService extends DBService<ITransactionDetail> {

    /**
     * Creates an instance of TransactionDetailsService
     * @constructor
     * @param populatedField
     * @example
     * new TransactionDetailsService(['user'])
     */
    constructor(populatedField: string[] = []) {
        super(TransactionDetail, populatedField);
    }

    /**
     * Updates a single transaction detail document with session support
     * @param query Query to find the document
     * @param data Update data
     * @param session Database session
     * @returns Promise with update result
     */
    public async updateOneWithSession(
        query: any,
        data: any,
        session: ClientSession
    ): Promise<any> {
        try {
            return await this.Model.updateOne(query, data, { session });
        } catch (error) {
            throw new Error('Update one operation failed');
        }
    }
}

export default TransactionDetailsService;