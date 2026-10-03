import { describe, expect, test } from "bun:test";
import type { Pool } from "@inflexa-ai/harness";

import { countLiveDurableWork } from "./durable_work.ts";

// No cli test reaches Postgres. The pool below records the query and answers with one row, thus the tests
// pin the scope, the live status set, and the mapping of the counts.

type Query = { readonly text: string; readonly values: readonly unknown[] };

/** A pool that records each query and answers with `row`, or rejects with `failure`. */
function recordingPool(answer: { row: Record<string, string> } | { failure: Error }): { pool: Pool; queries: Query[] } {
    const queries: Query[] = [];
    const query = (config: Query): Promise<{ rows: unknown[]; rowCount: number }> => {
        queries.push(config);
        return "failure" in answer ? Promise.reject(answer.failure) : Promise.resolve({ rows: [answer.row], rowCount: 1 });
    };
    // The function under test calls only `query`, thus a stand-in object with that one method is enough.
    return { pool: { query } as unknown as Pool, queries };
}

describe("countLiveDurableWork", () => {
    test("counts the live work of one analysis, with each live DBOS status", async () => {
        const { pool, queries } = recordingPool({ row: { runs: "2", profiles: "1" } });

        expect((await countLiveDurableWork(pool, "a1"))._unsafeUnwrap()).toEqual({ runs: 2, profiles: 1 });
        expect(queries).toHaveLength(1);
        expect(queries[0]?.text).toContain("dbos.workflow_status");
        expect(queries[0]?.values).toEqual(["a1", ["PENDING", "ENQUEUED", "DELAYED"]]);
    });

    test("counts the live work of each analysis when no analysis is named", async () => {
        const { pool, queries } = recordingPool({ row: { runs: "0", profiles: "3" } });

        expect((await countLiveDurableWork(pool))._unsafeUnwrap()).toEqual({ runs: 0, profiles: 3 });
        expect(queries[0]?.values[0]).toBeNull();
    });

    test("a failed read is the error, with its cause", async () => {
        const failure = new Error("relation dbos.workflow_status does not exist");
        const { pool } = recordingPool({ failure });

        expect((await countLiveDurableWork(pool, "a1"))._unsafeUnwrapErr()).toBe(failure);
    });
});
