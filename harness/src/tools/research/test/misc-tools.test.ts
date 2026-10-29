import { afterEach, describe, expect, it } from "bun:test";

/** A `fetch` test double: the callable plus the `preconnect` member that `typeof fetch` carries. */
function fetchDouble(run: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
    return Object.assign(run, { preconnect: fetch.preconnect });
}

import type { Querier } from "../../../state/db.js";
import { makeToolContext } from "../../__fixtures__/tool-context.js";
import { readFixture } from "../../lib/__fixtures__/fixture-runner.js";
import { resolveLibraryIdTool } from "../context7-docs.js";
import { createInspectRunTool, type InspectRunQuerier } from "../inspect-run.js";
import { presentAt } from "../../../lib/present.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(response: () => Response): void {
    globalThis.fetch = fetchDouble(() => Promise.resolve(response()));
}

describe("resolveLibraryId (remaining-leaf family)", () => {
    it("returns a populated data variant for a resolved library", async () => {
        // The body is the golden fixture, thus the mock cannot invent a field that
        // the provider does not serve.
        stubFetch(
            () =>
                new Response(JSON.stringify(readFixture("context7", "01-search-scanpy.json")), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
        );

        const { ctx } = makeToolContext();
        const result = (await resolveLibraryIdTool.execute({ libraryName: "scanpy", query: "differential expression" }, ctx))._unsafeUnwrap();

        expect(result.found).toBe(true);
        if (result.found) {
            expect(result.libraryId).toBe("/scverse/scanpy");
            expect(result.name).toBe("Scanpy");
        }
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
            mandate_id: null,
            plan_id: "plan-1",
            ...overrides,
        };
    }

    /** A pool that answers the count and row queries used by list mode. */
    function poolReturning(rows: Array<Record<string, unknown>>): InspectRunQuerier {
        return {
            query: (queryOrConfig, values) => {
                const text = typeof queryOrConfig === "string" ? queryOrConfig : queryOrConfig.text;
                if (text.includes("COUNT(*)")) return Promise.resolve({ rows: [{ total: rows.length }], rowCount: 1 });
                const limit = Number(values?.[1] ?? rows.length);
                const offset = Number(values?.[2] ?? 0);
                const page = rows.slice(offset, offset + limit);
                return Promise.resolve({ rows: page, rowCount: page.length });
            },
        };
    }

    /** List runs for the session's analysis, unwrapping to the `{ runs }` variant. */
    async function listRuns(pool: InspectRunQuerier): Promise<Array<Record<string, unknown>>> {
        const { ctx } = makeToolContext();
        const result = (await createInspectRunTool(pool).execute({}, ctx))._unsafeUnwrap();
        if (!("runs" in result)) throw new Error("expected the runs variant");
        return result.runs;
    }

    it("derives the analysis id from the Session and lists runs via the injected pool", async () => {
        const fakePool: InspectRunQuerier = {
            query: (queryOrConfig) => {
                const text = typeof queryOrConfig === "string" ? queryOrConfig : queryOrConfig.text;
                return Promise.resolve(text.includes("COUNT(*)") ? { rows: [{ total: 0 }], rowCount: 1 } : { rows: [], rowCount: 0 });
            },
        };

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

    /** A raw `cortex_paused_work` row as `pg` hands it back: a step of `run-1` that waits in `paused` by default. */
    function pauseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            workflow_id: "run-1-T1S1",
            work_id: "run-1",
            work_kind: "run",
            analysis_id: "analysis-001",
            thread_id: null,
            state: "paused",
            cause: { kind: "host", reason: "payment_required" },
            attempt: 0,
            retry_at: null,
            topic: "pause:p-1",
            paused_at: new Date("2026-01-01T00:00:03.000Z"),
            run_session: null,
            ...overrides,
        };
    }

    /** A pool that answers the run lookup, the step lookup, and the pause lookup separately, keyed by the target table. */
    function poolForRunDetail(
        run: Record<string, unknown>,
        steps: Array<Record<string, unknown>>,
        pauses: Array<Record<string, unknown>> = [],
    ): InspectRunQuerier {
        return {
            query: (queryOrConfig) => {
                const text = typeof queryOrConfig === "string" ? queryOrConfig : queryOrConfig.text;
                if (text.includes("cortex_step_executions")) return Promise.resolve({ rows: steps, rowCount: steps.length });
                if (text.includes("cortex_paused_work")) return Promise.resolve({ rows: pauses, rowCount: pauses.length });
                return Promise.resolve({ rows: [run], rowCount: 1 });
            },
        };
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
        if (!("steps" in result)) throw new Error("expected the terminal inspection variant");
        const { run, steps } = result;

        expect(result.inspectionState).toBe("terminal");
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
        )._unsafeUnwrap();
        if (!("elapsedMs" in result)) throw new Error("expected the running-state variant");

        expect(result.inspectionState).toBe("in_progress");
        expect(result.message).toContain("Results are not ready");
        expect(result.elapsedMs).toBe(5_000);
        expect(result.run).toMatchObject({ status: "running", synthesisPath: null });
        expect(result.steps[0]).not.toHaveProperty("summaryPath");
    });

    it("reports a running run with a waiting workflow as paused, with the state and the cause of each pause and no output path", async () => {
        const { ctx } = makeToolContext();
        const pool = poolForRunDetail(
            runRow({ status: "running", synthesis_status: "produced", completed_at: null }),
            [stepRow({ step_id: "T1S1", status: "completed" }), stepRow({ step_id: "T1S2", status: "running", completed_at: null })],
            [
                pauseRow({ workflow_id: "run-1-T1S2" }),
                pauseRow({
                    workflow_id: "run-1-T1S3",
                    state: "retrying",
                    cause: { kind: "outage" },
                    attempt: 1,
                    retry_at: new Date("2026-01-01T00:10:00.000Z"),
                }),
            ],
        );

        const paused = (await createInspectRunTool(pool).execute({ runId: "run-1" }, ctx))._unsafeUnwrap();
        if (!("pauses" in paused)) throw new Error("expected the paused inspection variant");

        expect(paused.inspectionState).toBe("paused");
        expect(paused.pauses).toEqual([
            { state: "paused", cause: { kind: "host", reason: "payment_required" }, attempt: 0, retryAt: undefined },
            { state: "retrying", cause: { kind: "outage" }, attempt: 1, retryAt: "2026-01-01T00:10:00.000Z" },
        ]);
        expect(paused.message).toContain("The user can resume the run or stop it.");
        expect(paused.run).toMatchObject({ status: "running", synthesisPath: null });
        expect(paused.steps.map((step) => step.summaryPath)).toEqual([undefined, undefined]);
    });

    it("returns at once from a wait on a run that waits in a pause", async () => {
        let waits = 0;
        const pool = poolForRunDetail(runRow({ status: "running", completed_at: null }), [], [pauseRow()]);
        const { ctx } = makeToolContext();

        const result = (
            await createInspectRunTool(pool, {
                now: () => 0,
                wait: () => {
                    waits++;

                    return Promise.resolve();
                },
            }).execute({ runId: "run-1", waitForTerminalSeconds: 30 }, ctx)
        )._unsafeUnwrap();

        expect(result).toMatchObject({ inspectionState: "paused", wait: { requestedSeconds: 30, cutoffReached: false } });
        expect(waits).toBe(0);
    });

    it("ends a wait when a workflow of the running run pauses", async () => {
        let pauseReads = 0;
        let now = 0;
        const pool: InspectRunQuerier = {
            query: (queryOrConfig) => {
                const text = typeof queryOrConfig === "string" ? queryOrConfig : queryOrConfig.text;
                if (text.includes("cortex_step_executions")) return Promise.resolve({ rows: [], rowCount: 0 });
                if (text.includes("cortex_paused_work")) {
                    pauseReads += 1;
                    const rows = pauseReads === 1 ? [] : [pauseRow()];
                    return Promise.resolve({ rows, rowCount: rows.length });
                }
                return Promise.resolve({ rows: [runRow({ status: "running", completed_at: null })], rowCount: 1 });
            },
        };
        const { ctx } = makeToolContext();

        const result = (
            await createInspectRunTool(pool, {
                now: () => now,
                wait: (ms) => {
                    now += ms;

                    return Promise.resolve();
                },
            }).execute({ runId: "run-1", waitForTerminalSeconds: 30 }, ctx)
        )._unsafeUnwrap();

        expect(result).toMatchObject({ inspectionState: "paused", wait: { requestedSeconds: 30, cutoffReached: false } });
        expect(pauseReads).toBe(2);
        expect(now).toBeLessThan(30_000);
    });

    it("reports a missing run as an explicit success state", async () => {
        const { ctx } = makeToolContext();
        const missingPool: Querier = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) };
        const missing = (await createInspectRunTool(missingPool).execute({ runId: "missing" }, ctx))._unsafeUnwrap();
        expect(missing).toMatchObject({ inspectionState: "not_found" });
    });

    it("waits until a running run becomes terminal", async () => {
        const rows = [runRow({ status: "running", completed_at: null }), runRow({ status: "completed" })];
        let reads = 0;
        let now = 0;
        const pool: InspectRunQuerier = {
            query: (queryOrConfig) => {
                const text = typeof queryOrConfig === "string" ? queryOrConfig : queryOrConfig.text;
                if (text.includes("cortex_step_executions") || text.includes("cortex_paused_work")) return Promise.resolve({ rows: [], rowCount: 0 });
                const row = presentAt(rows, Math.min(reads++, rows.length - 1));
                return Promise.resolve({ rows: [row], rowCount: 1 });
            },
        };
        const { ctx } = makeToolContext();

        const result = (
            await createInspectRunTool(pool, {
                now: () => now,
                wait: (ms) => {
                    now += ms;

                    return Promise.resolve();
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
                wait: (ms) => {
                    now += ms;

                    return Promise.resolve();
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
                wait: () => {
                    return Promise.reject(aborted);
                },
            }).execute({ runId: "run-1", waitForTerminalSeconds: 2 }, ctx),
        ).rejects.toBe(aborted);
    });
});
