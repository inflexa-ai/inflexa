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

    /** A pool that answers the count and row queries used by list mode. */
    function poolReturning(rows: Array<Record<string, unknown>>): Pool {
        return {
            query: async (query: { text: string; values?: unknown[] }) => {
                if (/COUNT\(\*\)/i.test(query.text)) return { rows: [{ total: rows.length }], rowCount: 1 };
                const limit = Number(query.values?.[1] ?? rows.length);
                const offset = Number(query.values?.[2] ?? 0);
                const page = rows.slice(offset, offset + limit);
                return { rows: page, rowCount: page.length };
            },
        } as unknown as Pool;
    }

    /** List runs for the session's analysis, unwrapping to the `{ runs }` variant. */
    async function listRuns(pool: Pool): Promise<Array<Record<string, unknown>>> {
        const { ctx } = makeToolContext();
        const result = (await createInspectRunTool(pool).execute({}, ctx))._unsafeUnwrap();
        return (result as { runs: Array<Record<string, unknown>> }).runs;
    }

    it("derives the analysis id from the Session and lists runs via the injected pool", async () => {
        const fakePool = {
            query: async (query: { text: string }) => (/COUNT\(\*\)/i.test(query.text) ? { rows: [{ total: 0 }], rowCount: 1 } : { rows: [], rowCount: 0 }),
        } as unknown as Pool;

        const tool = createInspectRunTool(fakePool);
        const { ctx } = makeToolContext();
        const result = (await tool.execute({}, ctx))._unsafeUnwrap();

        expect(result).toEqual({ runs: [], total: 0, page: 1, pageSize: 50, hasMore: false });
    });

    it("returns active-first pagination metadata from list mode", async () => {
        const rows = [runRow({ run_id: "run-running", status: "running" }), runRow({ run_id: "run-terminal" })];
        const { ctx } = makeToolContext();
        const result = (await createInspectRunTool(poolReturning(rows)).execute({ page: 2, pageSize: 1 }, ctx))._unsafeUnwrap();

        expect(result).toMatchObject({ total: 2, page: 2, pageSize: 1, hasMore: false });
    });

    it("rejects targeted pagination and list-mode waits in its input contract", () => {
        const tool = createInspectRunTool(poolReturning([]));

        expect(tool.inputSchema.safeParse({ runId: "run-1", page: 1 }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ waitForTerminalSeconds: 1 }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ runId: "run-1", waitForTerminalSeconds: 0 }).success).toBe(false);
        expect(tool.inputSchema.safeParse({ runId: "run-1", waitForTerminalSeconds: 31 }).success).toBe(false);
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
        const { run, steps } = result as { inspectionState: string; run: Record<string, unknown>; steps: Array<Record<string, unknown>> };

        expect((result as { inspectionState: string }).inspectionState).toBe("terminal");
        const dagStep = steps.find((s) => s.stepId === "T1S1");
        const synthesisStep = steps.find((s) => s.stepId === "synthesis");
        expect(dagStep?.summaryPath).toBe("runs/run-1/T1S1/output/summary.md");
        expect(synthesisStep).toBeDefined();
        expect(synthesisStep).not.toHaveProperty("summaryPath");
        // The synthesis output is still reachable — via the run-level path.
        expect(run.synthesisPath).toBe("runs/run-1/synthesis.json");
    });

    it("reports running state and withholds every output path", async () => {
        const pool = poolForRunDetail(runRow({ status: "running", synthesis_status: "produced", completed_at: null }), [stepRow({ status: "completed" })]);
        const { ctx } = makeToolContext();

        const result = (
            await createInspectRunTool(pool, { now: () => Date.parse("2026-01-01T00:00:05.000Z"), wait: async () => {} }).execute({ runId: "run-1" }, ctx)
        )._unsafeUnwrap() as {
            inspectionState: string;
            message: string;
            elapsedMs: number;
            run: Record<string, unknown>;
            steps: Array<Record<string, unknown>>;
        };

        expect(result.inspectionState).toBe("in_progress");
        expect(result.message).toContain("Results are not ready");
        expect(result.elapsedMs).toBe(5_000);
        expect(result.run).toMatchObject({ status: "running", synthesisPath: null });
        expect(result.steps[0]).not.toHaveProperty("summaryPath");
    });

    it("reports suspended and missing runs as explicit success states", async () => {
        const { ctx } = makeToolContext();
        const suspended = (
            await createInspectRunTool(poolForRunDetail(runRow({ status: "suspended_insufficient_funds" }), [])).execute({ runId: "run-1" }, ctx)
        )._unsafeUnwrap();
        expect(suspended).toMatchObject({ inspectionState: "suspended" });

        const missingPool = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
        const missing = (await createInspectRunTool(missingPool).execute({ runId: "missing" }, ctx))._unsafeUnwrap();
        expect(missing).toMatchObject({ inspectionState: "not_found" });
    });

    it("waits until a running run becomes terminal", async () => {
        const rows = [runRow({ status: "running", completed_at: null }), runRow({ status: "completed" })];
        let reads = 0;
        let now = 0;
        const pool = {
            query: async (query: { text: string }) => {
                if (/cortex_step_executions/i.test(query.text)) return { rows: [], rowCount: 0 };
                const row = rows[Math.min(reads++, rows.length - 1)]!;
                return { rows: [row], rowCount: 1 };
            },
        } as unknown as Pool;
        const { ctx } = makeToolContext();

        const result = (
            await createInspectRunTool(pool, {
                now: () => now,
                wait: async (ms) => {
                    now += ms;
                },
            }).execute({ runId: "run-1", waitForTerminalSeconds: 30 }, ctx)
        )._unsafeUnwrap();

        expect(result).toMatchObject({
            inspectionState: "terminal",
            wait: { requestedSeconds: 30, cutoffReached: false },
        });
        expect(reads).toBe(2);
    });

    it("returns in progress when the bounded wait reaches its cutoff", async () => {
        let now = 0;
        const pool = poolForRunDetail(runRow({ status: "running", completed_at: null }), []);
        const { ctx } = makeToolContext();

        const result = (
            await createInspectRunTool(pool, {
                now: () => now,
                wait: async (ms) => {
                    now += ms;
                },
            }).execute({ runId: "run-1", waitForTerminalSeconds: 2 }, ctx)
        )._unsafeUnwrap();

        expect(result).toMatchObject({
            inspectionState: "in_progress",
            wait: { requestedSeconds: 2, cutoffReached: true },
        });
    });

    it("propagates cancellation from a bounded wait", async () => {
        const aborted = new DOMException("aborted", "AbortError");
        const pool = poolForRunDetail(runRow({ status: "running", completed_at: null }), []);
        const { ctx } = makeToolContext();

        await expect(
            createInspectRunTool(pool, {
                now: () => 0,
                wait: async () => {
                    throw aborted;
                },
            }).execute({ runId: "run-1", waitForTerminalSeconds: 2 }, ctx),
        ).rejects.toBe(aborted);
    });

    it("prevents a workflow from waiting for its own run", async () => {
        let waits = 0;
        const pool = poolForRunDetail(runRow({ status: "running", completed_at: null }), []);
        const { ctx: baseCtx } = makeToolContext();
        const ctx = { ...baseCtx, session: { ...baseCtx.session, runFrame: { runId: "run-1" } } };

        const result = (
            await createInspectRunTool(pool, {
                now: () => 0,
                wait: async () => {
                    waits++;
                },
            }).execute({ runId: "run-1", waitForTerminalSeconds: 30 }, ctx)
        )._unsafeUnwrap();

        expect(result).toMatchObject({
            inspectionState: "in_progress",
            selfWaitPrevented: true,
            wait: { requestedSeconds: 30, cutoffReached: false },
        });
        expect(waits).toBe(0);
    });
});
