// The wire types that each route of the local server shares. The server routes (src/server/) and the
// client fetchers (src/client/) import the same declarations, thus the two sides cannot disagree on a shape.

/** The `error` code of an {@link ApiError} body. Each code has one HTTP status. */
export type ApiErrorCode =
    "invalid_json" | "validation_error" | "unauthorized" | "not_found" | "conflict" | "busy" | "locked" | "internal_error" | "unavailable" | "draining";

/** The HTTP status of each {@link ApiErrorCode}. */
export const API_ERROR_STATUS = {
    invalid_json: 400,
    validation_error: 400,
    unauthorized: 401,
    not_found: 404,
    conflict: 409,
    busy: 409,
    locked: 409,
    internal_error: 500,
    unavailable: 503,
    draining: 503,
} as const satisfies Record<ApiErrorCode, number>;

/** The JSON body of each error response. On an open SSE stream an error is a frame instead, never this body. */
export type ApiError = {
    /** A stable code for a program to switch on. */
    error: ApiErrorCode;
    /** One line for a person. A 500 carries generic text, never the internal cause. */
    message: string;
    /** Code-specific data, for example the zod `flatten()` output of a `validation_error`, or the `phase` of an `unavailable`. */
    details?: unknown;
};

/** The zero-based page that a list request asks for. */
export type PageQuery = {
    page: number;
    perPage: number;
};

/** The `perPage` of a list request that sends none, or a value that is not a positive integer. */
export const DEFAULT_PER_PAGE = 100;

/** The largest `perPage` a list gives. A larger request gets this many. */
export const MAX_PER_PAGE = 200;

/** The paging fields of each list response. */
export type ListPage = PageQuery & {
    /** The count of all items, over all pages. */
    total: number;
    /** True when a page after this one has items. */
    hasMore: boolean;
};

/** A list response: the items under a key that names the resource (`threads`, `runs`, …), plus the paging fields. */
export type ListEnvelope<K extends string, T> = { [P in K]: T[] } & ListPage;
