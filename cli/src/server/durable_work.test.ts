import { describe, expect, test } from "bun:test";
import type { Pool } from "@inflexa-ai/harness";

import { countLiveDurableWork, countLiveDurableWorkByAnalysis, listLiveRunIds, listLiveTurns } from "./durable_work.ts";

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
        const { pool, queries } = recordingPool({ row: { runs: "2", profiles: "1", turns: "1" } });

        expect((await countLiveDurableWork(pool, "a1"))._unsafeUnwrap()).toEqual({ runs: 2, profiles: 1, turns: 1 });
        expect(queries).toHaveLength(1);
        expect(queries[0]?.text).toContain("dbos.workflow_status");
        expect(queries[0]?.values).toEqual(["a1", ["PENDING", "ENQUEUED", "DELAYED"]]);
    });

    test("counts the live work of each analysis when no analysis is named", async () => {
        const { pool, queries } = recordingPool({ row: { runs: "0", profiles: "3", turns: "0" } });

        expect((await countLiveDurableWork(pool))._unsafeUnwrap()).toEqual({ runs: 0, profiles: 3, turns: 0 });
        expect(queries[0]?.values[0]).toBeNull();
    });

    test("the run predicate names the running status only, the status that a run with a paused step keeps", async () => {
        const { pool, queries } = recordingPool({ row: { runs: "0", profiles: "0", turns: "0" } });

        (await countLiveDurableWork(pool, "a1"))._unsafeUnwrap();

        expect(queries[0]?.text).toContain("r.status = 'running'");
    });

    test("a turn counts while a live turn workflow holds a thread of the analysis", async () => {
        const { pool, queries } = recordingPool({ row: { runs: "0", profiles: "0", turns: "1" } });

        expect((await countLiveDurableWork(pool, "a1"))._unsafeUnwrap().turns).toBe(1);
        expect(queries[0]?.text).toContain("cortex_analysis_threads t");
        expect(queries[0]?.text).toContain("ws.workflow_uuid = t.active_turn_id");
    });

    test("a failed read is the error, with its cause", async () => {
        const failure = new Error("relation dbos.workflow_status does not exist");
        const { pool } = recordingPool({ failure });

        expect((await countLiveDurableWork(pool, "a1"))._unsafeUnwrapErr()).toBe(failure);
    });
});

describe("countLiveDurableWorkByAnalysis", () => {
    /** A pool that records each query and answers with `rows`, or rejects with `failure`. */
    function groupedPool(answer: { rows: Record<string, string>[] } | { failure: Error }): { pool: Pool; queries: Query[] } {
        const queries: Query[] = [];
        const query = (config: Query): Promise<{ rows: unknown[]; rowCount: number }> => {
            queries.push(config);
            return "failure" in answer ? Promise.reject(answer.failure) : Promise.resolve({ rows: answer.rows, rowCount: answer.rows.length });
        };
        // The function under test calls only `query`, thus a stand-in object with that one method is enough.
        return { pool: { query } as unknown as Pool, queries };
    }

    test("sends one query for the whole list, and maps the rows by analysis id", async () => {
        const { pool, queries } = groupedPool({
            rows: [
                { analysis_id: "a1", runs: "2", profiles: "0", turns: "0" },
                { analysis_id: "a2", runs: "0", profiles: "1", turns: "0" },
                { analysis_id: "a3", runs: "0", profiles: "0", turns: "1" },
            ],
        });

        const counts = (await countLiveDurableWorkByAnalysis(pool, ["a1", "a2", "a3"]))._unsafeUnwrap();

        expect([...counts]).toEqual([
            ["a1", { runs: 2, profiles: 0, turns: 0 }],
            ["a2", { runs: 0, profiles: 1, turns: 0 }],
            ["a3", { runs: 0, profiles: 0, turns: 1 }],
        ]);
        expect(queries).toHaveLength(1);
        expect(queries[0]?.values).toEqual([
            ["a1", "a2", "a3"],
            ["PENDING", "ENQUEUED", "DELAYED"],
        ]);
    });

    test("applies the liveness rule of the one-analysis count", async () => {
        const one = recordingPool({ row: { runs: "0", profiles: "0", turns: "0" } });
        const grouped = groupedPool({ rows: [] });
        (await countLiveDurableWork(one.pool, "a1"))._unsafeUnwrap();
        (await countLiveDurableWorkByAnalysis(grouped.pool, ["a1"]))._unsafeUnwrap();

        const rule = (text: string | undefined): string[] =>
            [
                "r.status = 'running'",
                "ws.workflow_uuid = r.run_id OR ws.workflow_uuid LIKE r.run_id || '-%'",
                "s.data_profile_status = 'running'",
                "ws.workflow_uuid = s.data_profile_workflow_id",
                "t.active_turn_id IS NOT NULL",
                "ws.workflow_uuid = t.active_turn_id",
            ].filter((predicate) => text?.includes(predicate));
        expect(rule(grouped.queries[0]?.text)).toEqual(rule(one.queries[0]?.text));
        expect(rule(one.queries[0]?.text)).toHaveLength(6);
    });

    test("an empty list sends no query", async () => {
        const { pool, queries } = groupedPool({ rows: [] });

        expect((await countLiveDurableWorkByAnalysis(pool, []))._unsafeUnwrap().size).toBe(0);
        expect(queries).toHaveLength(0);
    });

    test("a failed read is the error, with its cause", async () => {
        const failure = new Error("relation dbos.workflow_status does not exist");
        const { pool } = groupedPool({ failure });

        expect((await countLiveDurableWorkByAnalysis(pool, ["a1"]))._unsafeUnwrapErr()).toBe(failure);
    });
});

describe("listLiveRunIds", () => {
    test("sends one query with the liveness rule of the counts, the limit as $1, and the live statuses as $2", async () => {
        const counted = recordingPool({ row: { runs: "0", profiles: "0", turns: "0" } });
        (await countLiveDurableWork(counted.pool, "a1"))._unsafeUnwrap();
        const { pool, queries } = recordingPool({ row: { run_id: "r2" } });

        const ids = (await listLiveRunIds(pool, 200))._unsafeUnwrap();

        expect(ids).toEqual(["r2"]);
        expect(queries).toHaveLength(1);
        const rule = "r.status = 'running'";
        expect(queries[0]?.text).toContain(rule);
        expect(counted.queries[0]?.text).toContain(rule);
        expect(queries[0]?.text).toContain("dbos.workflow_status");
        expect(queries[0]?.text).toContain("LIMIT $1");
        expect(queries[0]?.values).toEqual([200, ["PENDING", "ENQUEUED", "DELAYED"]]);
    });

    test("a failed read is the error, with its cause", async () => {
        const failure = new Error("relation dbos.workflow_status does not exist");
        const { pool } = recordingPool({ failure });

        expect((await listLiveRunIds(pool, 200))._unsafeUnwrapErr()).toBe(failure);
    });
});

describe("listLiveTurns", () => {
    test("gives the turn that a live workflow holds on each thread, with the start of the workflow", async () => {
        const { pool, queries } = recordingPool({ row: { thread_id: "t1", analysis_id: "a1", active_turn_id: "turn-1", created_at: "1790935200000" } });

        const turns = (await listLiveTurns(pool, ["t1", "t2"]))._unsafeUnwrap();

        expect(turns).toEqual([{ turnId: "turn-1", threadId: "t1", analysisId: "a1", startedAt: new Date(1790935200000).toISOString() }]);
        expect(queries).toHaveLength(1);
        expect(queries[0]?.text).toContain("t.active_turn_id IS NOT NULL");
        expect(queries[0]?.text).toContain("ws.workflow_uuid = t.active_turn_id");
        expect(queries[0]?.values).toEqual([
            ["t1", "t2"],
            ["PENDING", "ENQUEUED", "DELAYED"],
        ]);
    });

    test("an empty list sends no query", async () => {
        const { pool, queries } = recordingPool({ row: {} });

        expect((await listLiveTurns(pool, []))._unsafeUnwrap()).toEqual([]);
        expect(queries).toHaveLength(0);
    });

    test("a failed read is the error, with its cause", async () => {
        const failure = new Error("relation dbos.workflow_status does not exist");
        const { pool } = recordingPool({ failure });

        expect((await listLiveTurns(pool, ["t1"]))._unsafeUnwrapErr()).toBe(failure);
    });
});
