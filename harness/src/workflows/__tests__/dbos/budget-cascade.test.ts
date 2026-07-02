/**
 * Integration test 10.9 — 402 pause + resume cascade.
 *
 * From tasks.md 10.9:
 *   "End-to-end: child B's LLM throws 402 → B self-cancels to CANCELLED →
 *    parent cascade-cancels A/C → analysis flips to
 *    suspended_insufficient_funds → charge closes with budget_exceeded →
 *    mandate revokes with workflow-suspended. After top-up, resume re-awaits
 *    A/C (cached completions), cancelled children explicitly resumed via
 *    DBOS.resumeWorkflow. A's resumed LLM call uses the attempt:1 step name
 *    and lands a fresh billing gateway call. Final completion closes the run cleanly."
 *
 * The full path involves the production parent (`executeAnalysis`), the
 * production child (`sandboxStep`), the SSE route, billing/mandate side
 * effects, and the resume HTTP route. Wiring all of that end-to-end would
 * require standing up the entire server. Instead this file covers the
 * load-bearing **engine primitives** in two complementary tests:
 *
 *   Test A — engine primitives, mirroring sandbox-step.ts:296-326 (child
 *     self-cancel with mark-canceled step after the cancel) and
 *     execute-analysis.ts:548-627 (parent cascade + cancelInFlight).
 *     Asserts:
 *       1. Child B's LLM step runs once on attempt:0 (no cache).
 *       2. Child B self-cancels via DBOS.cancelWorkflow(self) — the next
 *          DBOS.runStep after the cancel raises DBOSWorkflowCancelledError,
 *          which surfaces as the child's terminal CANCELLED status.
 *       3. Parent observes B's getResult throw, cancels in-flight A and C
 *          via DBOS.cancelWorkflow(siblingId) (cascade is NOT automatic —
 *          DBOS does not propagate lifecycle to children).
 *       4. A and C reach CANCELLED.
 *       5. On resume: bumped attempt → child B's LLM step name suffix
 *          changes (attempt:0 → attempt:1) → cache miss → fresh execution.
 *
 *   Test B — `prepareExecuteAnalysisResume` helper hits real cortex_runs
 *     rows. Exercises:
 *       - row lookup by workflow_id
 *       - atomic attempt_count bump
 *       - MissingRunError on unknown workflow_id
 *
 * Resume contract pinned by Test C: `DBOS.resumeWorkflow` is implemented
 * as `UPDATE workflow_status SET status='ENQUEUED' WHERE status NOT IN
 * ('SUCCESS','ERROR')`. The production parent (`execute-analysis.ts`) now
 * self-cancels to CANCELLED on the budget-exceeded path after running its
 * close-charge + revoke-mandate cleanup, so the resume route's
 * `DBOS.resumeWorkflow(parentId)` actually re-runs the parent body.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLocalAuth } from "../../../auth/local-auth-context.js";
import { DBOS, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";

import type { ChatProvider, EmbeddingProvider } from "../../../providers/types.js";
import { upsertAnalysis } from "../../../state/index.js";

/** Writable sessions root the in-body `init-run-filesystem` mkdir targets. */
const BUDGET_TEST_SESSIONS_DIR = join(tmpdir(), "cortex-budget-cascade-test");
import { setupDbosForTests, type DbosTestRig } from "../../../__tests__/setup/dbos.js";
import { runExecuteAnalysisBody, type ExecuteAnalysisDeps } from "../../execute-analysis.js";
import { MissingRunError, prepareExecuteAnalysisResume } from "../../resume-execute-analysis.js";
import { BUDGET_EXCEEDED_TOPIC, type BudgetExceededNotification, type SandboxStepInput, type SandboxStepResult } from "../../sandbox-step.js";

// Reopen the registration window if an earlier test file already launched
// the shared DBOS engine: a plain shutdown (no `deregister`) keeps every
// prior registration and lets this module's top-level `registerWorkflow`
// calls through; `beforeAll` relaunches via `DBOS.launch()`.
if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

// ── Module-level state mirroring real LLM call counters + budget toggle ──
//
// `bExecutionCount` increments only when child B's LLM-shaped step actually
// runs its closure. DBOS caches step results by `name`, so attempt:0 and
// attempt:1 are DIFFERENT cache keys — that is how the production resume
// path re-issues fresh billing gateway calls after a 402 pause.

let bExecutionCount = 0;
let bShouldFail = true;

let aExecutionCount = 0;
let cExecutionCount = 0;

const dispatchedChildIds: { a?: string; b?: string; c?: string } = {};

interface ChildResult {
    status: "complete" | "canceled";
    who: "A" | "B" | "C";
    attempt: number;
    error?: string;
}

// ── Long-running child (A and C) ───────────────────────────────────────
const longRunningChild = DBOS.registerWorkflow(
    async (input: { who: "A" | "C"; attempt: number; iterations: number }): Promise<ChildResult> => {
        for (let i = 0; i < input.iterations; i += 1) {
            await DBOS.runStep(
                async () => {
                    if (input.who === "A") aExecutionCount += 1;
                    else cExecutionCount += 1;
                    await new Promise((r) => setTimeout(r, 25));
                    return i;
                },
                { name: `child-tick:${i}:${input.attempt}` },
            );
        }
        return { status: "complete", who: input.who, attempt: input.attempt };
    },
    { name: "long-running-child" },
);

// ── Budget-exceeded child (B) — mirrors sandbox-step.ts:296-396 ────────
//
// The closure shape matches the production catch block:
//   - runStep wrapping the "LLM" call (attempt-suffixed step name)
//   - catch detects budget_exceeded
//   - DBOS.cancelWorkflow(workflowID) — self-cancel
//   - DBOS.runStep for "mark-canceled" (a status-update durable step)
//   - return { status: "canceled", error: "budget_exceeded", … }
//
// IMPORTANT: per DBOS semantics, `cancelWorkflow(self)` marks the row;
// the NEXT DBOS API call raises DBOSWorkflowCancelledError. So the
// `mark-canceled` runStep below DOES throw on the catch path. The
// production code does not wrap that throw — meaning the child workflow
// surfaces as CANCELLED (which is what the parent's getResult catch
// block on execute-analysis.ts:606 wants to see).
// ── Test C: minimal child workflow that throws budget_exceeded ──
//
// Drives the real `runExecuteAnalysisBody` against a stubbed deps bundle.
// The child workflow throws an error carrying "budget_exceeded" in the
// message so the parent's `isBudgetExceeded(settled.err)` check on the
// `getResult`-threw branch flips. (Production self-cancels the child to
// CANCELLED; the parent reads that via a different signal — out of scope
// here, so we use the simpler "throw matches isBudgetExceeded" path.)
const testCChild = DBOS.registerWorkflow(
    async (_input: SandboxStepInput): Promise<SandboxStepResult> => {
        await DBOS.runStep(
            async () => {
                const err = new Error("billing gateway: budget_exceeded for VK vk_test");
                (err as { statusCode?: number }).statusCode = 402;
                throw err;
            },
            { name: "llm:0:0" },
        );
        return {
            status: "complete",
            durationMs: 0,
            finishReason: null,
            error: null,
        };
    },
    { name: "test-c-budget-child" },
);

const budgetExceededChild = DBOS.registerWorkflow(
    async (input: { attempt: number }): Promise<ChildResult> => {
        const llmStepName = `llm:0:${input.attempt}`;
        try {
            await DBOS.runStep(
                async () => {
                    bExecutionCount += 1;
                    if (bShouldFail) {
                        const err = new Error("billing gateway: budget_exceeded for VK vk_test");
                        (err as { statusCode?: number }).statusCode = 402;
                        throw err;
                    }
                    return "llm-ok";
                },
                { name: llmStepName },
            );
        } catch (err) {
            const isBudget = (err as { statusCode?: number })?.statusCode === 402 || /budget.?exceeded/i.test(err instanceof Error ? err.message : String(err));
            if (isBudget) {
                await DBOS.cancelWorkflow(DBOS.workflowID!);
                // Production mirror — this runStep raises DBOSWorkflowCancelledError
                // because the workflow is now in CANCELLED state.
                await DBOS.runStep(
                    async () => {
                        // The mark-canceled durable step in production updates
                        // cortex_step_executions to status=canceled. Body never executes
                        // post-cancel.
                        return null;
                    },
                    { name: "mark-canceled" },
                );
                // Unreachable — the runStep above throws.
                return {
                    status: "canceled",
                    who: "B",
                    attempt: input.attempt,
                    error: "budget_exceeded",
                };
            }
            throw err;
        }
        return { status: "complete", who: "B", attempt: input.attempt };
    },
    { name: "budget-exceeded-child" },
);

// Test C parent — registered once at module load; reads deps from
// `testCDepsRef.value` at body time so each test can swap in a fresh deps
// bundle (matching the synthesis-paths test pattern).
const testCDepsRef: { value: ExecuteAnalysisDeps | undefined } = {
    value: undefined,
};
const testCParent = DBOS.registerWorkflow(
    async (input: { analysisId: string; planId: string; threadId: string | null }) => {
        const deps = testCDepsRef.value;
        if (!deps) throw new Error("testCParent: deps not set");
        return runExecuteAnalysisBody(
            {
                analysisId: input.analysisId,
                planId: input.planId,
                planSummary: "test plan",
                threadId: input.threadId,
                steps: [{ id: "S1", depends_on: [] }],
                promptByStepId: { S1: "noop" },
                agentByStepId: { S1: "scientific-executor" },
                resourcesByStepId: { S1: { cpu: 2, memoryGb: 4 } },
                runSession: {
                    identity: { user: "u-1" },
                    scope: { kind: "analysis", analysisId: input.analysisId },
                    provenance: { agentId: "executeAnalysis", callPath: ["executeAnalysis"] },
                    runFrame: { runId: DBOS.workflowID ?? "test-run" },
                    auth: makeLocalAuth(),
                },
            },
            deps,
        );
    },
    { name: "test-c-execute-analysis-parent" },
);

// ── Test D: production self-cancel path ────────────────────────────────
//
// Mirrors sandbox-step.ts:400-437 EXACTLY — the child sends the
// `child-budget-exceeded` notification BEFORE `DBOS.cancelWorkflow(self)`,
// then a post-cancel `DBOS.runStep` raises DBOSWorkflowCancelledError. The
// parent's `getResult` then throws that generic-message error — which
// `isBudgetExceeded` cannot match. Without the side-channel the parent
// misclassifies as fail-fast; with it, the recv accumulator records the
// child id BEFORE the throw lands and classification reads from the set.
const testDChild = DBOS.registerWorkflow(
    async (input: SandboxStepInput): Promise<SandboxStepResult> => {
        const childWorkflowId = DBOS.workflowID!;
        const notification: BudgetExceededNotification = {
            childWorkflowId,
            stepId: input.stepId,
            error: "billing gateway: budget_exceeded for VK vk_test",
        };
        await DBOS.runStep(() => DBOS.send(input.parentWorkflowId, notification, BUDGET_EXCEEDED_TOPIC), { name: "notify-parent-budget-exceeded" });
        await DBOS.cancelWorkflow(childWorkflowId);
        // Post-cancel runStep raises DBOSWorkflowCancelledError — the same
        // generic-message error production children surface.
        await DBOS.runStep(async () => null, { name: "mark-canceled" });
        // Unreachable.
        return {
            status: "canceled",
            durationMs: 0,
            finishReason: null,
            error: "budget_exceeded",
        };
    },
    { name: "test-d-budget-child" },
);

const testDDepsRef: { value: ExecuteAnalysisDeps | undefined } = {
    value: undefined,
};
const testDParent = DBOS.registerWorkflow(
    async (input: { analysisId: string; planId: string; threadId: string | null }) => {
        const deps = testDDepsRef.value;
        if (!deps) throw new Error("testDParent: deps not set");
        return runExecuteAnalysisBody(
            {
                analysisId: input.analysisId,
                planId: input.planId,
                planSummary: "test plan",
                threadId: input.threadId,
                steps: [{ id: "S1", depends_on: [] }],
                promptByStepId: { S1: "noop" },
                agentByStepId: { S1: "scientific-executor" },
                resourcesByStepId: { S1: { cpu: 2, memoryGb: 4 } },
                runSession: {
                    identity: { user: "u-1" },
                    scope: { kind: "analysis", analysisId: input.analysisId },
                    provenance: { agentId: "executeAnalysis", callPath: ["executeAnalysis"] },
                    runFrame: { runId: DBOS.workflowID ?? "test-run" },
                    auth: makeLocalAuth(),
                },
            },
            deps,
        );
    },
    { name: "test-d-execute-analysis-parent" },
);

let rig: DbosTestRig;

beforeAll(async () => {
    rig = await setupDbosForTests("budget_cascade");
    // Relaunch when the module-top registration-window bounce stopped the
    // engine; a no-op when the rig's lazy launch above did the launching.
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    if (rig) await rig.drop();
});

describe("Integration test 10.9 — 402 pause + resume cascade", () => {
    it("A: cascade cancel + resume re-runs B's attempt:1 LLM step fresh; A/C cancelled cleanly", async () => {
        // Reset module-level state.
        aExecutionCount = 0;
        bExecutionCount = 0;
        cExecutionCount = 0;
        bShouldFail = true;
        dispatchedChildIds.a = undefined;
        dispatchedChildIds.b = undefined;
        dispatchedChildIds.c = undefined;

        // Use the parent ID purely as a deterministic prefix for child IDs —
        // we do NOT actually run a parent workflow here. The cascade is
        // driven from the test, mirroring what the parent body does. This
        // sidesteps the SUCCESS vs CANCELLED parent-resume question (see
        // file-header caveat) and isolates the assertions on what DBOS
        // primitives actually guarantee.
        const parentPrefix = rig.nextWorkflowId("cascade-");
        const aId = `${parentPrefix}-A`;
        const bId = `${parentPrefix}-B`;
        const cId = `${parentPrefix}-C`;
        dispatchedChildIds.a = aId;
        dispatchedChildIds.b = bId;
        dispatchedChildIds.c = cId;

        // ── Phase 1: dispatch all three children, B fails 402 ─────────────
        const aHandle = await DBOS.startWorkflow(longRunningChild, {
            workflowID: aId,
        })({ who: "A", attempt: 0, iterations: 30 });
        const bHandle = await DBOS.startWorkflow(budgetExceededChild, {
            workflowID: bId,
        })({ attempt: 0 });
        const cHandle = await DBOS.startWorkflow(longRunningChild, {
            workflowID: cId,
        })({ who: "C", attempt: 0, iterations: 30 });

        // Mirror execute-analysis.ts:548-627 race. Awaiting B first because
        // we know it fails fastest; production uses Promise.race.
        let bThrew = false;
        let bThrowError: unknown = null;
        try {
            await bHandle.getResult();
        } catch (err) {
            bThrew = true;
            bThrowError = err;
        }

        // The next DBOS call after self-cancel raises
        // DBOSWorkflowCancelledError, which `getResult` surfaces.
        expect(bThrew).toBe(true);
        expect(bThrowError).toBeInstanceOf(DBOSErrors.DBOSWorkflowCancelledError);

        // Cascade-cancel siblings (mirroring `cancelInFlight`).
        await Promise.allSettled([DBOS.cancelWorkflow(aId), DBOS.cancelWorkflow(cId)]);

        // Drain A and C — both should throw DBOSWorkflowCancelledError once
        // their next runStep observes the cancel.
        let aThrew = false;
        let cThrew = false;
        try {
            await aHandle.getResult();
        } catch {
            aThrew = true;
        }
        try {
            await cHandle.getResult();
        } catch {
            cThrew = true;
        }
        expect(aThrew).toBe(true);
        expect(cThrew).toBe(true);

        // Confirm all three children's durable status is CANCELLED.
        const deadline = Date.now() + 5_000;
        const waitForCancelled = async (id: string): Promise<string | undefined> => {
            while (Date.now() < deadline) {
                const s = await DBOS.getWorkflowStatus(id);
                if (s?.status === "CANCELLED") return "CANCELLED";
                if (s?.status === "ERROR" || s?.status === "SUCCESS") return s.status;
                await new Promise((r) => setTimeout(r, 50));
            }
            return (await DBOS.getWorkflowStatus(id))?.status;
        };
        expect(await waitForCancelled(bId)).toBe("CANCELLED");
        expect(await waitForCancelled(aId)).toBe("CANCELLED");
        expect(await waitForCancelled(cId)).toBe("CANCELLED");

        // B's LLM step ran exactly once on attempt:0.
        expect(bExecutionCount).toBe(1);
        // A and C may or may not have entered their first tick before the
        // cascade-cancel landed — depends on DBOS scheduling vs the speed of
        // B's synchronous 402 throw. The hard invariant is they didn't go
        // beyond a handful of iterations.
        expect(aExecutionCount).toBeLessThan(30);
        expect(cExecutionCount).toBeLessThan(30);
        const aRanBefore = aExecutionCount;
        const cRanBefore = cExecutionCount;

        // ── Phase 2: simulate top-up → flip toggle → resume children ──────
        bShouldFail = false;

        // Production-equivalent resume: bump attempt (out-of-band here), then
        // resume each cancelled child. The attempt-suffixed step name on the
        // new child workflow misses the DBOS cache and runs fresh.
        //
        // Note: DBOS.resumeWorkflow on a CANCELLED workflow re-runs the body
        // from the start; durable steps with the SAME name return cached
        // values, fresh names re-execute. The retry of child B uses
        // attempt:1, so `llm:0:1` is a fresh cache key.
        await DBOS.resumeWorkflow(aId);
        await DBOS.resumeWorkflow(cId);

        // Wait for A and C to land — both should reach SUCCESS without
        // re-executing their cached steps (counters should be unchanged).
        const aResumed = await DBOS.retrieveWorkflow<ChildResult>(aId).getResult();
        const cResumed = await DBOS.retrieveWorkflow<ChildResult>(cId).getResult();
        expect(aResumed.status).toBe("complete");
        expect(cResumed.status).toBe("complete");

        // KEY ASSERTION: A and C completed iteration N of `child-tick:N:0`.
        // The cancel happened mid-loop; on resume, EVERY iteration's runStep
        // has a unique attempt-0 name, so cached iterations return without
        // running their closure, and uncached iterations run forward. The
        // counter therefore reaches `iterations` (30) total, but only the
        // iterations that did NOT cache execute their closure. Concretely:
        // aRanBefore is the number of iterations completed pre-cancel; total
        // execution count on resume is 30 (one per uncached iteration).
        expect(aExecutionCount).toBe(30);
        expect(cExecutionCount).toBe(30);
        // Cached iterations did not re-execute — total ran = 30 (= iterations),
        // not 30 + aRanBefore. If DBOS were re-executing cached steps, the
        // total would be aRanBefore + 30 = up to 60. (When aRanBefore is 0
        // the inequality is `<= 30 + 0`, i.e. the resumed run executed at
        // most `iterations` closures — no double-execution.)
        expect(aExecutionCount).toBeLessThanOrEqual(aRanBefore + 30);
        expect(cExecutionCount).toBeLessThanOrEqual(cRanBefore + 30);

        // Resume B — but with attempt=1 driving a fresh step name. Production
        // achieves this by starting a NEW child workflow (the parent's
        // re-dispatch path on resume picks attempt from the bumped counter).
        // Plain `DBOS.resumeWorkflow(bId)` would re-run B with the ORIGINAL
        // attempt=0 — `llm:0:0` hits the cached 402-throwing step and B
        // would crash the same way. Flag: production must NOT rely on
        // resumeWorkflow(childId) for budget-exceeded children. Instead the
        // parent must dispatch a fresh child workflow with the bumped attempt.
        //
        // We simulate that: dispatch a new child with the bumped attempt.
        const bRetryId = `${bId}-retry`;
        const bRetryHandle = await DBOS.startWorkflow(budgetExceededChild, {
            workflowID: bRetryId,
        })({ attempt: 1 });
        const bRetryResult = await bRetryHandle.getResult();

        expect(bRetryResult.status).toBe("complete");
        // B's LLM step executed once more — attempt:0 (failed) + attempt:1
        // (fresh, succeeded) = 2 total executions.
        expect(bExecutionCount).toBe(2);
    }, 60_000);

    it("B: prepareExecuteAnalysisResume bumps attempt_count atomically and throws MissingRunError for unknown wf", async () => {
        const pool = rig.pool;
        const analysisId = "a-budget-resume";
        // run_id IS the workflow id — the `cortex_runs.workflow_id` column was
        // dropped (both are the same bare UUID; lookups go by run_id).
        const runId = "run-budget-resume";
        const now = new Date().toISOString();

        await pool.query(
            `INSERT INTO cortex_analysis_state
        (analysis_id, status, context, billing_context, data_profile_status, created_at, updated_at)
       VALUES ($1, 'suspended_insufficient_funds', NULL, NULL, 'pending', $2, $2)`,
            [analysisId, now],
        );

        await pool.query(
            `INSERT INTO cortex_runs
        (run_id, analysis_id, thread_id, workflow_name,
         status, started_at, completed_at, error, attempt_count)
       VALUES ($1, $2, NULL, 'executeAnalysis',
               'canceled', $3, $3, 'budget_exceeded', 0)`,
            [runId, analysisId, now],
        );

        // First call bumps 0 → 1.
        const prepared = await prepareExecuteAnalysisResume(pool, runId);
        expect(prepared.runId).toBe(runId);
        expect(prepared.workflowId).toBe(runId);
        expect(prepared.attempt).toBe(1);
        expect(prepared.previousStatus).toBe("canceled");

        // Second call bumps 1 → 2.
        const prepared2 = await prepareExecuteAnalysisResume(pool, runId);
        expect(prepared2.attempt).toBe(2);

        // Unknown run id → MissingRunError.
        await expect(prepareExecuteAnalysisResume(pool, "wf-does-not-exist")).rejects.toThrow(MissingRunError);
    });

    it("C: parent runExecuteAnalysisBody self-cancels to CANCELLED on 402 (so resumeWorkflow is not a no-op)", async () => {
        const analysisId = "a-budget-parent-cancel";
        const planId = "plan-budget-parent-cancel";

        await upsertAnalysis(rig.pool, analysisId, null, null);
        await rig.pool.query(
            `INSERT INTO cortex_plans (plan_id, analysis_id, plan, parent_plan_id, created_at)
         VALUES ($1, $2, $3::jsonb, NULL, $4)`,
            [planId, analysisId, JSON.stringify({ steps: [] }), new Date().toISOString()],
        );

        // Track every dep the parent body invokes — proves close + revoke
        // ran BEFORE the self-cancel landed.
        const order: string[] = [];
        const deps: ExecuteAnalysisDeps = {
            pool: rig.pool,
            provider: {} as unknown as ChatProvider,
            embedding: {} as unknown as EmbeddingProvider,
            sandboxStepCallable: testCChild,
            sessionsBasePath: BUDGET_TEST_SESSIONS_DIR,
            synthesisModel: "test-model",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
            synthesisEnabled: false,
            runCharge: {
                open: async () => {
                    order.push("openRunningCharge");
                },
                close: async ({ reason }) => {
                    order.push(`closeRunningCharge:${reason}`);
                },
            },
            runAuthorizer: {
                async authorize() {
                    throw new Error("runAuthorizer.authorize not exercised");
                },
                async revoke(_authorization, reason) {
                    order.push(`revokeMandate:${reason}`);
                },
            },
        };

        testCDepsRef.value = deps;
        const parentId = rig.nextWorkflowId("test-c-parent-");
        const parentHandle = await DBOS.startWorkflow(testCParent, {
            workflowID: parentId,
        })({ analysisId, planId, threadId: null });

        // Parent self-cancels — getResult throws DBOSWorkflowCancelledError.
        let threw = false;
        let thrownErr: unknown = null;
        try {
            await parentHandle.getResult();
        } catch (err) {
            threw = true;
            thrownErr = err;
        }
        expect(threw).toBe(true);
        expect(thrownErr).toBeInstanceOf(DBOSErrors.DBOSWorkflowCancelledError);

        // Parent workflow durable status is CANCELLED — the precondition
        // for `DBOS.resumeWorkflow` to actually re-run the body. Before the
        // fix this would have been SUCCESS, and resume was a no-op.
        const status = (await DBOS.getWorkflowStatus(parentId))?.status;
        expect(status).toBe("CANCELLED");

        // Side-effect ordering on the budget path: persist + suspend +
        // close-budget + revoke-suspended all ran BEFORE self-cancel —
        // billing closes cleanly even though the workflow lands CANCELLED.
        // The analysis flipped to suspended_insufficient_funds in-body on the
        // 402 pause path; billing closed with budget_exceeded then the mandate
        // was revoked workflow-suspended — all BEFORE the self-cancel landed.
        const suspendedC = (await rig.pool.query<{ status: string }>(`SELECT status FROM cortex_analysis_state WHERE analysis_id = $1`, [analysisId])).rows[0]
            ?.status;
        expect(suspendedC).toBe("suspended_insufficient_funds");
        expect(order).toContain("closeRunningCharge:budget_exceeded");
        expect(order).toContain("revokeMandate:workflow-suspended");
        expect(order.indexOf("closeRunningCharge:budget_exceeded")).toBeLessThan(order.indexOf("revokeMandate:workflow-suspended"));

        // resumeWorkflow on a CANCELLED workflow is NOT a no-op — DBOS
        // flips status NOT IN ('SUCCESS','ERROR') to ENQUEUED. We don't
        // re-drive the body here (would need a top-up flag wired through
        // the deps), but we DO assert resumeWorkflow itself reports the
        // workflow as reschedulable.
        await DBOS.resumeWorkflow(parentId);
        const afterResume = await DBOS.getWorkflowStatus(parentId);
        // After resume, status is no longer CANCELLED — DBOS moved it
        // forward (ENQUEUED/PENDING/etc. depending on engine timing).
        expect(afterResume?.status).not.toBe("CANCELLED");
    }, 60_000);

    it("D: production self-cancel path — parent classifies via side-channel (not isBudgetExceeded fallback)", async () => {
        // This test exercises the REAL production self-cancel path: the
        // child sends a `child-budget-exceeded` notification to the parent,
        // then DBOS.cancelWorkflow(self), then a post-cancel runStep that
        // raises DBOSWorkflowCancelledError. The parent observes that
        // generic-message error via `getResult` — which `isBudgetExceeded`
        // CANNOT match — and must classify the cancel as budget_exceeded
        // via the side-channel recv accumulator. Without the fix the parent
        // would land on fail-fast and the 402 pause cascade
        // (suspendAnalysis + closeRunningCharge:budget_exceeded +
        // revokeMandate:workflow-suspended) would NEVER run.
        const analysisId = "a-budget-prod-cancel";
        const planId = "plan-budget-prod-cancel";

        await upsertAnalysis(rig.pool, analysisId, null, null);
        await rig.pool.query(
            `INSERT INTO cortex_plans (plan_id, analysis_id, plan, parent_plan_id, created_at)
         VALUES ($1, $2, $3::jsonb, NULL, $4)`,
            [planId, analysisId, JSON.stringify({ steps: [] }), new Date().toISOString()],
        );

        const order: string[] = [];
        const deps: ExecuteAnalysisDeps = {
            pool: rig.pool,
            provider: {} as unknown as ChatProvider,
            embedding: {} as unknown as EmbeddingProvider,
            sandboxStepCallable: testDChild,
            sessionsBasePath: BUDGET_TEST_SESSIONS_DIR,
            synthesisModel: "test-model",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
            synthesisEnabled: false,
            runCharge: {
                open: async () => {
                    order.push("openRunningCharge");
                },
                close: async ({ reason }) => {
                    order.push(`closeRunningCharge:${reason}`);
                },
            },
            runAuthorizer: {
                async authorize() {
                    throw new Error("runAuthorizer.authorize not exercised");
                },
                async revoke(_authorization, reason) {
                    order.push(`revokeMandate:${reason}`);
                },
            },
        };

        testDDepsRef.value = deps;
        const parentId = rig.nextWorkflowId("test-d-parent-");
        const parentHandle = await DBOS.startWorkflow(testDParent, {
            workflowID: parentId,
        })({ analysisId, planId, threadId: null });

        let threw = false;
        let thrownErr: unknown = null;
        try {
            await parentHandle.getResult();
        } catch (err) {
            threw = true;
            thrownErr = err;
        }
        // Parent self-cancelled (the budget_exceeded branch in
        // runExecuteAnalysisBody runs `cancelWorkflow(self)` + a runStep,
        // landing CANCELLED). `getResult` surfaces DBOSWorkflowCancelledError.
        expect(threw).toBe(true);
        expect(thrownErr).toBeInstanceOf(DBOSErrors.DBOSWorkflowCancelledError);

        const parentStatus = (await DBOS.getWorkflowStatus(parentId))?.status;
        expect(parentStatus).toBe("CANCELLED");

        // The classifier read budget_exceeded from the side-channel set —
        // the assertions below would FAIL without the fix because the
        // parent would have closed the charge with "error" (fail_fast) and
        // revoked the mandate with workflow-failed.
        const suspendedD = (await rig.pool.query<{ status: string }>(`SELECT status FROM cortex_analysis_state WHERE analysis_id = $1`, [analysisId])).rows[0]
            ?.status;
        expect(suspendedD).toBe("suspended_insufficient_funds");
        expect(order).toContain("closeRunningCharge:budget_exceeded");
        expect(order).toContain("revokeMandate:workflow-suspended");
        // Explicitly NOT the fail-fast reasons.
        expect(order).not.toContain("closeRunningCharge:error");
        expect(order).not.toContain("revokeMandate:workflow-failed");
    }, 60_000);
});
