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

    /** A raw `cortex_step_executions` row as `pg` hands it back — completed by default. */
    function stepRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            run_id: "run-1",
            step_id: "T1S1",
            analysis_id: "analysis-001",
            wave: 0,
            agent_id: "scientific-executor",
            status: "completed",
            started_at: "2026-01-01T00:00:00.000Z",
            completed_at: "2026-01-01T00:01:00.000Z",
            duration_ms: 60000,
            error: null,
            attempts: 1,
            last_error_class: null,
            finish_reason: "stop",
            hit_max_steps: 0,
            blocked_reason: null,
            sandbox_ref: null,
            exec_id: null,
            child_workflow_id: null,
            ...overrides,
        };
    }

    /** A pool that answers the run lookup and the step lookup separately, keyed by the target table. */
    function poolForRunDetail(run: Record<string, unknown>, steps: Array<Record<string, unknown>>): Pool {
        return {
            query: async (q: { text: string }) => {
                if (/cortex_step_executions/i.test(q.text)) return { rows: steps, rowCount: steps.length };
                return { rows: [run], rowCount: 1 };
            },
        } as unknown as Pool;
    }

    it("emits a per-step summaryPath for a completed DAG step but never for the run-phase synthesis row", async () => {
        const pool = poolForRunDetail(runRow({ run_id: "run-1", synthesis_status: "produced" }), [
            stepRow({ step_id: "T1S1", status: "completed" }),
            // The reserved run-phase row: completed, but its product is the run-level
            // synthesis.json (surfaced as synthesisPath), not a {stepId}/output/summary.md.
            stepRow({ step_id: "synthesis", agent_id: "run-synthesizer", wave: 1, status: "completed" }),
        ]);
        const { ctx } = makeToolContext();

        const result = (await createInspectRunTool(pool).execute({ runId: "run-1" }, ctx))._unsafeUnwrap();
        const { run, steps } = result as { run: Record<string, unknown>; steps: Array<Record<string, unknown>> };

        const dagStep = steps.find((s) => s.stepId === "T1S1");
        const synthesisStep = steps.find((s) => s.stepId === "synthesis");
        expect(dagStep?.summaryPath).toBe("runs/run-1/T1S1/output/summary.md");
        expect(synthesisStep).toBeDefined();
        expect(synthesisStep).not.toHaveProperty("summaryPath");
        // The synthesis output is still reachable — via the run-level path.
        expect(run.synthesisPath).toBe("runs/run-1/synthesis.json");
    });
});
