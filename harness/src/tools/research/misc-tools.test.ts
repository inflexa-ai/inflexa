import { afterEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { resolveLibraryIdTool } from "./context7-docs.js";
import { createInspectRunTool } from "./inspect-run.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(response: () => Response): void {
    globalThis.fetch = (async () => response()) as unknown as typeof fetch;
}

describe("resolveLibraryId (remaining-leaf family)", () => {
    it("returns a populated data variant for a resolved library", async () => {
        stubFetch(
            () =>
                new Response(
                    JSON.stringify({
                        results: [
                            {
                                id: "/scverse/scanpy",
                                name: "scanpy",
                                description: "Single-cell analysis in Python",
                            },
                        ],
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
        );

        const { ctx } = makeToolContext();
        const result = (await resolveLibraryIdTool.execute({ libraryName: "scanpy", query: "differential expression" }, ctx))._unsafeUnwrap();

        expect(result.found).toBe(true);
        if (result.found) expect(result.libraryId).toBe("/scverse/scanpy");
    });

    it("returns the found:false variant when no library matches", async () => {
        stubFetch(
            () =>
                new Response(JSON.stringify({ results: [] }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
        );

        const { ctx } = makeToolContext();
        const result = (await resolveLibraryIdTool.execute({ libraryName: "nonexistent-lib", query: "anything" }, ctx))._unsafeUnwrap();

        expect(result.found).toBe(false);
    });

    it("throws on an upstream 5xx failure", async () => {
        stubFetch(() => new Response("upstream down", { status: 500 }));

        const { ctx } = makeToolContext();
        await expect(resolveLibraryIdTool.execute({ libraryName: "scanpy", query: "anything" }, ctx)).rejects.toThrow();
    });
});

describe("inspectRun (dependency-bearing factory)", () => {
    /** A raw `cortex_runs` row as `pg` hands it back (snake_case columns), completed by default. */
    function runRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            run_id: "run-1",
            analysis_id: "analysis-001",
            thread_id: null,
            workflow_name: "executeAnalysis",
            status: "completed",
            started_at: "2026-01-01T00:00:00.000Z",
            completed_at: "2026-01-01T00:05:00.000Z",
            error: null,
            synthesis_status: null,
            synthesis_reason: null,
            parts: null,
            mandate_jti: null,
            mandate_expires_at: null,
            plan_id: "plan-1",
            ...overrides,
        };
    }

    /** A pool whose every query resolves to the same canned rowset — enough for the list path. */
    function poolReturning(rows: Array<Record<string, unknown>>): Pool {
        return { query: async () => ({ rows, rowCount: rows.length }) } as unknown as Pool;
    }

    /** List runs for the session's analysis, unwrapping to the `{ runs }` variant. */
    async function listRuns(pool: Pool): Promise<Array<Record<string, unknown>>> {
        const { ctx } = makeToolContext();
        const result = (await createInspectRunTool(pool).execute({}, ctx))._unsafeUnwrap();
        return (result as { runs: Array<Record<string, unknown>> }).runs;
    }

    it("derives the analysis id from the Session and lists runs via the injected pool", async () => {
        const fakePool = {
            query: async () => ({ rows: [] }),
        } as unknown as Pool;

        const tool = createInspectRunTool(fakePool);
        const { ctx } = makeToolContext();
        const result = (await tool.execute({}, ctx))._unsafeUnwrap();

        expect(result).toEqual({ message: "No runs found for this analysis." });
    });

    it("advertises synthesisPath for a run whose synthesis was produced", async () => {
        const [run] = await listRuns(poolReturning([runRow({ run_id: "run-produced", synthesis_status: "produced" })]));

        expect(run).toMatchObject({
            runId: "run-produced",
            synthesisStatus: "produced",
            synthesisPath: "runs/run-produced/synthesis.json",
        });
    });

    it("gives no synthesisPath when synthesis was skipped, even on a completed run — and surfaces the reason", async () => {
        const [run] = await listRuns(
            poolReturning([
                runRow({
                    run_id: "run-skipped",
                    status: "completed",
                    synthesis_status: "skipped_blocker",
                    synthesis_reason: "a required upstream step was blocked",
                }),
            ]),
        );

        expect(run).toMatchObject({
            runId: "run-skipped",
            status: "completed",
            synthesisStatus: "skipped_blocker",
            synthesisPath: null,
            synthesisReason: "a required upstream step was blocked",
        });
    });

    it("gives no synthesisPath on a legacy completed run whose synthesis outcome is unknown", async () => {
        const [run] = await listRuns(poolReturning([runRow({ run_id: "run-legacy", status: "completed", synthesis_status: null })]));

        expect(run).toMatchObject({ runId: "run-legacy", status: "completed", synthesisStatus: null, synthesisPath: null });
        // A null reason drops out of the payload rather than reporting a bare null.
        expect(run).not.toHaveProperty("synthesisReason");
    });
});
