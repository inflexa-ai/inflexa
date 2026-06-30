/**
 * Integration tests 10.6 + 10.13 — DBOS replay invariants.
 *
 * Test 10.6 — chaos recovery (tasks.md:102):
 *   "Kill mid-step after `runAgent` LLM call has cached its result but
 *    before `generateFileMetadata` runs. Verify: cached LLM result returns
 *    on replay (no re-issued API call), next `durableStep` runs forward."
 *
 * Test 10.13 — per-step sync, non-fatal + idempotent on recovery:
 *   "Runs inline in the child; failure logged as warning, step still
 *    reports complete; idempotent on DBOS recovery."
 *
 * Pattern — DBOS-determinism-safe chaos:
 *
 *   DBOS replays a workflow with its ORIGINAL durable input and requires
 *   the STEP SEQUENCE (function name at each step-id) to be deterministic
 *   between attempts — a diverging sequence is rejected as
 *   `DBOSUnexpectedStepError`. That rules out the obvious "flip a
 *   module-level flag between runs" approach (which would skip a step on
 *   replay and change the sequence).
 *
 *   We use `DBOS.cancelWorkflow(DBOS.workflowID!)` mid-body, UNCONDITIONALLY.
 *   The cancel call is recorded as a step on the first attempt; on
 *   `resumeWorkflow` the body re-runs, cached step results return without
 *   re-invoking their closures, the cached cancel-step returns its cached
 *   no-op outcome, and any steps PAST the cancel point run fresh.
 *
 *   Module-level counters incremented inside step closures stay at 1 for
 *   the steps that ran on the original attempt — proving the closure did
 *   NOT re-execute on replay. That is the load-bearing invariant
 *   production relies on for LLM-call deduplication across resume.
 *
 * File consolidation:
 *
 *   All `DBOS.registerWorkflow` calls in this PR's workflow-replay test
 *   live in this single file. DBOS is process-global: once
 *   `DBOS.launch()` runs (lazily inside `setupDbosForTests`), further
 *   `registerWorkflow` calls are rejected with
 *   `DBOSConflictingRegistrationError`. Bun loads test files sequentially
 *   (load module → run `beforeAll` → run tests → next file), so a second
 *   file's top-level registrations would always fire AFTER the first
 *   file's launch. `just test-workflow` invokes `bun test` once per file
 *   in `harness/workflows/__tests__/dbos/` to dodge that constraint.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";

import { setupDbosForTests, type DbosTestRig } from "../../../__tests__/setup/dbos.js";

// ── 10.6 — chaos mirror ─────────────────────────────────────────────────

let llmCallCounter = 0;
let metaCallCounter = 0;

/**
 * DBOS step caching, exercised in isolation. DBOS replays a workflow with
 * its ORIGINAL durable input and requires the step SEQUENCE (function
 * name at each step-id) to be deterministic between attempts — diverging
 * sequences surface as `DBOSUnexpectedStepError` ("function X was recorded
 * when Y was expected — check that your workflow is deterministic").
 *
 * That rules out the obvious "flip a module-level flag between runs"
 * pattern: a conditional crash that's present on attempt 1 and absent on
 * attempt 2 changes the step sequence.
 *
 * Instead, the mid-body `cancelWorkflow(self)` is UNCONDITIONAL. It runs
 * on every attempt. On the first attempt it transitions the workflow to
 * CANCELLED before the post-cancel step runs. `DBOS.resumeWorkflow` clears
 * the cancelled state and re-runs the body: the cached step results
 * (including the cached cancel outcome) replay deterministically, and the
 * post-cancel step runs fresh because it was never recorded.
 *
 * The load-bearing assertion is that step CLOSURES re-invoke zero times
 * for steps that completed on the original attempt — the cached result
 * returns instead. Module-level counters incremented inside closures
 * remain unchanged across replay.
 */
const chaosMirror = DBOS.registerWorkflow(
    async (): Promise<{ llm: string; meta: string }> => {
        const llmResult = await DBOS.runStep(
            async () => {
                llmCallCounter += 1;
                return `llm-${llmCallCounter}`;
            },
            { name: "llm:0:0" },
        );

        // Self-cancel — mirrors `sandbox-step.ts`'s 402 self-cancel path.
        // CANCELLED is resumable via `DBOS.resumeWorkflow`; the step cache
        // survives the transition and the cached `llm:0:0` result returns
        // without re-invoking the closure on replay. The cancel call is
        // ALWAYS in the body so the step sequence on replay matches the
        // original — DBOS's determinism check rejects step sequences that
        // diverge between attempts.
        await DBOS.cancelWorkflow(DBOS.workflowID!);

        const metaResult = await DBOS.runStep(
            async () => {
                metaCallCounter += 1;
                return `meta-${metaCallCounter}`;
            },
            { name: "post-step.metadata" },
        );

        return { llm: llmResult, meta: metaResult };
    },
    { name: "chaos-mirror" },
);

// ── 10.6 — three-step mirror (defence-in-depth) ─────────────────────────

let stepACalls = 0;
let stepBCalls = 0;
let stepCCalls = 0;

/**
 * The cancel call is unconditional — DBOS's determinism check requires
 * the step sequence to be identical between original execution and replay.
 * A conditional that skips the cancel on replay would surface as
 * `DBOSUnexpectedStepError` ("function X was recorded when Y was expected
 * — check that your workflow is deterministic").
 *
 * Cancel-as-a-step is cached like any other step. The first execution
 * records the cancel and transitions the workflow to CANCELLED. On
 * `resumeWorkflow`, the body re-runs from the top: A and B return cached
 * results, the cancel call returns its cached "already invoked" outcome
 * (a no-op on the now-resumed workflow), and C runs fresh.
 */
const threeStepMirror = DBOS.registerWorkflow(
    async (): Promise<{ a: number; b: number; c: number }> => {
        const a = await DBOS.runStep(
            async () => {
                stepACalls += 1;
                return stepACalls;
            },
            { name: "three-step.a" },
        );
        const b = await DBOS.runStep(
            async () => {
                stepBCalls += 1;
                return stepBCalls;
            },
            { name: "three-step.b" },
        );
        await DBOS.cancelWorkflow(DBOS.workflowID!);
        const c = await DBOS.runStep(
            async () => {
                stepCCalls += 1;
                return stepCCalls;
            },
            { name: "three-step.c" },
        );
        return { a, b, c };
    },
    { name: "three-step-mirror" },
);

// ── 10.13 — non-fatal sync (safeRun swallows throw) ────────────────────

let nonFatalSyncCalls = 0;
let nonFatalPostSyncCalls = 0;

const nonFatalSyncMirror = DBOS.registerWorkflow(
    async (): Promise<{ syncCalls: number; postSyncCalls: number }> => {
        // Mirror of `deps.artifactRegistry.sync(...)` wrapped by the body's
        // fail-fast try/catch.
        // In production, `safeRun` swallows any throw and the body proceeds.
        try {
            await DBOS.runStep(
                async () => {
                    nonFatalSyncCalls += 1;
                    throw new Error("artifact store reachability lost");
                },
                { name: "post-step.sync" },
            );
        } catch (err) {
            console.warn(`[mirror] post-step.sync failed (non-fatal):`, err instanceof Error ? err.message : err);
        }

        await DBOS.runStep(
            async () => {
                nonFatalPostSyncCalls += 1;
            },
            { name: "post-step.vector-index" },
        );

        return { syncCalls: nonFatalSyncCalls, postSyncCalls: nonFatalPostSyncCalls };
    },
    { name: "non-fatal-sync-mirror" },
);

// ── 10.13 — idempotent sync (no replay re-fire) ─────────────────────────

let idempotentSyncCalls = 0;
let idempotentSyncArgs: string[] = [];

const idempotentSyncMirror = DBOS.registerWorkflow(
    async (input: { stepId: string }): Promise<{ syncCalls: number; tail: string }> => {
        await DBOS.runStep(
            async () => {
                idempotentSyncCalls += 1;
                idempotentSyncArgs.push(input.stepId);
            },
            { name: "post-step.sync" },
        );

        // Unconditional cancel — see threeStepMirror's note on DBOS's
        // determinism requirement for step sequences across replay.
        await DBOS.cancelWorkflow(DBOS.workflowID!);

        const tail = await DBOS.runStep(async () => "tail-ok", { name: "post-step.tail" });

        return { syncCalls: idempotentSyncCalls, tail };
    },
    { name: "idempotent-sync-mirror" },
);

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Poll the durable workflow status until it lands in a terminal state.
 *
 * Why not `await handle.getResult()`? When a workflow throws, DBOS holds
 * two reject-chains on the same error: the internally-tracked
 * `workflowPromise` (registered in `systemDatabase.registerRunningWorkflow`)
 * and the handle's own promise. Awaiting one leaves the other floating,
 * and Bun's test runner surfaces the floater as a separate test failure.
 * The robust pattern is `handle.getResult().catch(() => {})` (silence the
 * handle's chain) followed by polling `getWorkflowStatus` to read the
 * durable terminal state.
 */
async function waitForTerminal(workflowId: string, timeoutMs = 5_000): Promise<Awaited<ReturnType<typeof DBOS.getWorkflowStatus>>> {
    const deadline = Date.now() + timeoutMs;
    let status: Awaited<ReturnType<typeof DBOS.getWorkflowStatus>> = null;
    while (Date.now() < deadline) {
        status = await DBOS.getWorkflowStatus(workflowId);
        if (status && (status.status === "SUCCESS" || status.status === "ERROR" || status.status === "CANCELLED")) {
            return status;
        }
        await new Promise((r) => setTimeout(r, 25));
    }
    return status;
}

// ── Lifecycle ───────────────────────────────────────────────────────────

let rig: DbosTestRig;

beforeAll(async () => {
    rig = await setupDbosForTests("workflow_replay");
});

afterAll(async () => {
    if (rig) await rig.drop();
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("Integration test 10.6 — chaos recovery", () => {
    it("cached LLM step returns its cached result on replay; downstream step runs forward", async () => {
        llmCallCounter = 0;
        metaCallCounter = 0;

        const wfId = rig.nextWorkflowId("chaos-");

        // Run #1: workflow self-cancels after step 1. DBOS stores the workflow
        // promise internally and may reject it AFTER the handle's promise
        // chain. We poll the durable status instead of awaiting `getResult()`
        // (with the handle's chain explicitly silenced).
        const handle1 = await DBOS.startWorkflow(chaosMirror, {
            workflowID: wfId,
        })();
        handle1.getResult().catch(() => {});
        const status1 = await waitForTerminal(wfId);
        expect(status1?.status).toBe("CANCELLED");

        expect(llmCallCounter).toBe(1);
        expect(metaCallCounter).toBe(0);

        // Resume the same workflow ID. DBOS replays the body — `llm:0:0`
        // returns its cached value, the self-cancel step returns its cached
        // outcome (no-op on a non-cancelled workflow), then `post-step.metadata`
        // runs fresh.
        const handle2 = await DBOS.resumeWorkflow<{ llm: string; meta: string }>(wfId);
        const result = await handle2.getResult();

        // Load-bearing assertion: the step's CLOSURE did not run a second
        // time. The cached value (`llm-1`, NOT `llm-2`) is what the body
        // observed on replay.
        expect(result.llm).toBe("llm-1");
        expect(llmCallCounter).toBe(1);

        expect(result.meta).toBe("meta-1");
        expect(metaCallCounter).toBe(1);

        const status2 = await DBOS.getWorkflowStatus(wfId);
        expect(status2?.status).toBe("SUCCESS");
    });

    it("multi-step caching: a crash between any two steps preserves all prior cached results", async () => {
        stepACalls = 0;
        stepBCalls = 0;
        stepCCalls = 0;

        const wfId = rig.nextWorkflowId("chaos-3-");

        const handle1 = await DBOS.startWorkflow(threeStepMirror, {
            workflowID: wfId,
        })();
        handle1.getResult().catch(() => {});
        const status1 = await waitForTerminal(wfId);
        expect(status1?.status).toBe("CANCELLED");

        expect(stepACalls).toBe(1);
        expect(stepBCalls).toBe(1);
        expect(stepCCalls).toBe(0);

        const handle2 = await DBOS.resumeWorkflow<{ a: number; b: number; c: number }>(wfId);
        const result = await handle2.getResult();

        // A and B returned cached values; C ran fresh.
        expect(result).toEqual({ a: 1, b: 1, c: 1 });
        expect(stepACalls).toBe(1);
        expect(stepBCalls).toBe(1);
        expect(stepCCalls).toBe(1);
    });
});

describe("Integration test 10.13 — per-step sync (non-fatal + idempotent)", () => {
    it("sync failure is logged but the workflow still reaches SUCCESS", async () => {
        nonFatalSyncCalls = 0;
        nonFatalPostSyncCalls = 0;

        const wfId = rig.nextWorkflowId("sync-fail-");
        const handle = await DBOS.startWorkflow(nonFatalSyncMirror, {
            workflowID: wfId,
        })();

        const result = await handle.getResult();

        expect(nonFatalSyncCalls).toBe(1);
        expect(result.syncCalls).toBe(1);
        expect(nonFatalPostSyncCalls).toBe(1);
        expect(result.postSyncCalls).toBe(1);

        const status = await DBOS.getWorkflowStatus(wfId);
        expect(status?.status).toBe("SUCCESS");
    });

    it("sync is NOT re-fired on DBOS recovery (cached step result returns)", async () => {
        idempotentSyncCalls = 0;
        idempotentSyncArgs = [];

        const wfId = rig.nextWorkflowId("sync-idem-");

        const handle1 = await DBOS.startWorkflow(idempotentSyncMirror, {
            workflowID: wfId,
        })({ stepId: "step-A" });
        handle1.getResult().catch(() => {});
        const status1 = await waitForTerminal(wfId);
        expect(status1?.status).toBe("CANCELLED");

        expect(idempotentSyncCalls).toBe(1);
        expect(idempotentSyncArgs).toEqual(["step-A"]);

        const handle2 = await DBOS.resumeWorkflow<{ syncCalls: number; tail: string }>(wfId);
        const result = await handle2.getResult();

        // Sync's closure did NOT run on replay — counter still 1, args
        // array still has only the original invocation.
        expect(idempotentSyncCalls).toBe(1);
        expect(idempotentSyncArgs).toEqual(["step-A"]);
        expect(result.tail).toBe("tail-ok");
        expect(result.syncCalls).toBe(1);

        const status2 = await DBOS.getWorkflowStatus(wfId);
        expect(status2?.status).toBe("SUCCESS");
    });
});
