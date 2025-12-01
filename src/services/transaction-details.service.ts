/**
 * Service class for Order-related operations
 *
 * @description Extends the generic DBService with Order-specific operations
 * @extends {DBService<ITransactionDetail>}
 */
import DBService from "../utils/db.utils";
import {ITransactionDetail} from "../models/interface";
import TransactionDetail from "../models/transaction-details.model";

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
}

export default TransactionDetailsService;