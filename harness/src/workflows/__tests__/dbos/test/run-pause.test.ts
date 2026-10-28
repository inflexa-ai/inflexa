/**
 * The pause of a run (work-pause spec), against the real engine.
 *
 * The production parent (`runExecuteAnalysisBody`) runs over a stubbed deps bundle, and each child runs the real
 * body of a sandbox step (`runSandboxStepBody`) over a fake sandbox client, a fake artifact registry, and a scripted
 * model for each step. A cause of a pause waits in the workflow that meets it: a step in its own workflow, and the
 * charge gate in the parent. The tests read the rows of `cortex_paused_work`, the run row, and the step rows, and
 * they resume the run through the host surface.
 *
 *   - A failed model request of a step with the status 402 pauses the step. Its sibling completes, the run row stays
 *     `running`, and the resume completes the run.
 *   - A refused charge with the suspend flag pauses the run before any step, and the charge opens again after the
 *     resume.
 *   - A refused spawn and a refused registration with the suspend flag pause the step at the gate, and the step calls
 *     the gate again after the resume.
 *   - The text `budget_exceeded` in a failed request with the status 400 never pauses: the step fails.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { APICallError } from "@ai-sdk/provider";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { errAsync, okAsync } from "neverthrow";

import { setupDbosForTests, type DbosTestRig } from "../../../../__tests__/setup/dbos.js";
import { makeFakeWorkspaceFs } from "../../../../agents/sandbox/__fixtures__/deps.js";
import { createLocalRunAuthorizer } from "../../../../auth/local-run-authorizer.js";
import { createWork } from "../../../../app/work.js";
import { makeLocalAuth } from "../../../../auth/local-auth-context.js";
import type { RunChargeOutcome } from "../../../../billing/run-charge.js";
import { unusedCitationResolver } from "../../../../citations/__fixtures__/resolver.js";
import type { ArtifactRegistry } from "../../../../execution/artifact-registry.js";
import { createRunCanceler } from "../../../../execution/run-canceler.js";
import type { GateFailure } from "../../../../lib/hooks.js";
import { createWorkingMemory } from "../../../../memory/working-memory.js";
import { unusedChatProvider } from "../../../../providers/__fixtures__/chat-provider.js";
import type { SandboxClient } from "../../../../sandbox/client.js";
import type { SandboxRef } from "../../../../sandbox/types.js";
import type { AnalysisStep } from "../../../../schemas/workflow-state.js";
import { insertRun, queryRun, queryStepsByRun, upsertAnalysis } from "../../../../state/index.js";
import { queryPausesOfWork, type PauseRecord } from "../../../../state/paused-work.js";
import { reply, scriptedModel, text, type ScriptStep } from "../../../../testing.js";
import { createSynthesisLookupTools } from "../../../../tools/research/synthesis-lookups.js";
import { createSubmitFileMetadataTool } from "../../../../tools/sandbox/submit-file-metadata.js";
import { runExecuteAnalysisBody, type ExecuteAnalysisDeps, type ExecuteAnalysisResult } from "../../../execute-analysis.js";
import { runSandboxStepBody, type SandboxStepDeps, type SandboxStepInput, type SandboxStepResult } from "../../../sandbox-step.js";

/** The deps of a work surface in this file: a local run authorizer, and the stops that a test does not reach. */
const WORK_DEPS = {
    runAuthorizer: createLocalRunAuthorizer(),
    stopTurn: () => Promise.reject(new Error("no turn stops in this file")),
    runCanceler: { cancel: () => Promise.reject(new Error("no run stops in this file")) },
    stopProfile: () => Promise.reject(new Error("no profile stops in this file")),
};

// Reopen the registration window if an earlier test file already launched
// the shared DBOS engine: a plain shutdown (no `deregister`) keeps every
// prior registration and lets this module's top-level `registerWorkflow`
// calls through; `beforeAll` relaunches via `DBOS.launch()`.
if (DBOS.isInitialized()) {
    await DBOS.shutdown();
}

const AGENT_ID = "scientific-executor";

/**
 * The replies of a step whose task and post-step continuations each end on their first reply. A step with no
 * artifact sends no metadata request, thus it leaves one reply unused.
 */
const ONE_REPLY_STEP_REQUESTS = 3;
const completesStep = (): ScriptStep[] => Array.from({ length: ONE_REPLY_STEP_REQUESTS }, () => reply([text("done")]));

const failedRequest = (statusCode: number, message: string): ScriptStep => ({
    fail: new APICallError({ message, url: "https://model.test/v1/messages", requestBodyValues: {}, statusCode, isRetryable: false }),
});

const SANDBOX_REF: SandboxRef = { sandboxId: "sbx-run-pause", host: "127.0.0.1", port: 8765, backend: "docker" };

/** The values of one run: the deps of its steps and of its parent, and what the fakes saw. */
type RunCase = {
    readonly analysisId: string;
    readonly stepIds: readonly string[];
    readonly scripts: ReadonlyMap<string, ReturnType<typeof scriptedModel>>;
    readonly sandboxClient: SandboxClient;
    readonly artifactRegistry: ArtifactRegistry;
    readonly runCharge: ExecuteAnalysisDeps["runCharge"];
    /** The ids of the steps whose child workflow started, in start order. */
    readonly childStarts: string[];
    /** The charge closes and the revokes, in order. */
    readonly ends: string[];
};

const cases = new Map<string, RunCase>();
let rig: DbosTestRig;
let workspaceRoot: string;

function caseOf(runId: string): RunCase {
    const found = cases.get(runId);
    if (found === undefined) throw new Error(`no case for the run ${runId}`);
    return found;
}

function stepDeps(current: RunCase, stepId: string): SandboxStepDeps {
    const script = current.scripts.get(stepId);
    if (script === undefined) throw new Error(`no script for the step ${stepId}`);
    return {
        citationResolver: unusedCitationResolver,
        pool: rig.pool,
        runAuthorizer: createLocalRunAuthorizer(),
        provider: script.provider,
        embedding: { dimensions: 3, embed: (texts: readonly string[]) => okAsync(texts.map(() => [0, 0, 0])) },
        sandboxClient: current.sandboxClient,
        artifactRegistry: current.artifactRegistry,
        workspaceFs: makeFakeWorkspaceFs(),
        resolveWorkspaceRoot: () => Promise.resolve(workspaceRoot),
        model: "test-step-model",
        buildAgent: ({ fileMetadata }) =>
            Promise.resolve({
                id: AGENT_ID,
                systemPrompt: "you are a test step agent",
                model: "test-step-model",
                tools: [createSubmitFileMetadataTool(fileMetadata)],
                maxIterations: 4,
            }),
        resolveWritePrefix: (input) => Promise.resolve(join(workspaceRoot, "runs", input.runId, input.stepId)),
    };
}

const sandboxStep = DBOS.registerWorkflow(
    async (input: SandboxStepInput): Promise<SandboxStepResult> => {
        const current = caseOf(input.runId);
        current.childStarts.push(input.stepId);
        return runSandboxStepBody(input, stepDeps(current, input.stepId));
    },
    { name: "run-pause-sandbox-step" },
);

function parentDeps(current: RunCase): ExecuteAnalysisDeps {
    return {
        pool: rig.pool,
        provider: unusedChatProvider(),
        embedding: { dimensions: 3, embed: (texts) => okAsync(texts.map(() => [0, 0, 0])) },
        sandboxStepCallable: sandboxStep,
        resolveWorkspaceRoot: () => Promise.resolve(workspaceRoot),
        workingMemory: createWorkingMemory(rig.pool),
        synthesisModel: "test-model",
        synthesisLookups: createSynthesisLookupTools({ bioKeys: { drugbank: "", disgenet: "", epaCcte: "" }, citationResolver: unusedCitationResolver }),
        runCharge: current.runCharge,
        runAuthorizer: {
            authorize() {
                throw new Error("runAuthorizer.authorize not exercised");
            },
            revoke(_runSession, reason) {
                current.ends.push(`revoke:${reason}`);
                return okAsync(undefined);
            },
            revokeByMandateId: () => okAsync(undefined),
            suspend: () => okAsync(undefined),
            renew: () => okAsync(undefined),
        },
    };
}

function planStep(id: string): AnalysisStep {
    return {
        id,
        name: id,
        track: "T1",
        step_type: "analysis",
        question: "noop",
        acceptance_criteria: ["noop"],
        depends_on: [],
        status: "pending",
        resources: { cpu: 2, memoryGb: 4 },
        agent: AGENT_ID,
        maxSteps: 10,
    };
}

const parent = DBOS.registerWorkflow(
    async (input: { analysisId: string; planId: string }): Promise<ExecuteAnalysisResult> => {
        const runId = DBOS.workflowID;
        if (runId === undefined) throw new Error("the run has no workflow id");
        const current = caseOf(runId);
        return runExecuteAnalysisBody(
            {
                analysisId: input.analysisId,
                planId: input.planId,
                planSummary: "test plan",
                threadId: null,
                steps: current.stepIds.map((id) => ({ id, depends_on: [] })),
                planStepById: Object.fromEntries(current.stepIds.map((id) => [id, planStep(id)])),
                agentByStepId: Object.fromEntries(current.stepIds.map((id) => [id, AGENT_ID])),
                resourcesByStepId: Object.fromEntries(current.stepIds.map((id) => [id, { cpu: 2, memoryGb: 4 }])),
                synthesisEnabled: false,
                runSession: {
                    identity: { user: "u-1" },
                    scope: { kind: "analysis", analysisId: input.analysisId },
                    provenance: { agentId: "executeAnalysis", callPath: ["executeAnalysis"] },
                    runFrame: { runId },
                    auth: makeLocalAuth(),
                },
            },
            parentDeps(current),
        );
    },
    { name: "run-pause-execute-analysis" },
);

beforeAll(async () => {
    rig = await setupDbosForTests("run_pause");
    workspaceRoot = await mkdtemp(join(tmpdir(), "cortex-run-pause-"));
    // Relaunch when the module-top registration-window bounce stopped the
    // engine; a no-op when the rig's lazy launch above did the launching.
    if (!DBOS.isInitialized()) await DBOS.launch();
});

afterAll(async () => {
    await rig.drop();
    await rm(workspaceRoot, { recursive: true, force: true });
});

function sandboxClientOf(spawn: SandboxClient["createSandbox"]): SandboxClient {
    return {
        createSandbox: spawn,
        exec: () => Promise.reject(new Error("exec: the steps run a tool-less agent")),
        isAlive: () => Promise.resolve({ alive: true, oomKilled: false }),
        isAliveById: () => Promise.resolve({ alive: true, oomKilled: false }),
        teardown: () => Promise.resolve(undefined),
        teardownById: () => Promise.resolve(undefined),
        listManagedSandboxes: () => Promise.resolve([]),
        toolchainSource: "store",
    };
}

const acceptingRegistry: ArtifactRegistry = {
    register: () => okAsync({ registered: [], failed: [], failedCount: 0 }),
    sync: () => okAsync(undefined),
};

/** Make the analysis, the plan, and the run row, and the case of the run. The run id is the id of the parent workflow. */
async function prepareRun(
    prefix: string,
    values: Partial<Pick<RunCase, "sandboxClient" | "artifactRegistry" | "runCharge">> & { readonly scripts: Readonly<Record<string, readonly ScriptStep[]>> },
): Promise<{ runId: string; planId: string; current: RunCase }> {
    const runId = rig.nextWorkflowId(`${prefix}-`);
    const analysisId = `a-${runId}`;
    const planId = `plan-${runId}`;
    (await upsertAnalysis(rig.pool, analysisId, null))._unsafeUnwrap();
    await rig.pool.query(
        `INSERT INTO cortex_plans (plan_id, analysis_id, plan, parent_plan_id, created_at)
         VALUES ($1, $2, $3::jsonb, NULL, $4)`,
        [planId, analysisId, JSON.stringify({ steps: [] }), new Date().toISOString()],
    );
    (await insertRun(rig.pool, { runId, analysisId, planId, workflowName: "executeAnalysis" }))._unsafeUnwrap();
    const ends: string[] = [];
    const current: RunCase = {
        analysisId,
        stepIds: Object.keys(values.scripts),
        scripts: new Map(Object.entries(values.scripts).map(([stepId, script]) => [stepId, scriptedModel(script)])),
        sandboxClient: values.sandboxClient ?? sandboxClientOf(() => okAsync(SANDBOX_REF)),
        artifactRegistry: values.artifactRegistry ?? acceptingRegistry,
        runCharge: values.runCharge ?? {
            open: () => okAsync(undefined),
            close: ({ outcome }: { outcome: RunChargeOutcome }) => {
                ends.push(`close:${outcome.kind}`);
                return okAsync(undefined);
            },
        },
        childStarts: [],
        ends,
    };
    cases.set(runId, current);
    return { runId, planId, current };
}

async function waitFor<T>(what: string, read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
        await sleep(50);
    }
}

/** The one row of a pause of the run in the state `paused`. */
async function waitForPause(current: RunCase, runId: string): Promise<PauseRecord> {
    return waitFor(`the pause of ${runId}`, async () => {
        const rows = (await queryPausesOfWork(rig.pool, current.analysisId, runId))._unsafeUnwrap();
        return rows.find((row) => row.state === "paused");
    });
}

async function analysisStatus(analysisId: string): Promise<string | undefined> {
    const { rows } = await rig.pool.query<{ status: string }>("SELECT status FROM cortex_analysis_state WHERE analysis_id = $1", [analysisId]);
    return rows[0]?.status;
}

function sessionOf(analysisId: string): Parameters<ReturnType<typeof createWork>["resume"]>[0] {
    return { identity: { user: "u-1" }, scope: { kind: "analysis", analysisId }, auth: makeLocalAuth() };
}

async function resume(current: RunCase, runId: string): Promise<void> {
    expect(await createWork({ pool: rig.pool, ...WORK_DEPS }).resume(sessionOf(current.analysisId), runId)).toEqual({ kind: "resumed", workflows: 1 });
}

describe("the pause of a run", () => {
    it("lists a running run with no waits as active work", async () => {
        const runId = rig.nextWorkflowId("run-active-");
        const analysisId = `a-${runId}`;
        (await upsertAnalysis(rig.pool, analysisId, null))._unsafeUnwrap();
        (await insertRun(rig.pool, { runId, analysisId, workflowName: "executeAnalysis" }))._unsafeUnwrap();
        expect(await createWork({ pool: rig.pool, ...WORK_DEPS }).list(analysisId)).toEqual([{ workId: runId, kind: "run", analysisId, waiting: [] }]);
    });

    it("a stop of a paused run cancels it, and the run leaves the active work", async () => {
        const { runId, planId, current } = await prepareRun("run-pause-stop", {
            scripts: { S1: [failedRequest(402, "Payment Required"), ...completesStep()] },
        });
        const handle = await DBOS.startWorkflow(parent, { workflowID: runId })({ analysisId: current.analysisId, planId });
        const row = await waitForPause(current, runId);

        const runCanceler = createRunCanceler({ pool: rig.pool, runCharge: current.runCharge, runAuthorizer: createLocalRunAuthorizer() });
        const surface = createWork({ pool: rig.pool, ...WORK_DEPS, runCanceler });
        expect(await surface.list(current.analysisId)).toMatchObject([
            { workId: runId, kind: "run", waiting: [{ workflowId: row.workflowId, state: "paused" }] },
        ]);
        expect(await surface.stop(sessionOf(current.analysisId), runId)).toMatchObject({ kind: "stopped", work: { workId: runId, kind: "run" } });

        await expect(handle.getResult()).rejects.toThrow("has been cancelled");
        expect((await queryRun(rig.pool, runId))._unsafeUnwrap()?.status).toBe("canceled");
        expect((await queryPausesOfWork(rig.pool, current.analysisId, runId))._unsafeUnwrap()).toEqual([]);
        expect(await surface.list(current.analysisId)).toEqual([]);
    });

    it("a step whose model request fails with a 402 pauses, its sibling completes, and a resume completes the run", async () => {
        const { runId, planId, current } = await prepareRun("run-pause-step", {
            scripts: { S1: [failedRequest(402, "Payment Required"), ...completesStep()], S2: completesStep() },
        });
        const handle = await DBOS.startWorkflow(parent, { workflowID: runId })({ analysisId: current.analysisId, planId });

        const row = await waitForPause(current, runId);
        expect(row).toMatchObject({ workId: runId, workKind: "run", analysisId: current.analysisId, cause: { kind: "host", reason: "payment_required" } });
        expect(row.workflowId).not.toBe(runId);
        // The sibling goes on during the pause of S1.
        const steps = await waitFor("the end of the sibling", async () => {
            const rows = (await queryStepsByRun(rig.pool, runId))._unsafeUnwrap();
            return rows.find((step) => step.stepId === "S2")?.status === "completed" ? rows : undefined;
        });
        expect(steps.find((step) => step.stepId === "S1")?.status).toBe("running");
        expect((await queryRun(rig.pool, runId))._unsafeUnwrap()?.status).toBe("running");
        expect((await DBOS.getWorkflowStatus(row.workflowId))?.status).toBe("PENDING");
        expect(current.ends).toEqual([]);

        await resume(current, runId);
        const result = await handle.getResult();

        expect(result.status).toBe("completed");
        expect([...result.completedSteps].sort()).toEqual(["S1", "S2"]);
        // The resumed step sent the failed request again with the same messages, thus it made one request more than its sibling.
        const calls = current.scripts.get("S1")?.calls ?? [];
        expect(calls).toHaveLength((current.scripts.get("S2")?.calls.length ?? 0) + 1);
        expect(calls[1]?.prompt).toEqual(calls[0]?.prompt);
        expect((await queryRun(rig.pool, runId))._unsafeUnwrap()?.status).toBe("completed");
        expect((await queryPausesOfWork(rig.pool, current.analysisId, runId))._unsafeUnwrap()).toEqual([]);
        expect(current.ends).toEqual(["close:ok", "revoke:workflow-completed"]);
        expect(await analysisStatus(current.analysisId)).toBe("active");
    }, 60_000);

    it("a refused charge with the suspend flag pauses the run before any step, and the steps run after the resume", async () => {
        let opens = 0;
        const ends: string[] = [];
        const { runId, planId, current } = await prepareRun("run-pause-charge", {
            scripts: { S1: completesStep() },
            runCharge: {
                open: () => {
                    opens += 1;
                    return opens === 1 ? errAsync({ reason: "no_funds", suspend: true }) : okAsync(undefined);
                },
                close: ({ outcome }) => {
                    ends.push(`close:${outcome.kind}`);
                    return okAsync(undefined);
                },
            },
        });
        const handle = await DBOS.startWorkflow(parent, { workflowID: runId })({ analysisId: current.analysisId, planId });

        const row = await waitForPause(current, runId);
        expect(row).toMatchObject({ workflowId: runId, workId: runId, workKind: "run", cause: { kind: "host", reason: "no_funds" } });
        expect(opens).toBe(1);
        expect(current.childStarts).toEqual([]);
        expect((await queryStepsByRun(rig.pool, runId))._unsafeUnwrap()).toEqual([]);
        expect((await queryRun(rig.pool, runId))._unsafeUnwrap()?.status).toBe("running");
        expect(await analysisStatus(current.analysisId)).toBe("active");

        await resume(current, runId);
        const result = await handle.getResult();

        expect(opens).toBe(2);
        expect(result.status).toBe("completed");
        expect(current.childStarts).toEqual(["S1"]);
        expect(ends).toEqual(["close:ok"]);
        expect((await queryPausesOfWork(rig.pool, current.analysisId, runId))._unsafeUnwrap()).toEqual([]);
    }, 60_000);

    it("a refused spawn with the suspend flag pauses the step before any machine, and the step spawns again after the resume", async () => {
        let attempts = 0;
        const machines: string[] = [];
        const { runId, planId, current } = await prepareRun("run-pause-spawn", {
            scripts: { S1: completesStep() },
            sandboxClient: sandboxClientOf(() => {
                attempts += 1;
                if (attempts === 1) return errAsync({ type: "labels_refused" as const, op: "createSandbox", reason: "account_frozen", suspend: true });
                machines.push(SANDBOX_REF.sandboxId);
                return okAsync(SANDBOX_REF);
            }),
        });
        const handle = await DBOS.startWorkflow(parent, { workflowID: runId })({ analysisId: current.analysisId, planId });

        const row = await waitForPause(current, runId);
        expect(row).toMatchObject({ workId: runId, workKind: "run", cause: { kind: "host", reason: "account_frozen" } });
        expect(attempts).toBe(1);
        expect(machines).toEqual([]);
        expect(current.scripts.get("S1")?.calls).toEqual([]);

        await resume(current, runId);
        const result = await handle.getResult();

        expect(result.status).toBe("completed");
        expect(attempts).toBe(2);
        expect(machines).toEqual([SANDBOX_REF.sandboxId]);
        expect((await queryPausesOfWork(rig.pool, current.analysisId, runId))._unsafeUnwrap()).toEqual([]);
    }, 60_000);

    it("a refused registration with the suspend flag pauses the step, and the step registers again after the resume", async () => {
        const order: string[] = [];
        const refusal: GateFailure = { reason: "r", suspend: true };
        const { runId, planId, current } = await prepareRun("run-pause-register", {
            scripts: { S1: completesStep() },
            artifactRegistry: {
                register: () => {
                    order.push("register");
                    if (order.filter((op) => op === "register").length === 1) return errAsync(refusal);
                    return okAsync({ registered: [], failed: [], failedCount: 0 });
                },
                sync: () => {
                    order.push("sync");
                    return okAsync(undefined);
                },
            },
        });
        // An output file of the step, thus the manifest is not empty and the registration runs.
        const output = join(workspaceRoot, "runs", runId, "S1", "output");
        await mkdir(output, { recursive: true });
        await writeFile(join(output, "result.csv"), "gene,count\nTP53,7\n");
        const handle = await DBOS.startWorkflow(parent, { workflowID: runId })({ analysisId: current.analysisId, planId });

        const row = await waitForPause(current, runId);
        expect(row).toMatchObject({ workId: runId, workKind: "run", cause: { kind: "host", reason: "r" } });
        expect(order).toEqual(["register", "sync"]);

        await resume(current, runId);
        const result = await handle.getResult();

        expect(result.status).toBe("completed");
        expect(order).toEqual(["register", "sync", "register", "sync"]);
        expect((await queryPausesOfWork(rig.pool, current.analysisId, runId))._unsafeUnwrap()).toEqual([]);
    }, 60_000);

    it("the text budget_exceeded in a failed request with the status 400 does not pause: the step fails", async () => {
        const { runId, planId, current } = await prepareRun("run-pause-text", {
            scripts: { S1: [failedRequest(400, "billing gateway: budget_exceeded for VK vk_test")] },
        });
        const handle = await DBOS.startWorkflow(parent, { workflowID: runId })({ analysisId: current.analysisId, planId });

        const result = await handle.getResult();

        expect(result.status).toBe("failed");
        expect(result.failedSteps).toEqual(["S1"]);
        expect((await DBOS.getWorkflowStatus(runId))?.status).toBe("SUCCESS");
        expect((await queryPausesOfWork(rig.pool, current.analysisId, runId))._unsafeUnwrap()).toEqual([]);
        expect((await queryRun(rig.pool, runId))._unsafeUnwrap()?.status).toBe("failed");
        expect(current.ends).toEqual(["close:error", "revoke:workflow-failed"]);
        expect(await analysisStatus(current.analysisId)).toBe("active");
    }, 60_000);
});
