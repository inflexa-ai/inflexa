/**
 * The suspension cascade — the parent self-cancels to CANCELLED.
 *
 * A child that suspends records the reason on its row, sends its typed
 * suspension on the `child-suspended` topic, and self-cancels to CANCELLED
 * (not ERROR). The parent reads the kind of that message, never a reason
 * string. It runs its terminal cleanup — flip the analysis to
 * `suspended_insufficient_funds`, close the run charge with the outcome
 * `{ kind: "suspended", reason }`, revoke the run authorization with
 * `workflow-suspended` — then self-cancels to CANCELLED so the suspension is a
 * durably reschedulable state.
 *
 * Wiring the full server end-to-end would require standing up the whole host,
 * so these tests drive the production parent (`runExecuteAnalysisBody`) against
 * a stubbed deps bundle and a test-local child workflow:
 *
 *   Test C — a child that throws the text `budget_exceeded` and sends no typed
 *     suspension is a failed step: the text of an error never suspends a run.
 *
 *   Test D — the production path: the child sends its typed suspension before
 *     it self-cancels, and the parent suspends the run with the reason of the
 *     host, then self-cancels to CANCELLED.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLocalAuth } from "../../../auth/local-auth-context.js";
import { DBOS, Error as DBOSErrors } from "@dbos-inc/dbos-sdk";

import { okAsync } from "neverthrow";

import type { ChatProvider, EmbeddingProvider } from "../../../providers/types.js";
import { createWorkingMemory } from "../../../memory/working-memory.js";
import { upsertAnalysis } from "../../../state/index.js";

/** Writable sessions root the in-body `init-run-filesystem` mkdir targets. */
const SUSPENSION_TEST_SESSIONS_DIR = join(tmpdir(), "cortex-suspension-cascade-test");
import { setupDbosForTests, type DbosTestRig } from "../../../__tests__/setup/dbos.js";
import { runExecuteAnalysisBody, type ExecuteAnalysisDeps } from "../../execute-analysis.js";
import { CHILD_SUSPENDED_TOPIC, type ChildSuspended, type SandboxStepInput, type SandboxStepResult } from "../../sandbox-step.js";
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

// ── Test C child: a child workflow that throws the text budget_exceeded ──
//
// Drives the real `runExecuteAnalysisBody` against a stubbed deps bundle.
// The child throws an error whose text names a budget and carries a 402, and
// it sends no typed suspension. The parent must read that as a failed step.
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
    { name: "test-c-text-child" },
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
                synthesisEnabled: false,
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

// ── Test D: the production suspension path ─────────────────────────────
//
// Mirrors sandbox-step.ts — the child sends its typed suspension BEFORE
// `DBOS.cancelWorkflow(self)`, then a post-cancel `DBOS.runStep` raises
// DBOSWorkflowCancelledError. The parent's `getResult` then throws that
// cancellation, and the parent reads the suspension from the kind of the
// message that its recv accumulator already holds.
const testDChild = DBOS.registerWorkflow(
    async (input: SandboxStepInput): Promise<SandboxStepResult> => {
        const childWorkflowId = DBOS.workflowID!;
        const message: ChildSuspended = { kind: "suspended", childWorkflowId, stepId: input.stepId, reason: "payment_required" };
        await DBOS.runStep(() => DBOS.send(input.parentWorkflowId, message, CHILD_SUSPENDED_TOPIC), { name: "notify-parent-suspended" });
        await DBOS.cancelWorkflow(childWorkflowId);
        // Post-cancel runStep raises DBOSWorkflowCancelledError — the same
        // cancellation that production children surface.
        await DBOS.runStep(async () => null, { name: "self-cancel-suspended" });
        // Unreachable.
        return {
            status: "canceled",
            durationMs: 0,
            finishReason: null,
            error: "payment_required",
        };
    },
    { name: "test-d-suspension-child" },
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
                synthesisEnabled: false,
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
    rig = await setupDbosForTests("suspension_cascade");
    // Relaunch when the module-top registration-window bounce stopped the
    // engine; a no-op when the rig's lazy launch above did the launching.
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    if (rig) await rig.drop();
});

describe("the suspension cascade — parent self-cancel", () => {
    it("C: a child that throws the text budget_exceeded and sends no typed suspension fails the run, and nothing suspends", async () => {
        const analysisId = "a-text-not-suspension";
        const planId = "plan-text-not-suspension";

        (await upsertAnalysis(rig.pool, analysisId, null))._unsafeUnwrap();
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
            sandboxStepCallable: testCChild,
            resolveWorkspaceRoot: (id: string) => join(SUSPENSION_TEST_SESSIONS_DIR, id),
            workingMemory: createWorkingMemory(rig.pool),
            synthesisModel: "test-model",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
            runCharge: {
                open: () => {
                    order.push("openRunningCharge");
                    return okAsync(undefined);
                },
                close: ({ outcome }) => {
                    order.push(`closeRunningCharge:${outcome.kind === "suspended" ? `suspended:${outcome.reason}` : outcome.kind}`);
                    return okAsync(undefined);
                },
            },
            runAuthorizer: {
                authorize() {
                    throw new Error("runAuthorizer.authorize not exercised");
                },
                revoke(_authorization, reason) {
                    order.push(`revokeMandate:${reason}`);
                    return okAsync(undefined);
                },
                revokeByJti: () => okAsync(undefined),
            },
        };

        testCDepsRef.value = deps;
        const parentId = rig.nextWorkflowId("test-c-parent-");
        const parentHandle = await DBOS.startWorkflow(testCParent, {
            workflowID: parentId,
        })({ analysisId, planId, threadId: null });

        const result = await parentHandle.getResult();

        expect(result.status).toBe("failed");
        expect((await DBOS.getWorkflowStatus(parentId))?.status).toBe("SUCCESS");
        const statusC = (await rig.pool.query<{ status: string }>(`SELECT status FROM cortex_analysis_state WHERE analysis_id = $1`, [analysisId])).rows[0]
            ?.status;
        expect(statusC).toBe("active");
        expect(order).toContain("closeRunningCharge:error");
        expect(order).toContain("revokeMandate:workflow-failed");
    }, 60_000);

    it("D: the production path — the parent reads the typed suspension, suspends the run, and self-cancels to CANCELLED", async () => {
        // The child sends its typed suspension to the parent, then
        // DBOS.cancelWorkflow(self), then a post-cancel runStep that raises
        // DBOSWorkflowCancelledError. The parent observes that cancellation via
        // `getResult`, and it reads the suspension from the kind of the message
        // that its recv accumulator holds. The suspension cascade runs:
        // suspendAnalysis, the charge close with the reason of the host, and
        // the revoke with workflow-suspended.
        const analysisId = "a-suspension-prod-cancel";
        const planId = "plan-suspension-prod-cancel";

        (await upsertAnalysis(rig.pool, analysisId, null))._unsafeUnwrap();
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
            resolveWorkspaceRoot: (id: string) => join(SUSPENSION_TEST_SESSIONS_DIR, id),
            workingMemory: createWorkingMemory(rig.pool),
            synthesisModel: "test-model",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
            runCharge: {
                open: () => {
                    order.push("openRunningCharge");
                    return okAsync(undefined);
                },
                close: ({ outcome }) => {
                    order.push(`closeRunningCharge:${outcome.kind === "suspended" ? `suspended:${outcome.reason}` : outcome.kind}`);
                    return okAsync(undefined);
                },
            },
            runAuthorizer: {
                authorize() {
                    throw new Error("runAuthorizer.authorize not exercised");
                },
                revoke(_authorization, reason) {
                    order.push(`revokeMandate:${reason}`);
                    return okAsync(undefined);
                },
                revokeByJti: () => okAsync(undefined),
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
        // Parent self-cancelled (the suspension branch in
        // runExecuteAnalysisBody runs `cancelWorkflow(self)` + a runStep,
        // landing CANCELLED). `getResult` surfaces DBOSWorkflowCancelledError.
        expect(threw).toBe(true);
        expect(thrownErr).toBeInstanceOf(DBOSErrors.DBOSWorkflowCancelledError);

        const parentStatus = (await DBOS.getWorkflowStatus(parentId))?.status;
        expect(parentStatus).toBe("CANCELLED");

        // The classifier read the kind of the message — the assertions below
        // would FAIL without it, because the parent would have closed the
        // charge with "error" and revoked the mandate with workflow-failed.
        const suspendedD = (await rig.pool.query<{ status: string }>(`SELECT status FROM cortex_analysis_state WHERE analysis_id = $1`, [analysisId])).rows[0]
            ?.status;
        expect(suspendedD).toBe("suspended_insufficient_funds");
        expect(order).toContain("closeRunningCharge:suspended:payment_required");
        expect(order).toContain("revokeMandate:workflow-suspended");
        expect(order.indexOf("closeRunningCharge:suspended:payment_required")).toBeLessThan(order.indexOf("revokeMandate:workflow-suspended"));
        // Explicitly NOT the failure reasons.
        expect(order).not.toContain("closeRunningCharge:error");
        expect(order).not.toContain("revokeMandate:workflow-failed");

        // resumeWorkflow on a CANCELLED workflow is NOT a no-op — DBOS moves
        // the workflow forward, thus the suspension is reschedulable.
        await DBOS.resumeWorkflow(parentId);
        expect((await DBOS.getWorkflowStatus(parentId))?.status).not.toBe("CANCELLED");
    }, 60_000);
});
