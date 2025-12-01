import {
    Model,
    HydratedDocument,
    ClientSession,
    FilterQuery, Aggregate, PipelineStage,
} from "mongoose";

/**
 * Represents the result of a pagination operation
 * @template T The type of the model
 */
interface PaginationResult<T> {
    itemsCount: number;
    data: HydratedDocument<T>[];
    perPage: number;
    currentPage: number;
    next: number | null;
    prev: number | null;
    pageCount: number;
    serialNumber: number;
    paginator: any;
}

/**
 * A generic database service that provides comprehensive CRUD operations
 * with enhanced type safety and error handling
 * @template T The type of the Mongoose model
 */
class DBService<T> {
    /** The Mongoose model associated with this service */
    private readonly Model: Model<T>;

    /** Default paths to populate when retrieving documents */
    private readonly defaultPopulatedPaths: string[];

    /**
     * Creates an instance of DBService
     * @param {Model<T>} model The Mongoose model to work with
     * @param {string[]} [populatedPaths=[]] Optional default paths to populate
     */
    constructor(model: Model<T>, populatedPaths: string[] = []) {
        this.Model = model;
        this.defaultPopulatedPaths = populatedPaths;
    }

    /**
     * Centralized error handling method for database operations
     * @template R The return type of the operation
     * @param {() => Promise<R>} operation The database operation to execute
     * @param {string} [errorMessage='Database operation failed'] Custom error message
     * @returns {Promise<R>} The result of the operation
     * @throws {Error} Throws an error if the operation fails
     */
    private async executeWithErrorHandling<R>(
        operation: () => Promise<R>,
        errorMessage: string = 'Database operation failed'
    ): Promise<R> {
        try {
            return await operation();
        } catch (error) {
            console.error(errorMessage, error);
            throw new Error(`${errorMessage}: ${error instanceof Error ? error.message : error}`);
        }
    }

    /**
     * Saves a new document with optional validation
     * @param {Partial<T>} data The data to save
     * @param {ClientSession} [session=null] Optional database session for transactions
     * @param {boolean} [validate=true] Whether to run validation before saving
     * @returns {Promise<HydratedDocument<T>>} The saved document
     */
    public async save(
        data: Partial<T>,
        session: ClientSession | null = null,
        validate: boolean = true
    ): Promise<HydratedDocument<T>> {
        return this.executeWithErrorHandling(async () => {
            const model = new this.Model(data);
            if (validate) {
                await model.validate();
            }
            return model.save({ session }) as Promise<HydratedDocument<T>>;
        }, 'Save operation failed');
    }

    /**
     * Creates a document using Mongoose create method
     * @param {any} data Document to create
     * @param {ClientSession} [session=null] Optional database session
     * @returns {Promise<any>} Created document
     */
    public create(data: any, session: ClientSession | null = null): Promise<any> {
        return this.executeWithErrorHandling(() =>
                this.Model.create(data)
            , 'Create operation failed');
    }

    /**
     * Counts documents matching a query
     * @param {any} [query={}] Query to filter documents
     * @returns {Promise<number>} Number of matching documents
     */
    public count(query: any = {}): Promise<number> {
        return this.executeWithErrorHandling(() =>
                this.Model.countDocuments(query).maxTimeMS(30000)
            , 'Count operation failed');
    }

    /**
     * Updates a document by query
     * @param {string} id Document ID to update
     * @param {any} data Update data
     * @param {ClientSession} [session=null] Optional database session
     * @returns {Promise<any>} Updated document
     */
    public update(query: Partial<T>, data: any, session: ClientSession | null = null): Promise<any> {
        return this.executeWithErrorHandling(() =>
                this.Model.updateOne(query, data, { new: true }).session(session)
            , 'Update by ID failed');
    }

    /**
     * Updates multiple documents that matches a query
     * @param {FilterQuery<T>} [query={}] The query to filter documents 
     * @param {any} data Update data 
     * @param {ClientSession} [session=null] Optional database session 
     * @returns {Promise<any>} Updated documents
     */
    public async updateMany(
        query: FilterQuery<T>,
        data: any,
        session: ClientSession | null = null
    ): Promise<any> {
        return this.executeWithErrorHandling(() =>
            this.Model.updateMany(query, data).session(session),
            'Update many operation failed'
        );
    }


    /**
     * Updates a document by ID
     * @param {string} id Document ID to update
     * @param {any} data Update data
     * @param {ClientSession} [session=null] Optional database session
     * @returns {Promise<any>} Updated document
     */
    public updateById(id: string, data: any, session: ClientSession | null = null): Promise<any> {
        return this.executeWithErrorHandling(() =>
                this.Model.findByIdAndUpdate(id, data, { new: true }).session(session)
            , 'Update by ID failed');
    }

    /**
     * Finds documents with flexible querying options
     * @param {FilterQuery<T>} [query={}] The query to filter documents
     * @param {Object} [options={}] Additional find options
     * @param {Record<string, 1 | -1>} [options.sort] Sorting configuration
     * @param {number} [options.limit] Maximum number of documents to return
     * @param {ClientSession} [options.session] Database session
     * @param {string[]} [options.select] Fields to select
     * @param {string[]} [options.populate] Paths to populate
     * @returns {Promise<HydratedDocument<T>[]>} Array of found documents
     */
    public async find(
        query: FilterQuery<T> = {},
        options: {
            sort?: Record<string, 1 | -1>;
            limit?: number;
            session?: ClientSession;
            select?: string[];
            populate?: string[];
        } = {}
    ): Promise<HydratedDocument<T>[]> {
        return this.executeWithErrorHandling(async () => {
            const {
                sort = { created_at: -1 },
                limit = 300,
                session = null,
                select = [],
                populate = this.defaultPopulatedPaths
            } = options;

            return this.Model.find(query)
                .populate(populate)
                .session(session)
                .limit(limit)
                .sort(sort)
                .select(select.join(' ')) as Promise<HydratedDocument<T>[]>;
        }, 'Find operation failed');
    }

    /**
     * Finds a document by its ID with optional population and field selection
     * @param {string} id The document ID to find
     * @param {Object} [options={}] Additional query options
     * @param {ClientSession} [options.session] Database session
     * @param {string[]} [options.select] Fields to select
     * @param {string[]} [options.populate] Paths to populate
     * @returns {Promise<HydratedDocument<T> | null>} Found document or null
     */
    public async findById(
        id: string,
        options: {
            session?: ClientSession;
            select?: string[];
            populate?: string[];
        } = {}
    ): Promise<HydratedDocument<T> | null> {
        return this.executeWithErrorHandling(async () => {
            const {
                session = null,
                select = [],
                populate = this.defaultPopulatedPaths
            } = options;

            return this.Model.findById(id)
                .session(session)
                .populate(populate)
                .select(select.join(' ')) as Promise<HydratedDocument<T> | null>;
        }, 'Find by ID operation failed');
    }

    /**
     * Finds a single document with optional population and field selection
     * @param {FilterQuery<T>} query The query to find the document
     * @param {Object} [options={}] Additional query options
     * @param {ClientSession} [options.session] Database session
     * @param {string[]} [options.select] Fields to select
     * @param {string[]} [options.populate] Paths to populate
     * @returns {Promise<HydratedDocument<T> | null>} Found document or null
     */
    public async findOne(
        query: FilterQuery<T>,
        options: {
            session?: ClientSession;
            select?: string[];
            populate?: string[];
        } = {}
    ): Promise<HydratedDocument<T> | null> {
        return this.executeWithErrorHandling(async () => {
            const {
                session = null,
                select = [],
                populate = this.defaultPopulatedPaths
            } = options;

            return this.Model.findOne(query)
                .session(session)
                .populate(populate)
                .select(select.join(' ')) as Promise<HydratedDocument<T> | null>;
        }, 'Find one operation failed');
    }

    /**
     * Performs paginated query with advanced options
     * @param {FilterQuery<T>} [query={}] The query to filter documents
     * @param {Object} [options={}] Pagination and query options
     * @param {number} [options.page=1] Page number
     * @param {number} [options.limit=10] Documents per page
     * @param {Record<string, 1 | -1>} [options.sort] Sorting configuration
     * @param {string[]} [options.select] Fields to select
     * @param {string[]} [options.populate] Paths to populate
     * @returns {Promise<PaginationResult<T>>} Paginated result
     */
    public async paginate(
        query: FilterQuery<T> = {},
        options: {
            page?: number;
            limit?: number;
            sort?: Record<string, 1 | -1 | { $meta: "textScore" }>;
            select?: string[];
            populate?: string[];
        } = {}
    ): Promise<PaginationResult<T>> {
        return this.executeWithErrorHandling(async () => {
            const {
                page = 1,
                limit = 10,
                sort = { created_at: -1 },
                select = [],
                populate = this.defaultPopulatedPaths
            } = options;

            const customLabels = {
                totalDocs: 'itemsCount',
                docs: 'data',
                limit: 'perPage',
                page: 'currentPage',
                nextPage: 'next',
                prevPage: 'prev',
                totalPages: 'pageCount',
                pagingCounter: 'serialNumber',
                meta: 'paginator'
            };

            const paginationOptions = {
                page,
                limit,
                sort,
                customLabels,
                populate,
                select: select.join(' ')
            };

            // @ts-ignore - mongoose-paginate-v2 type issue
            return this.Model.paginate(query, paginationOptions);
        }, 'Pagination failed');
    }

    /**
     * Performs bulk write operations with optional transaction support
     * @param {any[]} operations Array of bulk write operations
     * @param {ClientSession} [session] Optional database session
     * @returns {Promise<any>} Result of bulk write operations
     */
    public async bulkWrite(
        operations: any[],
        session?: ClientSession
    ): Promise<any> {
        return this.executeWithErrorHandling(async () => {
            return this.Model.bulkWrite(operations, { session });
        }, 'Bulk write operation failed');
    }

    /**
     * Deletes a document by its ID
     * @param {string} id The document ID to delete
     * @param {Object} [options={}] Additional delete options
     * @param {ClientSession} [options.session] Database session
     * @returns {Promise<any>} Result of the delete operation
     */
    public async deleteById(
        id: string,
        options: { session?: ClientSession } = {}
    ): Promise<any> {
        return this.executeWithErrorHandling(async () => {
            const { session = null } = options;
            return this.Model.findByIdAndDelete(id).session(session);
        }, 'Delete by ID operation failed');
    }

    /**
     * Deletes a single document matching the query
     * @param {FilterQuery<T>} query The query to find the document
     * @param {Object} [options={}] Additional delete options
     * @param {ClientSession} [options.session] Database session
     * @returns {Promise<any>} Result of the delete operation
     */
    public async deleteOne(
        query: FilterQuery<T>,
        options: { session?: ClientSession } = {}
    ): Promise<any> {
        return this.executeWithErrorHandling(async () => {
            const { session = null } = options;
            return this.Model.findOneAndDelete(query).session(session);
        }, 'Delete one operation failed');
    }

    /**
     * Deletes multiple documents matching the query
     * @param {FilterQuery<T>} query The query to find documents
     * @param {Object} [options={}] Additional delete options
     * @param {ClientSession} [options.session] Database session
     * @returns {Promise<any>} Result of the delete operation
     */
    public async deleteMany(
        query: FilterQuery<T>,
        options: { session?: ClientSession } = {}
    ): Promise<any> {
        return this.executeWithErrorHandling(async () => {
            const { session = null } = options;
            return this.Model.deleteMany(query).session(session);
        }, 'Delete many operation failed');
    }

    /**
     * Performs aggregation operations with error handling
     * @param {PipelineStage[]} pipeline Array of aggregation pipeline stages
     * @param {Object} [options={}] Additional aggregation options
     * @param {ClientSession} [options.session] Database session for transactions
     * @returns {Promise<any[]>} Result of the aggregation pipeline
     */
    public async aggregate(
        pipeline: PipelineStage[],
        options: {
            session?: ClientSession;
        } = {}
    ): Promise<any[]> {
        return this.executeWithErrorHandling(async () => {
            const { session = null } = options;

            let aggregation: Aggregate<any[]> = this.Model.aggregate(pipeline);

            // Add session if provided
            if (session) {
                aggregation = aggregation.session(session);
            }

            return aggregation.exec();
        }, 'Aggregation operation failed');
    }
}

export default DBService;