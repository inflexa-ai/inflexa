import type { Pool } from "pg";

import type { Querier } from "../../state/db.js";

/** Counts the calls to `query`, thus a test sees how many statements a read sends. */
export function countingQuerier(pool: Pool): { querier: Querier; calls: () => number } {
    let calls = 0;
    // The wrapper forwards every `query` call to the pool that it wraps, and the reads under test only call `query`.
    const querier: Querier = {
        query: (...args) => {
            calls += 1;
            return pool.query(...args);
        },
    };
    return { querier, calls: () => calls };
}
