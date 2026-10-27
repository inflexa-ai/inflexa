/**
 * Fakes only, no live DBOS: the engine cancel enters through the injected
 * `cancelWorkflows` seam, and the ledgers are an in-memory pool that answers
 * the canceler's queries and applies the conditional-write rules the real
 * `markRunCanceledIfActive` enforces — so the race assertions exercise state,
 * not stubs of it.
 */

import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import { Pool } from "pg";

import { captureMetrics } from "../../__tests__/setup/metrics.js";
import type { AgentSession } from "../../auth/types.js";
import type { RunCharge, RunChargeOutcome } from "../../billing/run-charge.js";
import type { Logger, LogFields } from "../../lib/logger.js";
import type { RunProvenanceEvent } from "../../provenance/seam.js";
import type { RunAuthorizer } from "../run-authorizer.js";
import type { RecordedRunEnd } from "../run-end-record.js";
import { createRunCanceler as createRunCancelerWithReads, UnknownRunError, type RunCancelerDeps } from "../run-canceler.js";

/** The read of the recorded run end gives `null` unless a test binds its own, so a test with no record keeps its meaning. */
function createRunCanceler(deps: RunCancelerDeps) {
    return createRunCancelerWithReads({ readRecordedRunEnd: () => Promise.resolve(null), ...deps });
}

const session: AgentSession = {
    identity: { user: "tester" },
    scope: { kind: "analysis", analysisId: "analysis-1" },
    provenance: { agentId: "cancel-route", callPath: ["cancel-route"] },
    auth: {},
};

type Row = Record<string, unknown>;

function runRow(overrides: Row = {}): Row {
    return {
        run_id: "run-1",
        analysis_id: "analysis-1",
        thread_id: null,
        workflow_name: "executeAnalysis",
        status: "running",
        started_at: "2026-08-12T00:00:00.000Z",
        completed_at: null,
        error: null,
        synthesis_status: null,
        synthesis_reason: null,
        parts: null,
        mandate_jti: null,
        mandate_expires_at: null,
        plan_id: null,
        ...overrides,
    };
}

function stepRow(stepId: string, childWorkflowId: string | null, completedAt: string | null = null): Row {
    return {
        run_id: "run-1",
        step_id: stepId,
        analysis_id: "analysis-1",
        wave: 0,
        agent_id: "test-agent",
        status: completedAt === null ? "running" : "completed",
        started_at: "2026-08-12T00:00:01.000Z",
        completed_at: completedAt,
        duration_ms: null,
        error: null,
        attempts: 1,
        last_error_class: null,
        finish_reason: null,
        hit_max_steps: false,
        blocked_reason: null,
        sandbox_ref: null,
        exec_id: null,
        child_workflow_id: childWorkflowId,
    };
}

function pendingRow(stepId: string): Row {
    return { ...stepRow(stepId, null), status: "pending", started_at: null };
}

type FakeDb = {
    pool: Pool;
    /**
     * `ledger` is the step table the two step writes act on; it starts as a copy of the last read batch. `pauses` is
     * the table of the waiting workflows, keyed by `work_id`.
     */
    state: { run: Row | null; swept: number; ledger: Row[]; pauses: Row[] };
};

/** Successive `queryStepsByRun` reads consume `stepBatches`; the last repeats. */
function fakeDb(
    run: Row | null,
    stepBatches: Row[][] = [[]],
    opts: { sweepFails?: boolean; settleFails?: boolean; failStepReadsAfter?: number; runWriteFails?: boolean; pauses?: Row[] } = {},
): FakeDb {
    const state = {
        run,
        swept: 0,
        ledger: (stepBatches[stepBatches.length - 1] ?? []).map((row) => ({ ...row })),
        pauses: (opts.pauses ?? []).map((row) => ({ ...row })),
    };
    let stepReads = 0;
    const pool = Object.assign(new Pool(), {
        query: (config: string | { text: string; values?: unknown[] }, params?: unknown[]) => {
            const { text, values } = typeof config === "string" ? { text: config, values: params } : config;
            if (text.startsWith("DELETE FROM cortex_paused_work WHERE work_id = $1")) {
                const before = state.pauses.length;
                state.pauses = state.pauses.filter((row) => row.work_id !== values?.[0]);
                return Promise.resolve({ rowCount: before - state.pauses.length });
            }
            if (text.includes("UPDATE cortex_step_executions")) {
                if (text.includes("SET status = 'skipped'")) {
                    if (opts.sweepFails) return Promise.reject(new Error("sweep exploded"));
                    state.swept += 1;
                    for (const row of state.ledger) if (row.status === "pending") Object.assign(row, { status: "skipped", completed_at: values?.[1] });
                    return Promise.resolve({ rowCount: 0 });
                }
                if (text.includes("SET status = 'canceled'") && text.includes("status = 'running'")) {
                    if (opts.settleFails) return Promise.reject(new Error("settle exploded"));
                    // The statement's guard: only a row that is still running changes.
                    for (const row of state.ledger) {
                        if (row.status !== "running") continue;
                        const finishedAt = values?.[1];
                        const durationMs =
                            typeof row.started_at === "string" && typeof finishedAt === "string" ? Date.parse(finishedAt) - Date.parse(row.started_at) : null;
                        Object.assign(row, { status: "canceled", completed_at: finishedAt, duration_ms: durationMs, error: values?.[2] });
                    }
                    return Promise.resolve({ rowCount: 0 });
                }
                return Promise.reject(new Error(`unexpected step write: ${text}`));
            }
            if (text.includes("FROM cortex_runs"))
                return Promise.resolve({ rows: state.run === null ? [] : [state.run], rowCount: state.run === null ? 0 : 1 });
            if (text.includes("SET status = $1")) {
                if (opts.runWriteFails) return Promise.reject(new Error("run write exploded"));
                if (state.run === null || state.run.status !== "running") return Promise.resolve({ rowCount: 0 });
                state.run = { ...state.run, status: values?.[0], completed_at: values?.[1], error: values?.[2] };
                return Promise.resolve({ rowCount: 1 });
            }
            if (text.includes("SET status = 'canceled'")) {
                if (opts.runWriteFails) return Promise.reject(new Error("run write exploded"));
                const active = state.run !== null && state.run.status === "running";
                if (!active || state.run === null) return Promise.resolve({ rowCount: 0 });
                state.run = { ...state.run, status: "canceled", completed_at: values?.[1], error: values?.[2] };
                return Promise.resolve({ rowCount: 1 });
            }
            if (text.includes("FROM cortex_step_executions")) {
                if (opts.failStepReadsAfter !== undefined && stepReads >= opts.failStepReadsAfter) return Promise.reject(new Error("step read exploded"));
                const batch = stepBatches[Math.min(stepReads, stepBatches.length - 1)] ?? [];
                stepReads += 1;
                return Promise.resolve({ rows: batch });
            }
            return Promise.reject(new Error(`unexpected query: ${text}`));
        },
    });
    return { pool, state };
}

function recordingCharge(opts: { fail?: boolean } = {}): {
    charge: RunCharge;
    closes: Array<{ analysisId: string; runId: string; outcome: RunChargeOutcome }>;
} {
    const closes: Array<{ analysisId: string; runId: string; outcome: RunChargeOutcome }> = [];
    const charge: RunCharge = {
        open: () => {
            throw new Error("open is not reached by the canceler");
        },
        close: ({ analysisId, runId, outcome }) => {
            if (opts.fail) return errAsync({ reason: "close exploded" });
            closes.push({ analysisId, runId, outcome });
            return okAsync(undefined);
        },
    };
    return { charge, closes };
}

function recordingAuthorizer(): { authorizer: RunAuthorizer; revoked: Array<{ jti: string; reason: string }> } {
    const revoked: Array<{ jti: string; reason: string }> = [];
    const authorizer: RunAuthorizer = {
        authorize: () => {
            throw new Error("authorize is not reached by the canceler");
        },
        revoke: () => {
            throw new Error("terminal-path revoke is not reached by the canceler");
        },
        revokeByJti: ({ jti }, reason) => {
            revoked.push({ jti, reason });
            return okAsync(undefined);
        },
    };
    return { authorizer, revoked };
}

function recordingCancel(onCall?: (ids: readonly string[]) => void): { cancelWorkflows: (ids: readonly string[]) => Promise<void>; cancelled: string[][] } {
    const cancelled: string[][] = [];
    return {
        cancelled,
        cancelWorkflows: (ids) => {
            cancelled.push([...ids]);
            onCall?.(ids);

            return Promise.resolve();
        },
    };
}

describe("createRunCanceler", () => {
    it("short-circuits an already-terminal run with no engine call and no charge close", async () => {
        const db = fakeDb(runRow({ status: "completed", completed_at: "2026-08-12T01:00:00.000Z" }));
        const { charge, closes } = recordingCharge();
        const { authorizer, revoked } = recordingAuthorizer();
        const { cancelWorkflows, cancelled } = recordingCancel();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows });

        const result = await canceler.cancel("run-1", session);

        expect(result).toEqual({
            runId: "run-1",
            workflowId: "run-1",
            outcome: "already_terminal",
            finalStatus: "completed",
            converged: { steps: false, charge: false, mandate: false },
        });
        expect(cancelled).toEqual([]);
        expect(closes).toEqual([]);
        expect(revoked).toEqual([]);
        expect(db.state.swept).toBe(0);
    });

    it("short-circuits a failed run with the reason of a host as already terminal", async () => {
        const db = fakeDb(runRow({ status: "failed", completed_at: "2026-08-12T01:00:00.000Z", error: "budget_exceeded" }));
        const { charge, closes } = recordingCharge();
        const { authorizer, revoked } = recordingAuthorizer();
        const { cancelWorkflows, cancelled } = recordingCancel();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows });

        const result = await canceler.cancel("run-1", session);

        expect(result).toEqual({
            runId: "run-1",
            workflowId: "run-1",
            outcome: "already_terminal",
            finalStatus: "failed",
            converged: { steps: false, charge: false, mandate: false },
        });
        expect(cancelled).toEqual([]);
        expect(closes).toEqual([]);
        expect(revoked).toEqual([]);
    });

    it("converges a running run: engine cancel with children, conditional row write, sweep, charge close, revoke", async () => {
        // One incomplete child is cancelled beside the parent; the completed child is not re-cancelled.
        const steps = [stepRow("s1", "wf-child-1"), stepRow("s2", "wf-child-2", "2026-08-12T00:30:00.000Z"), stepRow("s3", null)];
        const db = fakeDb(runRow({ mandate_jti: "jti-1", mandate_expires_at: "2026-08-13T00:00:00.000Z" }), [steps]);
        const { charge, closes } = recordingCharge();
        const { authorizer, revoked } = recordingAuthorizer();
        const { cancelWorkflows, cancelled } = recordingCancel();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows });

        const result = await canceler.cancel("run-1", session);

        expect(result).toEqual({
            runId: "run-1",
            workflowId: "run-1",
            outcome: "canceled",
            finalStatus: "canceled",
            converged: { steps: true, charge: true, mandate: true },
        });
        expect(cancelled).toEqual([["run-1", "wf-child-1"]]);
        expect(db.state.run?.status).toBe("canceled");
        expect(db.state.run?.error).toBe("external_cancel");
        expect(db.state.run?.completed_at).not.toBeNull();
        expect(db.state.swept).toBe(1);
        expect(closes).toEqual([{ analysisId: "analysis-1", runId: "run-1", outcome: { kind: "canceled" } }]);
        expect(revoked).toEqual([{ jti: "jti-1", reason: "external_cancel" }]);
    });

    it("clears each row of a pause of the run after the engine cancel, and keeps the rows of other work", async () => {
        const pause = (workflowId: string, workId: string): Row => ({ workflow_id: workflowId, work_id: workId, state: "paused" });
        const db = fakeDb(runRow(), [[stepRow("s1", "wf-child-1"), stepRow("s2", "wf-child-2")]], {
            pauses: [pause("wf-child-1", "run-1"), pause("wf-child-2", "run-1"), pause("wf-other", "run-2")],
        });
        const { charge, closes } = recordingCharge();
        const { authorizer } = recordingAuthorizer();
        // The engine cancel ends each wait, thus the rows of the run still exist when it runs.
        const pausesAtCancel: unknown[][] = [];
        const { cancelWorkflows } = recordingCancel(() => pausesAtCancel.push(db.state.pauses.map((row) => row.workflow_id)));
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows });

        const result = await canceler.cancel("run-1", session);

        expect(result.finalStatus).toBe("canceled");
        expect(pausesAtCancel).toEqual([["wf-child-1", "wf-child-2", "wf-other"]]);
        expect(db.state.pauses.map((row) => row.workflow_id)).toEqual(["wf-other"]);
        expect(closes).toEqual([{ analysisId: "analysis-1", runId: "run-1", outcome: { kind: "canceled" } }]);
    });

    it("cancels a child whose workflow id commits only after the parent cancel", async () => {
        const db = fakeDb(runRow(), [[], [stepRow("s1", "wf-late-1")]]);
        const { charge } = recordingCharge();
        const { authorizer } = recordingAuthorizer();
        const { cancelWorkflows, cancelled } = recordingCancel();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows });

        const result = await canceler.cancel("run-1", session);

        expect(cancelled).toEqual([["run-1"], ["wf-late-1"]]);
        expect(result.outcome).toBe("canceled");
        expect(result.finalStatus).toBe("canceled");
    });

    it("still revokes the mandate when the charge close gives an err, and resolves with converged.charge false", async () => {
        const db = fakeDb(runRow({ mandate_jti: "jti-1" }));
        const { charge } = recordingCharge({ fail: true });
        const { authorizer, revoked } = recordingAuthorizer();
        const { cancelWorkflows } = recordingCancel();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows });

        const result = await canceler.cancel("run-1", session);

        expect(result.converged).toEqual({ steps: true, charge: false, mandate: true });
        expect(result.finalStatus).toBe("canceled");
        expect(revoked).toEqual([{ jti: "jti-1", reason: "external_cancel" }]);
    });

    it("skips the revoke for a row with no mandate jti and reports mandate converged vacuously", async () => {
        const db = fakeDb(runRow());
        const { charge } = recordingCharge();
        const { authorizer, revoked } = recordingAuthorizer();
        const { cancelWorkflows } = recordingCancel();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows });

        const result = await canceler.cancel("run-1", session);

        expect(revoked).toEqual([]);
        // Vacuously true: nothing to revoke, so a host alerts on any false flag uniformly.
        expect(result.converged.mandate).toBe(true);
    });

    it("reports the run's own terminal status when it completes concurrently with the cancel", async () => {
        // The run completes while the engine cancel is in flight: the conditional
        // write must refuse the clobber and the result must report the truth.
        const db = fakeDb(runRow());
        const { cancelWorkflows } = recordingCancel(() => {
            if (db.state.run === null) throw new Error("the run row exists");
            db.state.run = { ...db.state.run, status: "completed", completed_at: "2026-08-12T02:00:00.000Z" };
        });
        const { charge } = recordingCharge();
        const { authorizer } = recordingAuthorizer();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows });

        const result = await canceler.cancel("run-1", session);

        expect(result.outcome).toBe("canceled");
        expect(result.finalStatus).toBe("completed");
        expect(db.state.run?.status).toBe("completed");
        expect(db.state.run?.error).toBeNull();
        // The sweep is still safe: it touches only rows a completed run no longer has pending.
        expect(db.state.swept).toBe(1);
        expect(result.converged.steps).toBe(true);
    });

    it("closes no charge and revokes no mandate when the body won the row, and reports both converged", async () => {
        const db = fakeDb(runRow({ mandate_jti: "jti-1" }), [[pendingRow("waiting")]]);
        const { cancelWorkflows } = recordingCancel(() => {
            if (db.state.run === null) throw new Error("the run row exists");
            db.state.run = { ...db.state.run, status: "completed", completed_at: "2026-08-12T02:00:00.000Z" };
        });
        const { charge, closes } = recordingCharge();
        const { authorizer, revoked } = recordingAuthorizer();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows });

        const result = await canceler.cancel("run-1", session);

        expect(result.finalStatus).toBe("completed");
        expect(db.state.run?.status).toBe("completed");
        expect(db.state.ledger.find((row) => row.step_id === "waiting")?.status).toBe("skipped");
        expect(closes).toEqual([]);
        expect(revoked).toEqual([]);
        expect(result.converged).toEqual({ steps: true, charge: true, mandate: true });
    });

    it("closes no charge and revokes no mandate when the terminal write fails, and resolves with both flags false", async () => {
        const db = fakeDb(runRow({ mandate_jti: "jti-1" }), [[stepRow("cut", "wf-child-1"), pendingRow("waiting")]], { runWriteFails: true });
        const { charge, closes } = recordingCharge();
        const { authorizer, revoked } = recordingAuthorizer();
        const { cancelWorkflows } = recordingCancel();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows });

        const result = await canceler.cancel("run-1", session);

        expect(result.outcome).toBe("canceled");
        expect(result.finalStatus).toBe("running");
        expect(db.state.run?.status).toBe("running");
        expect(db.state.ledger.find((row) => row.step_id === "cut")?.status).toBe("canceled");
        expect(db.state.ledger.find((row) => row.step_id === "waiting")?.status).toBe("skipped");
        expect(closes).toEqual([]);
        expect(revoked).toEqual([]);
        expect(result.converged).toEqual({ steps: true, charge: false, mandate: false });
    });

    it("isolates a sweep failure from the phases after it", async () => {
        const db = fakeDb(runRow({ mandate_jti: "jti-1" }), [[]], { sweepFails: true });
        const { charge, closes } = recordingCharge();
        const { authorizer, revoked } = recordingAuthorizer();
        const { cancelWorkflows } = recordingCancel();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows });

        const result = await canceler.cancel("run-1", session);

        expect(result.converged).toEqual({ steps: false, charge: true, mandate: true });
        expect(closes).toHaveLength(1);
        expect(revoked).toHaveLength(1);
    });

    it("settles a step cut mid-flight as canceled and sweeps a pending step to skipped", async () => {
        const steps = [stepRow("cut", "wf-child-1"), pendingRow("waiting")];
        const db = fakeDb(runRow(), [steps]);
        const { charge } = recordingCharge();
        const { authorizer } = recordingAuthorizer();
        const { cancelWorkflows } = recordingCancel();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows });

        const result = await canceler.cancel("run-1", session);

        const cut = db.state.ledger.find((row) => row.step_id === "cut");
        expect(cut?.status).toBe("canceled");
        expect(cut?.error).toBe("external_cancel");
        expect(cut?.completed_at).not.toBeNull();
        expect(cut?.duration_ms).toBeGreaterThan(0);
        expect(db.state.ledger.find((row) => row.step_id === "waiting")?.status).toBe("skipped");
        expect(result.converged.steps).toBe(true);
    });

    it("keeps the status of a step that a child settled after the engine cancel", async () => {
        const steps = [stepRow("done-first", "wf-child-1"), stepRow("cut", "wf-child-2")];
        const db = fakeDb(runRow(), [steps]);
        const { charge } = recordingCharge();
        const { authorizer } = recordingAuthorizer();
        const { cancelWorkflows } = recordingCancel(() => {
            const child = db.state.ledger.find((row) => row.step_id === "done-first");
            if (!child) throw new Error("the child row exists");
            Object.assign(child, { status: "completed", completed_at: "2026-08-12T00:00:05.000Z", duration_ms: 4000 });
        });
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows });

        const result = await canceler.cancel("run-1", session);

        const first = db.state.ledger.find((row) => row.step_id === "done-first");
        expect(first).toMatchObject({ status: "completed", completed_at: "2026-08-12T00:00:05.000Z", duration_ms: 4000, error: null });
        expect(db.state.ledger.find((row) => row.step_id === "cut")?.status).toBe("canceled");
        expect(result.converged.steps).toBe(true);
    });

    it("still settles the running steps when the pending sweep fails", async () => {
        const db = fakeDb(runRow({ mandate_jti: "jti-1" }), [[stepRow("cut", "wf-child-1"), pendingRow("waiting")]], { sweepFails: true });
        const { charge, closes } = recordingCharge();
        const { authorizer, revoked } = recordingAuthorizer();
        const { cancelWorkflows } = recordingCancel();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows });

        const result = await canceler.cancel("run-1", session);

        expect(db.state.ledger.find((row) => row.step_id === "cut")?.status).toBe("canceled");
        expect(db.state.ledger.find((row) => row.step_id === "waiting")?.status).toBe("pending");
        expect(result.converged).toEqual({ steps: false, charge: true, mandate: true });
        expect(closes).toHaveLength(1);
        expect(revoked).toHaveLength(1);
    });

    it("still sweeps the pending steps when the running settle fails", async () => {
        const db = fakeDb(runRow({ mandate_jti: "jti-1" }), [[stepRow("cut", "wf-child-1"), pendingRow("waiting")]], { settleFails: true });
        const { charge, closes } = recordingCharge();
        const { authorizer, revoked } = recordingAuthorizer();
        const { cancelWorkflows } = recordingCancel();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows });

        const result = await canceler.cancel("run-1", session);

        expect(db.state.ledger.find((row) => row.step_id === "waiting")?.status).toBe("skipped");
        expect(db.state.ledger.find((row) => row.step_id === "cut")?.status).toBe("running");
        expect(result.converged).toEqual({ steps: false, charge: true, mandate: true });
        expect(closes).toHaveLength(1);
        expect(revoked).toHaveLength(1);
    });

    it("rejects an unknown run id", async () => {
        const db = fakeDb(null);
        const { charge } = recordingCharge();
        const { authorizer } = recordingAuthorizer();
        const { cancelWorkflows, cancelled } = recordingCancel();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows });

        await expect(canceler.cancel("run-missing", session)).rejects.toThrow(UnknownRunError);
        expect(cancelled).toEqual([]);
    });

    it("rejects when the engine cancel fails, before converging anything", async () => {
        const db = fakeDb(runRow());
        const { charge, closes } = recordingCharge();
        const { authorizer } = recordingAuthorizer();
        const canceler = createRunCanceler({
            pool: db.pool,
            runCharge: charge,
            runAuthorizer: authorizer,
            cancelWorkflows: () => {
                return Promise.reject(new Error("engine unreachable"));
            },
        });

        await expect(canceler.cancel("run-1", session)).rejects.toThrow("engine unreachable");
        expect(db.state.run?.status).toBe("running");
        expect(db.state.swept).toBe(0);
        expect(closes).toEqual([]);
    });
});

describe("createRunCanceler outcome metrics", () => {
    it("a cancel that wins the row records the run canceled from its ledger start, and each cut child as a canceled step", async () => {
        const capture = captureMetrics();
        try {
            // s1 was cut mid-flight; s2 wrote its own terminal row before the cancel; s3 never started.
            const steps = [stepRow("s1", "wf-child-1"), stepRow("s2", "wf-child-2", "2026-08-12T00:30:00.000Z"), stepRow("s3", null)];
            const db = fakeDb(runRow(), [steps]);
            const { charge } = recordingCharge();
            const { authorizer } = recordingAuthorizer();
            const { cancelWorkflows } = recordingCancel();
            const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows });

            const result = await canceler.cancel("run-1", session);

            expect(result.outcome).toBe("canceled");
            expect(await capture.sums("cortex.run.completed")).toEqual([[{ status: "canceled", workflow: "analysis" }, 1]]);
            const [duration] = await capture.histograms("cortex.run.duration");
            expect(duration?.[0]).toEqual({ status: "canceled", workflow: "analysis" });
            expect(duration?.[1].count).toBe(1);
            // Measured from the row's `started_at` (2026-08-12), so it is at least that far in the past.
            expect(duration?.[1].sum).toBeGreaterThan(Date.now() - Date.parse("2026-08-13T00:00:00.000Z"));
            // The cut child is counted without a duration; the child with a terminal row is left to itself.
            expect(await capture.sums("cortex.step.completed")).toEqual([[{ status: "canceled", agent_id: "test-agent" }, 1]]);
            expect(await capture.histograms("cortex.step.duration")).toEqual([]);
        } finally {
            await capture.dispose();
        }
    });
});

function recordingErrorLogger(): { logger: Logger; errors: Array<{ msg: string; fields?: LogFields }> } {
    const errors: Array<{ msg: string; fields?: LogFields }> = [];
    const logger: Logger = {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (msg, fields) => {
            errors.push({ msg, fields });
        },
        with: () => logger,
        named: () => logger,
        errorFields: () => ({}),
    };
    return { logger, errors };
}

describe("createRunCanceler run end record", () => {
    function recordingEmit(opts: { throws?: boolean } = {}): {
        emitRunEvent: (event: RunProvenanceEvent, emitSession: AgentSession) => void;
        received: Array<{ event: RunProvenanceEvent; session: AgentSession }>;
    } {
        const received: Array<{ event: RunProvenanceEvent; session: AgentSession }> = [];
        return {
            received,
            emitRunEvent: (event, emitSession) => {
                received.push({ event, session: emitSession });
                if (opts.throws) throw new Error("emit exploded");
            },
        };
    }

    it("a won cancel emits step_completed for the cut step, then run_completed, with the cancel session and one atMs", async () => {
        const steps = [stepRow("cut", "wf-child-1"), stepRow("done", "wf-child-2", "2026-08-12T00:30:00.000Z"), stepRow("never", null)];
        const db = fakeDb(runRow(), [steps]);
        const { charge } = recordingCharge();
        const { authorizer } = recordingAuthorizer();
        const { cancelWorkflows } = recordingCancel();
        const { emitRunEvent, received } = recordingEmit();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows, provenance: { emitRunEvent } });

        const before = Date.now();
        await canceler.cancel("run-1", session);
        const after = Date.now();

        expect(received.map((entry) => entry.event.type)).toEqual(["step_completed", "run_completed"]);
        for (const entry of received) expect(entry.session).toBe(session);
        const [stepEvent, runEvent] = received.map((entry) => entry.event);
        const atMs = runEvent?.type === "run_completed" ? runEvent.atMs : Number.NaN;
        expect(atMs).toBeGreaterThanOrEqual(before);
        expect(atMs).toBeLessThanOrEqual(after);
        expect(stepEvent).toEqual({
            type: "step_completed",
            analysisId: "analysis-1",
            runId: "run-1",
            stepId: "cut",
            status: "canceled",
            durationMs: atMs - Date.parse("2026-08-12T00:00:01.000Z"),
            atMs,
        });
        expect(runEvent).toEqual({
            type: "run_completed",
            analysisId: "analysis-1",
            runId: "run-1",
            status: "canceled",
            durationMs: atMs - Date.parse("2026-08-12T00:00:00.000Z"),
            atMs,
        });
    });

    it("omits the step duration when the step row has no start", async () => {
        const db = fakeDb(runRow(), [[{ ...stepRow("cut", "wf-child-1"), started_at: null }]]);
        const { charge } = recordingCharge();
        const { authorizer } = recordingAuthorizer();
        const { cancelWorkflows } = recordingCancel();
        const { emitRunEvent, received } = recordingEmit();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows, provenance: { emitRunEvent } });

        await canceler.cancel("run-1", session);

        const stepEvent = received[0]?.event;
        expect(stepEvent?.type).toBe("step_completed");
        expect(stepEvent !== undefined && "durationMs" in stepEvent).toBe(false);
    });

    it("emits nothing when the run completes between the read and the terminal write", async () => {
        const db = fakeDb(runRow(), [[stepRow("cut", "wf-child-1")]]);
        const { cancelWorkflows } = recordingCancel(() => {
            if (db.state.run === null) throw new Error("the run row exists");
            db.state.run = { ...db.state.run, status: "completed", completed_at: "2026-08-12T02:00:00.000Z" };
        });
        const { charge } = recordingCharge();
        const { authorizer } = recordingAuthorizer();
        const { emitRunEvent, received } = recordingEmit();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows, provenance: { emitRunEvent } });

        const result = await canceler.cancel("run-1", session);

        expect(result.finalStatus).toBe("completed");
        expect(received).toEqual([]);
    });

    it("emits nothing for a second cancel of a canceled run", async () => {
        const db = fakeDb(runRow({ status: "canceled", completed_at: "2026-08-12T01:00:00.000Z", error: "external_cancel" }));
        const { charge } = recordingCharge();
        const { authorizer } = recordingAuthorizer();
        const { cancelWorkflows } = recordingCancel();
        const { emitRunEvent, received } = recordingEmit();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows, provenance: { emitRunEvent } });

        const result = await canceler.cancel("run-1", session);

        expect(result.outcome).toBe("already_terminal");
        expect(received).toEqual([]);
    });

    it("still emits run_completed, and no step_completed, when the read of the cut steps fails", async () => {
        const db = fakeDb(runRow(), [[stepRow("cut", "wf-child-1")]], { failStepReadsAfter: 1 });
        const { charge } = recordingCharge();
        const { authorizer } = recordingAuthorizer();
        const { cancelWorkflows } = recordingCancel();
        const { emitRunEvent, received } = recordingEmit();
        const canceler = createRunCanceler({ pool: db.pool, runCharge: charge, runAuthorizer: authorizer, cancelWorkflows, provenance: { emitRunEvent } });

        const result = await canceler.cancel("run-1", session);

        expect(result.finalStatus).toBe("canceled");
        expect(received.map((entry) => entry.event.type)).toEqual(["run_completed"]);
    });

    it("a throwing run emit changes no convergence phase and no result", async () => {
        const steps = [stepRow("cut", "wf-child-1"), pendingRow("waiting")];
        const run = runRow({ mandate_jti: "jti-1" });

        const baselineDb = fakeDb(run, [steps]);
        const baseline = await createRunCanceler({
            pool: baselineDb.pool,
            runCharge: recordingCharge().charge,
            runAuthorizer: recordingAuthorizer().authorizer,
            cancelWorkflows: recordingCancel().cancelWorkflows,
        }).cancel("run-1", session);

        const db = fakeDb(run, [steps]);
        const { charge, closes } = recordingCharge();
        const { authorizer, revoked } = recordingAuthorizer();
        const { cancelWorkflows } = recordingCancel();
        const { emitRunEvent, received } = recordingEmit({ throws: true });
        const { logger, errors } = recordingErrorLogger();
        const canceler = createRunCanceler({
            pool: db.pool,
            runCharge: charge,
            runAuthorizer: authorizer,
            cancelWorkflows,
            provenance: { emitRunEvent },
            logger,
        });

        const result = await canceler.cancel("run-1", session);

        expect(received.map((entry) => entry.event.type)).toEqual(["step_completed", "run_completed"]);
        expect(errors.map((entry) => entry.msg)).toEqual(["the run emit of the provenance binding threw", "the run emit of the provenance binding threw"]);
        expect(errors.map((entry) => entry.fields)).toMatchObject([
            { runId: "run-1", event: "step_completed" },
            { runId: "run-1", event: "run_completed" },
        ]);
        expect(result).toEqual(baseline);
        expect(db.state.ledger.find((row) => row.step_id === "cut")?.status).toBe("canceled");
        expect(db.state.ledger.find((row) => row.step_id === "waiting")?.status).toBe("skipped");
        expect(closes).toHaveLength(1);
        expect(revoked).toEqual([{ jti: "jti-1", reason: "external_cancel" }]);
    });

    it("behaves as before when the provenance binding has no run emit", async () => {
        const steps = [stepRow("cut", "wf-child-1")];
        for (const provenance of [undefined, {}]) {
            const db = fakeDb(runRow(), [steps]);
            const { charge, closes } = recordingCharge();
            const { authorizer } = recordingAuthorizer();
            const { cancelWorkflows } = recordingCancel();
            const canceler = createRunCanceler({
                pool: db.pool,
                runCharge: charge,
                runAuthorizer: authorizer,
                cancelWorkflows,
                provenance,
            });

            const result = await canceler.cancel("run-1", session);

            expect(result).toEqual({
                runId: "run-1",
                workflowId: "run-1",
                outcome: "canceled",
                finalStatus: "canceled",
                converged: { steps: true, charge: true, mandate: true },
            });
            expect(closes).toHaveLength(1);
        }
    });
});

describe("createRunCanceler recorded run end", () => {
    function recordedEnd(overrides: Partial<RecordedRunEnd> = {}): RecordedRunEnd {
        return { status: "completed", error: null, closed: true, revoked: true, ...overrides };
    }

    function setup(opts: { record?: unknown; readFails?: boolean; row?: Row; onRead?: (db: FakeDb) => void; runWriteFails?: boolean }) {
        const db = fakeDb(opts.row ?? runRow({ mandate_jti: "jti-1" }), [[stepRow("cut", "wf-child-1"), pendingRow("waiting")]], {
            runWriteFails: opts.runWriteFails,
        });
        const { charge, closes } = recordingCharge();
        const { authorizer, revoked } = recordingAuthorizer();
        const { cancelWorkflows } = recordingCancel();
        const received: RunProvenanceEvent[] = [];
        const { logger, errors } = recordingErrorLogger();
        const canceler = createRunCanceler({
            pool: db.pool,
            runCharge: charge,
            runAuthorizer: authorizer,
            cancelWorkflows,
            provenance: { emitRunEvent: (event) => received.push(event) },
            logger,
            readRecordedRunEnd: () => {
                opts.onRead?.(db);
                if (opts.readFails) return Promise.reject(new Error("event read exploded"));
                return Promise.resolve(opts.record ?? null);
            },
        });
        return { db, canceler, closes, revoked, received, errors };
    }

    it("repairs the row to the recorded status, and emits, closes, and revokes nothing", async () => {
        const { db, canceler, closes, revoked, received } = setup({ record: recordedEnd() });

        const result = await canceler.cancel("run-1", session);

        expect(db.state.run?.status).toBe("completed");
        expect(db.state.run?.completed_at).not.toBeNull();
        expect(db.state.run?.error).toBeNull();
        expect(received).toEqual([]);
        expect(closes).toEqual([]);
        expect(revoked).toEqual([]);
        expect(result).toEqual({
            runId: "run-1",
            workflowId: "run-1",
            outcome: "canceled",
            finalStatus: "completed",
            converged: { steps: true, charge: true, mandate: true },
        });
        expect(db.state.ledger.find((row) => row.step_id === "cut")?.status).toBe("canceled");
        expect(db.state.ledger.find((row) => row.step_id === "waiting")?.status).toBe("skipped");
    });

    it("keeps the error of the body on the repaired row", async () => {
        const { db, canceler, received } = setup({ record: recordedEnd({ status: "failed", error: "synthesis failed" }) });

        const result = await canceler.cancel("run-1", session);

        expect(db.state.run?.status).toBe("failed");
        expect(db.state.run?.error).toBe("synthesis failed");
        expect(result.finalStatus).toBe("failed");
        expect(received).toEqual([]);
    });

    it("emits nothing for a recorded canceled status", async () => {
        const { db, canceler, closes, revoked, received } = setup({ record: recordedEnd({ status: "canceled", error: "external_cancel" }) });

        const result = await canceler.cancel("run-1", session);

        expect(db.state.run?.status).toBe("canceled");
        expect(db.state.run?.error).toBe("external_cancel");
        expect(result.finalStatus).toBe("canceled");
        expect(received).toEqual([]);
        expect(closes).toEqual([]);
        expect(revoked).toEqual([]);
    });

    it("takes the flags from the record: a failed charge close of the body shows as charge false", async () => {
        const { canceler } = setup({ record: recordedEnd({ closed: false, revoked: true }) });

        const result = await canceler.cancel("run-1", session);

        expect(result.converged).toEqual({ steps: true, charge: false, mandate: true });
    });

    it("records the run outcome metric with the recorded status, and no step outcome metric", async () => {
        const capture = captureMetrics();
        try {
            const { canceler } = setup({ record: recordedEnd({ status: "failed", error: "boom" }) });

            await canceler.cancel("run-1", session);

            expect(await capture.sums("cortex.run.completed")).toEqual([[{ status: "failed", workflow: "analysis" }, 1]]);
            expect(await capture.sums("cortex.step.completed")).toEqual([]);
        } finally {
            await capture.dispose();
        }
    });

    it("records no metric when the repair write changes nothing, and reports the status of the row", async () => {
        const capture = captureMetrics();
        try {
            const { db, canceler, received } = setup({
                record: recordedEnd(),
                onRead: (fake) => {
                    if (fake.state.run === null) throw new Error("the run row exists");
                    fake.state.run = { ...fake.state.run, status: "partial", completed_at: "2026-08-12T02:00:00.000Z" };
                },
            });

            const result = await canceler.cancel("run-1", session);

            expect(db.state.run?.status).toBe("partial");
            expect(result.finalStatus).toBe("partial");
            expect(received).toEqual([]);
            expect(await capture.sums("cortex.run.completed")).toEqual([]);
        } finally {
            await capture.dispose();
        }
    });

    it("takes the flags from the record when the repair write fails, and leaves the row running", async () => {
        const capture = captureMetrics();
        try {
            const { db, canceler, closes, revoked, received } = setup({ record: recordedEnd({ closed: true, revoked: false }), runWriteFails: true });

            const result = await canceler.cancel("run-1", session);

            expect(db.state.run?.status).toBe("running");
            expect(received).toEqual([]);
            expect(closes).toEqual([]);
            expect(revoked).toEqual([]);
            expect(await capture.sums("cortex.run.completed")).toEqual([]);
            expect(result.finalStatus).toBe("running");
            expect(result.converged).toEqual({ steps: true, charge: true, mandate: false });
        } finally {
            await capture.dispose();
        }
    });

    it("counts a record with a wrong shape as a failed read", async () => {
        const { db, canceler, closes, revoked, received, errors } = setup({ record: { error: null, closed: true, revoked: true } });

        const result = await canceler.cancel("run-1", session);

        expect(db.state.run?.status).toBe("running");
        expect(received).toEqual([]);
        expect(closes).toEqual([]);
        expect(revoked).toEqual([]);
        expect(result.finalStatus).toBe("running");
        expect(result.converged).toEqual({ steps: true, charge: false, mandate: false });
        expect(errors).toHaveLength(1);
    });

    it("writes nothing, and acts on nothing, when the read of the recorded run end fails", async () => {
        const { db, canceler, closes, revoked, received, errors } = setup({ readFails: true });

        const result = await canceler.cancel("run-1", session);

        expect(db.state.run?.status).toBe("running");
        expect(received).toEqual([]);
        expect(closes).toEqual([]);
        expect(revoked).toEqual([]);
        expect(db.state.ledger.find((row) => row.step_id === "cut")?.status).toBe("canceled");
        expect(db.state.ledger.find((row) => row.step_id === "waiting")?.status).toBe("skipped");
        expect(result.outcome).toBe("canceled");
        expect(result.finalStatus).toBe("running");
        expect(result.converged).toEqual({ steps: true, charge: false, mandate: false });
        expect(errors).toHaveLength(1);
    });

    it("gives mandate true for a failed read on a row with no jti, as a failed terminal write does", async () => {
        const { canceler } = setup({ readFails: true, row: runRow() });

        const result = await canceler.cancel("run-1", session);

        expect(result.converged).toEqual({ steps: true, charge: false, mandate: true });
    });

    it("keeps the current path when no run end is recorded", async () => {
        const { db, canceler, closes, revoked, received } = setup({ record: null });

        const result = await canceler.cancel("run-1", session);

        expect(db.state.run?.status).toBe("canceled");
        expect(result.converged).toEqual({ steps: true, charge: true, mandate: true });
        expect(received.map((event) => event.type)).toEqual(["step_completed", "run_completed"]);
        expect(closes).toHaveLength(1);
        expect(revoked).toHaveLength(1);
    });
});
