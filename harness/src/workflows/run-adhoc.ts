/**
 * A plan-less, one-step durable run. The body supplies only the run/step ledger
 * and briefing; the existing sandbox-step workflow owns execution, artifacts,
 * summaries, progress, and sandbox lifecycle.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Pool } from "pg";

import { forStep, type RunSession } from "../auth/types.js";
import type { ResourcePolicy, ResourceSpec } from "../config/resource-limits.js";
import type { RunAuthorizer } from "../execution/run-authorizer.js";
import { unwrapOrThrow } from "../lib/result.js";
import { composeAdhocBriefing } from "../prompts/briefing.js";
import { insertRun, loadDataProfileStatus, seedStepExecutions, updateRunStatus } from "../state/index.js";
import { runStepDir } from "../workspace/paths.js";
import type { SandboxStepInput, SandboxStepResult } from "./sandbox-step.js";

export const ADHOC_AGENT_ID = "adhoc-executor";
export const ADHOC_STEP_ID = "adhoc";
export const DEFAULT_ADHOC_RESOURCES: ResourceSpec = { cpu: 4, memoryGb: 8 };

export interface RunAdhocInput {
    readonly runSession: RunSession;
    readonly prompt: string;
    readonly ownsMandate?: boolean;
}

export interface RunAdhocResult {
    readonly runId: string;
    readonly status: "completed" | "failed";
}

export interface RunAdhocDeps {
    readonly pool: Pool;
    readonly sandboxStepCallable: (input: SandboxStepInput) => Promise<SandboxStepResult>;
    readonly runAuthorizer: RunAuthorizer;
    readonly resourcePolicy?: ResourcePolicy;
}

export function registerRunAdhoc(deps: RunAdhocDeps): (input: RunAdhocInput) => Promise<RunAdhocResult> {
    return DBOS.registerWorkflow((input: RunAdhocInput) => runAdhocBody(input, deps), { name: "runAdhoc" });
}

export async function composeAdhocSeed(pool: Pool, analysisId: string, runId: string, prompt: string): Promise<string> {
    const profile = unwrapOrThrow(await loadDataProfileStatus(pool, analysisId));
    return composeAdhocBriefing({
        prompt,
        workspace: {
            analysisRoot: `/${analysisId}`,
            workingDir: `/${analysisId}/${runStepDir(runId, ADHOC_STEP_ID)}`,
        },
        profile: profile?.result ?? null,
    });
}

export function buildAdhocStepInput(args: {
    readonly runSession: RunSession;
    readonly prompt: string;
    readonly resourcePolicy?: ResourcePolicy;
}): SandboxStepInput {
    if (args.runSession.scope.kind !== "analysis") {
        throw new Error(`buildAdhocStepInput requires an analysis-scoped session — got ${args.runSession.scope.kind}`);
    }
    const analysisId = args.runSession.scope.analysisId;
    const runId = args.runSession.runFrame.runId;
    return {
        analysisId,
        runId,
        stepId: ADHOC_STEP_ID,
        agentId: ADHOC_AGENT_ID,
        dependsOn: [],
        level: 0,
        prompt: args.prompt,
        parentWorkflowId: runId,
        resources: args.resourcePolicy?.adhoc ?? DEFAULT_ADHOC_RESOURCES,
        runSession: forStep(args.runSession, ADHOC_STEP_ID),
    };
}

export async function runAdhocBody(input: RunAdhocInput, deps: RunAdhocDeps): Promise<RunAdhocResult> {
    if (input.runSession.scope.kind !== "analysis") {
        throw new Error(`runAdhoc requires an analysis-scoped session — got ${input.runSession.scope.kind}`);
    }

    const scope = input.runSession.scope;
    const analysisId = scope.analysisId;
    const runId = input.runSession.runFrame.runId;

    await DBOS.runStep(
        async () => {
            unwrapOrThrow(
                await insertRun(deps.pool, {
                    runId,
                    analysisId,
                    threadId: scope.threadId ?? null,
                    workflowName: "runAdhoc",
                }),
            );
        },
        { name: "insert-run" },
    );

    await DBOS.runStep(
        async () => {
            unwrapOrThrow(
                await seedStepExecutions(deps.pool, [
                    {
                        runId,
                        stepId: ADHOC_STEP_ID,
                        analysisId,
                        wave: 0,
                        agentId: ADHOC_AGENT_ID,
                    },
                ]),
            );
        },
        { name: "seed-step-executions" },
    );

    const prompt = await DBOS.runStep(() => composeAdhocSeed(deps.pool, analysisId, runId, input.prompt), { name: "compose-adhoc-briefing" });
    const childInput = buildAdhocStepInput({
        runSession: input.runSession,
        prompt,
        resourcePolicy: deps.resourcePolicy,
    });

    let result: SandboxStepResult;
    try {
        const handle = await DBOS.startWorkflow(deps.sandboxStepCallable, { workflowID: `${runId}-${ADHOC_STEP_ID}` })(childInput);
        result = await handle.getResult();
    } catch (err) {
        await DBOS.runStep(
            async () => {
                unwrapOrThrow(await updateRunStatus(deps.pool, runId, "failed", "adhoc step failed"));
            },
            { name: "persist-final-status" },
        );
        await revokeRunAuthorization(deps, input, "workflow-failed");
        throw err;
    }

    const status = result.status === "complete" ? "completed" : "failed";
    await DBOS.runStep(
        async () => {
            unwrapOrThrow(await updateRunStatus(deps.pool, runId, status, result.error));
        },
        { name: "persist-final-status" },
    );
    await revokeRunAuthorization(deps, input, status === "completed" ? "workflow-completed" : "workflow-failed");
    return { runId, status };
}

function revokeRunAuthorization(deps: RunAdhocDeps, input: RunAdhocInput, reason: string): Promise<void> {
    return DBOS.runStep(
        () =>
            deps.runAuthorizer.revoke(
                {
                    runSession: input.runSession,
                    ownsMandate: input.ownsMandate ?? true,
                },
                reason,
            ),
        { name: "revoke-run-auth" },
    );
}
