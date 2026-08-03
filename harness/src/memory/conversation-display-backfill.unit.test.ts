import { describe, expect, it } from "bun:test";
import type { Pool, QueryResult } from "pg";

import { backfillConversationDisplayEnvelopes } from "./conversation-display-backfill.js";

function poolWithQuery(query: Pool["query"]): Pool {
    // The backfill uses only Pool.query; a full pg Pool would make these startup
    // failure-path tests depend on a container before their first assertion.
    return { query } as Pool;
}

describe("conversation display backfill diagnostics", () => {
    it("rejects an invalid existing envelope with thread and turn identity", async () => {
        const pool = poolWithQuery(
            (async () =>
                ({
                    rows: [{ thread_id: "thread-bad", seq: "7", display_envelope: { kind: "wrong" } }],
                    rowCount: 1,
                }) as QueryResult) as Pool["query"],
        );

        await expect(backfillConversationDisplayEnvelopes({ pool, resolveWorkspaceRoot: () => "/unused", tools: [] })).rejects.toThrow(/thread-bad\/7\/display/);
    });

    it("propagates database failures instead of treating them as historical absence", async () => {
        const failure = new Error("database unavailable");
        const pool = poolWithQuery((async () => Promise.reject(failure)) as Pool["query"]);

        await expect(backfillConversationDisplayEnvelopes({ pool, resolveWorkspaceRoot: () => "/unused", tools: [] })).rejects.toBe(failure);
    });
});
