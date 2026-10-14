/**
 * Builders for the seam doubles the tests hand-assemble: each builder returns
 * the seam's own type with no cast, so the test states only the behavior it
 * drives and the compiler checks the rest of the seam shape.
 */
import { Pool } from "pg";
import type { QueryResult } from "pg";
import { z } from "zod";

/** The query argument the harness passes a pool: the SQL text and its parameters. */
export type PoolQueryArg = { text: string; values?: unknown[] };

const queryArg = z.object({ text: z.string(), values: z.array(z.unknown()).optional() }).loose();

/** The slice of a query result the harness reads: the row payload and the affected count. */
export type PoolResult = { rows?: unknown[]; rowCount?: number | null };

function unstubbedQuery(): PoolResult {
    throw new Error("poolDouble: query was called without a stub");
}

/**
 * A `Pool` double: a real `Pool` instance (never connected — the constructor
 * only reads config) whose `query` the handler answers. The handler receives
 * the query as `{ text, values }` and may return a bare result or a promise of
 * one; the other pool members come from `members`.
 */
export function poolDouble(
    handler: (query: PoolQueryArg, values: unknown[] | undefined) => PoolResult | Promise<PoolResult> = unstubbedQuery,
    members: Partial<Pool> = {},
): Pool {
    class FakePool extends Pool {
        override async query(...args: unknown[]): Promise<QueryResult> {
            const arg = args[0];
            // The positional form carries its parameters as the second argument; the config form carries them inside the config.
            const query = typeof arg === "string" ? { text: arg, values: Array.isArray(args[1]) ? args[1] : undefined } : queryArg.parse(arg);
            const answered = await handler(query, typeof arg === "string" ? query.values : undefined);
            return { command: "SELECT", rowCount: answered.rowCount ?? 0, oid: 0, fields: [], rows: answered.rows ?? [] };
        }
    }
    return Object.assign(new FakePool(), members);
}

/**
 * A `fetch` double: the handler sees the raw input and init, and the result is
 * a real `typeof fetch`. A synchronous throw in the handler stays synchronous,
 * the way the replaced inline double threw.
 */
export function fetchDouble(handler: (input: unknown, init: RequestInit | undefined) => Response | Promise<Response>): typeof fetch {
    const double = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => Promise.resolve(handler(input, init));
    // `typeof fetch` carries bun's own `preconnect` member beside the call; the double leaves it to the runtime default.
    double.preconnect = fetch.preconnect;
    return double;
}
