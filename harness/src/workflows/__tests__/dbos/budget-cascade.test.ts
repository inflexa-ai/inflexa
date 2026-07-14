/**
 * 402 budget-pause cascade — the parent self-cancels to CANCELLED.
 *
 * When a child hits a 402 budget-exceeded error it self-cancels to CANCELLED
 * (not ERROR) and notifies the parent over the `child-budget-exceeded`
 * side-channel. The parent runs its terminal cleanup — flip the analysis to
 * `suspended_insufficient_funds`, close the run charge with `budget_exceeded`,
 * revoke the run authorization with `workflow-suspended` — then self-cancels to
 * CANCELLED so the pause is a durably reschedulable state.
 *
 * Wiring the full server end-to-end would require standing up the whole host,
 * so these tests drive the production parent (`runExecuteAnalysisBody`) against
 * a stubbed deps bundle and a test-local child workflow:
 *
 *   Test C — parent self-cancels to CANCELLED on 402, with close-charge +
 *     revoke ordered before the self-cancel and the analysis suspended.
 *
 *   Test D — the production self-cancel path: the child sends the
 *     `child-budget-exceeded` notification before self-cancelling, and the
 *     parent classifies the cancel via the side-channel accumulator rather than
 *     the `isBudgetExceeded` fallback (which cannot match the generic
 *     DBOSWorkflowCancelledError `getResult` surfaces).
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
import { BUDGET_EXCEEDED_TOPIC, type BudgetExceededNotification, type SandboxStepInput, type SandboxStepResult } from "../../sandbox-step.js";
import type { AnalysisStep } from "../../../schemas/workflow-state.js";

/** The plan data the parent composes S1's seed from at dispatch. */
const S1_PLAN_STEP: AnalysisStep = {
    id: "S1",
    name: "S1",
    track: "T1",
    step_type: "analysis",
    question: "noop",
    acceptance_criteria: ["noop"],
    depends_on: [],
    status: "pending",
    resources: { cpu: 2, memoryGb: 4 },
    agent: "scientific-executor",
    maxSteps: 10,
};

// Reopen the registration window if an earlier test file already launched
// the shared DBOS engine: a plain shutdown (no `deregister`) keeps every
// prior registration and lets this module's top-level `registerWorkflow`
// calls through; `beforeAll` relaunches via `DBOS.launch()`.
if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

// ── Test C child: minimal child workflow that throws budget_exceeded ──
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
            { name: "llm" },
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
                planStepById: { S1: S1_PLAN_STEP },
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
// Mirrors sandbox-step.ts EXACTLY — the child sends the
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
                planStepById: { S1: S1_PLAN_STEP },
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

describe("402 budget-pause cascade — parent self-cancel", () => {
    it("C: parent runExecuteAnalysisBody self-cancels to CANCELLED on 402 (so resumeWorkflow is not a no-op)", async () => {
        const analysisId = "a-budget-parent-cancel";
        const planId = "plan-budget-parent-cancel";

        (await upsertAnalysis(rig.pool, analysisId, null, null))._unsafeUnwrap();
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
            resolveWorkspaceRoot: (id: string) => join(BUDGET_TEST_SESSIONS_DIR, id),
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
        // for `DBOS.resumeWorkflow` to actually re-run the body.
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

        (await upsertAnalysis(rig.pool, analysisId, null, null))._unsafeUnwrap();
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
            resolveWorkspaceRoot: (id: string) => join(BUDGET_TEST_SESSIONS_DIR, id),
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
