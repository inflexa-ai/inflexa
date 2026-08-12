/**
 * Fakes only, no live DBOS: the engine cancel enters through the injected
 * `cancelWorkflows` seam, and the ledgers are an in-memory pool that answers
 * the canceler's four queries and applies the conditional-write rule the real
 * `markRunCanceledIfActive` enforces — so the race assertions exercise state,
 * not stubs of it.
 */

import { describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import type { AgentSession } from "../auth/types.js";
import type { RunCharge } from "../billing/run-charge.js";
import type { RunAuthorizer } from "./run-authorizer.js";
import { createRunCanceler, UnknownRunError } from "./run-canceler.js";

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

interface FakeDb {
    pool: Pool;
    state: { run: Row | null; swept: number };
}

/** Successive `queryStepsByRun` reads consume `stepBatches`; the last repeats. */
function fakeDb(run: Row | null, stepBatches: Row[][] = [[]], opts: { sweepFails?: boolean } = {}): FakeDb {
    const state = { run, swept: 0 };
    let stepReads = 0;
    const pool = {
        query: async ({ text, values }: { text: string; values?: unknown[] }) => {
            if (text.includes("FROM cortex_runs")) return { rows: state.run === null ? [] : [state.run], rowCount: state.run === null ? 0 : 1 };
            if (text.includes("SET status = 'canceled'")) {
                const active = state.run !== null && (state.run.status === "running" || state.run.status === "suspended_insufficient_funds");
                if (!active || state.run === null) return { rowCount: 0 };
                state.run = { ...state.run, status: "canceled", completed_at: values?.[1], error: values?.[2] };
                return { rowCount: 1 };
            }
            if (text.includes("FROM cortex_step_executions")) {
                const batch = stepBatches[Math.min(stepReads, stepBatches.length - 1)] ?? [];
                stepReads += 1;
                return { rows: batch };
            }
            if (text.includes("SET status = 'skipped'")) {
                if (opts.sweepFails) throw new Error("sweep exploded");
                state.swept += 1;
                return { rowCount: 0 };
            }
            throw new Error(`unexpected query: ${text}`);
        },
    } as unknown as Pool;
    return { pool, state };
}

function recordingCharge(opts: { fail?: boolean } = {}): { charge: RunCharge; closes: Array<{ analysisId: string; runId: string; reason: string }> } {
    const closes: Array<{ analysisId: string; runId: string; reason: string }> = [];
    const charge: RunCharge = {
        open: async () => {
            throw new Error("open is not reached by the canceler");
        },
        close: async ({ analysisId, runId, reason }) => {
            if (opts.fail) throw new Error("close exploded");
            closes.push({ analysisId, runId, reason });
        },
    };
    return { charge, closes };
}

function recordingAuthorizer(): { authorizer: RunAuthorizer; revoked: Array<{ jti: string; reason: string }> } {
    const revoked: Array<{ jti: string; reason: string }> = [];
    const authorizer: RunAuthorizer = {
        authorize: async () => {
            throw new Error("authorize is not reached by the canceler");
        },
        revoke: async () => {
            throw new Error("terminal-path revoke is not reached by the canceler");
        },
        revokeByJti: async ({ jti }, reason) => {
            revoked.push({ jti, reason });
        },
    };
    return { authorizer, revoked };
}

function recordingCancel(onCall?: (ids: readonly string[]) => void): { cancelWorkflows: (ids: readonly string[]) => Promise<void>; cancelled: string[][] } {
    const cancelled: string[][] = [];
    return {
        cancelled,
        cancelWorkflows: async (ids) => {
            cancelled.push([...ids]);
            onCall?.(ids);
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
        expect(closes).toEqual([{ analysisId: "analysis-1", runId: "run-1", reason: "canceled" }]);
        expect(revoked).toEqual([{ jti: "jti-1", reason: "external_cancel" }]);
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

    it("still revokes the mandate when the charge close throws, and resolves with converged.charge false", async () => {
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
            db.state.run = { ...(db.state.run as Row), status: "completed", completed_at: "2026-08-12T02:00:00.000Z" };
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
            cancelWorkflows: async () => {
                throw new Error("engine unreachable");
            },
        });

        await expect(canceler.cancel("run-1", session)).rejects.toThrow("engine unreachable");
        expect(db.state.run?.status).toBe("running");
        expect(db.state.swept).toBe(0);
        expect(closes).toEqual([]);
    });
});
