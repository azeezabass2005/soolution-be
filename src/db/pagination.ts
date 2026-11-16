/**
 * Page metadata in the exact shape the API returned with mongoose-paginate-v2
 * (customLabels + meta: "paginator"), so the frontend keeps working unchanged.
 */
export interface PaginatorMeta {
    itemsCount: number;
    perPage: number;
    pageCount: number;
    currentPage: number;
    serialNumber: number;
    hasPrevPage: boolean;
    hasNextPage: boolean;
    prev: number | null;
    next: number | null;
}

export interface Paginated<T> {
    data: T[];
    paginator: PaginatorMeta;
}

export interface PageRequest {
    page?: number | string | null;
    limit?: number | string | null;
}

export interface PageWindow {
    page: number;
    limit: number;
    offset: number;
}

const MAX_LIMIT = 1000;

/** Clamp page/limit to sane values (page ≥ 1, 1 ≤ limit ≤ MAX_LIMIT) */
export function pageWindow(request: PageRequest = {}, defaults: { limit?: number; maxLimit?: number } = {}): PageWindow {
    const rawPage = Number(request.page);
    const rawLimit = Number(request.limit);
    const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
    const fallback = defaults.limit ?? 10;
    const max = defaults.maxLimit ?? MAX_LIMIT;
    const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(Math.floor(rawLimit), max) : fallback;
    return { page, limit, offset: (page - 1) * limit };
}

export function toPage<T>(data: T[], total: number, window: PageWindow): Paginated<T> {
    const pageCount = Math.ceil(total / window.limit) || 1;
    const hasPrevPage = window.page > 1;
    const hasNextPage = window.page < pageCount;
    return {
        data,
        paginator: {
            itemsCount: total,
            perPage: window.limit,
            pageCount,
            currentPage: window.page,
            serialNumber: (window.page - 1) * window.limit + 1,
            hasPrevPage,
            hasNextPage,
            prev: hasPrevPage ? window.page - 1 : null,
            next: hasNextPage ? window.page + 1 : null,
        },
    };
}
