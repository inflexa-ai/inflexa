/**
 * A rerun of an `execute_analysis` call inside a workflow, against the real engine.
 *
 * The turn workflow runs the tool in a step named for its call, the way the loop does. The step parks after
 * the launch until the test cancels the workflow from outside, which is a crash after the launch and before
 * the checkpoint of the step. The resume runs the step again. The run id comes from the workflow and the
 * call, thus the rerun reserves and launches the same run, and the enqueue of the launcher starts nothing
 * new.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DBOS, type DBOSClient } from "@dbos-inc/dbos-sdk";
import { setTimeout as sleep } from "node:timers/promises";

import { recoverAtCrashPoint } from "../../../../__tests__/setup/dbos-crash.js";
import { setupDbosForTests, type DbosTestRig } from "../../../../__tests__/setup/dbos.js";
import { createLocalRunAuthorizer } from "../../../../auth/local-run-authorizer.js";
import { makeLocalAuth } from "../../../../auth/local-auth-context.js";
import { createDbosRunLauncher } from "../../../../execution/dbos-run-launcher.js";
import { dbosClientFor } from "../../../../execution/dbos-workflow-purger.js";
import { createNoopLogger } from "../../../../lib/console-logger.js";
import { unusedChatProvider } from "../../../../providers/__fixtures__/chat-provider.js";
import { upsertAnalysis, upsertPlan } from "../../../../state/index.js";
import { makeToolContext } from "../../../../tools/__fixtures__/tool-context.js";
import { callRunId } from "../../../../tools/analysis-invocation.js";
import type { ToolContext } from "../../../../tools/define-tool.js";
import { createExecuteAnalysisTool } from "../../../../tools/execute-analysis.js";
import type { ExecuteAnalysisInput, ExecuteAnalysisResult } from "../../../execute-analysis.js";

// Reopen the registration window if an earlier test file already launched
// the shared DBOS engine (see "Registration window" in workflow-replay.test.ts).
if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

const ANALYSIS_ID = "analysis-rerun-1";
const PLAN_ID = "pln-0a0b0c0d";
const SECOND_PLAN_ID = "pln-1a1b1c1d";

/** The run workflow. It counts its starts, thus a second start of one run shows. */
const runStarts: string[] = [];
const runWorkflow = DBOS.registerWorkflow(
    async (_input: ExecuteAnalysisInput): Promise<ExecuteAnalysisResult> => {
        const workflowId = DBOS.workflowID ?? "";
        runStarts.push(workflowId);
        return Promise.resolve({ runId: workflowId, workflowId, status: "completed", completedSteps: [], failedSteps: [], canceledSteps: [] });
    },
    { name: "execute-analysis-rerun-run" },
);

let tool: ReturnType<typeof createExecuteAnalysisTool> | undefined;
let parked = false;
let release: (() => void) | undefined;

/** Let the next turn park again. A function keeps the reset out of the narrowing of each test body. */
function resetPark(): void {
    parked = false;
    release = undefined;
}

function callContext(callId: string): ToolContext {
    const { ctx } = makeToolContext();
    return {
        ...ctx,
        invocationId: callId,
        session: { ...ctx.session, scope: { kind: "analysis", analysisId: ANALYSIS_ID, threadId: "thread-1" }, auth: makeLocalAuth() },
    };
}

/** The turn: one tool call in a step. The first attempt parks after the launch. */
const turn = DBOS.registerWorkflow(
    async (callId: string, planId: string): Promise<string> =>
        DBOS.runStep(
            async () => {
                if (tool === undefined) throw new Error("the tool is built before the turn starts");
                const launched = (await tool.execute({ mode: "plan", planId }, callContext(callId)))._unsafeUnwrap();
                if (!parked) {
                    parked = true;
                    await new Promise<void>((resolve) => {
                        release = resolve;
                    });
                }
                return launched.runId;
            },
            { name: `execute_analysis.${callId}` },
        ),
    { name: "execute-analysis-rerun-turn" },
);

let rig: DbosTestRig;

beforeAll(async () => {
    rig = await setupDbosForTests("execute_analysis_rerun");
    if (!DBOS.isInitialized()) await DBOS.launch();
    (await upsertAnalysis(rig.pool, ANALYSIS_ID, null))._unsafeUnwrap();
    const plan = {
        analytical_narrative: "rerun plan",
        created_at: "2026-01-01T00:00:00Z",
        steps: [
            {
                id: "step-a",
                name: "Step a",
                track: "test",
                step_type: "analysis",
                question: "do a",
                acceptance_criteria: ["completes"],
                depends_on: [],
                agent: "bulk-transcriptomics-agent",
                resources: { cpu: 1, memoryGb: 4 },
                maxSteps: 30,
            },
        ],
    };
    (await upsertPlan(rig.pool, { planId: PLAN_ID, analysisId: ANALYSIS_ID, plan }))._unsafeUnwrap();
    (await upsertPlan(rig.pool, { planId: SECOND_PLAN_ID, analysisId: ANALYSIS_ID, plan }))._unsafeUnwrap();
    tool = createExecuteAnalysisTool({
        pool: rig.pool,
        executeAnalysisWorkflow: runWorkflow,
        runAuthorizer: createLocalRunAuthorizer(),
        runLauncher: createDbosRunLauncher({ pool: rig.pool }),
        utilityProvider: unusedChatProvider(),
        utilityModel: "utility-model",
    });
});

afterAll(async () => {
    await rig.drop();
});

describe("a rerun of an execute_analysis call", () => {
    it("gives the same run id, and no second run starts", async () => {
        const wfId = rig.nextWorkflowId("execute-analysis-rerun-");
        const first = await DBOS.startWorkflow(turn, { workflowID: wfId })("call-1", PLAN_ID);
        // The parked step ends only when the test releases it after the cancel.
        const ended = (async (): Promise<void> => {
            while ((await DBOS.getWorkflowStatus(wfId))?.status !== "CANCELLED") await sleep(25);
            release?.();
            await first.getResult().catch(() => undefined);
        })();

        const handle = await recoverAtCrashPoint<string>(wfId, () => parked, { ended });
        const runId = await handle.getResult();

        expect(runId).toBe(callRunId(`${wfId}:call-1`));
        expect(await DBOS.retrieveWorkflow<ExecuteAnalysisResult>(runId).getResult()).toMatchObject({ runId, status: "completed" });
        const steps = await DBOS.listWorkflowSteps(wfId);
        expect(steps?.map((step) => step.name)).toEqual(["execute_analysis.call-1"]);
        const { rows } = await rig.pool.query<{ run_id: string }>("SELECT run_id FROM cortex_runs");
        expect(rows.map((row) => row.run_id)).toEqual([runId]);
        expect(runStarts).toEqual([runId]);
    });

    it("keeps a live run out of the failed state when the enqueue of the rerun fails", async () => {
        resetPark();
        const wfId = rig.nextWorkflowId("execute-analysis-rerun-");
        const first = await DBOS.startWorkflow(turn, { workflowID: wfId })("call-2", SECOND_PLAN_ID);
        const ended = (async (): Promise<void> => {
            while ((await DBOS.getWorkflowStatus(wfId))?.status !== "CANCELLED") await sleep(25);
            release?.();
            await first.getResult().catch(() => undefined);
        })();
        // The launcher reads the client of its pool, thus a fault of this client is a fault of the second enqueue.
        const client: DBOSClient = await dbosClientFor(rig.pool, createNoopLogger());
        const enqueue = client.enqueue.bind(client);
        while (!parked) await sleep(25);
        Reflect.set(client, "enqueue", () => Promise.reject(new Error("connection reset")));

        try {
            const handle = await recoverAtCrashPoint<string>(wfId, () => parked, { ended });
            const runId = await handle.getResult();

            expect(runId).toBe(callRunId(`${wfId}:call-2`));
            const { rows } = await rig.pool.query<{ status: string }>("SELECT status FROM cortex_runs WHERE run_id = $1", [runId]);
            expect(rows.map((row) => row.status)).toEqual(["running"]);
            expect(runStarts.filter((started) => started === runId)).toEqual([runId]);
        } finally {
            Reflect.set(client, "enqueue", enqueue);
        }
    });
});
