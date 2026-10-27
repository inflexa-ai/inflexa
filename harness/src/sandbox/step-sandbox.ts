/**
 * One ephemeral sandbox for one exec, inside the durable step of a tool call.
 *
 * The identity comes from the step: the exec id is the key of the step, plus a discriminator when one step
 * runs more than one exec, and the sandbox name comes from the exec id. Thus a rerun of the step adopts the
 * container of the earlier attempt (`createOrAdopt`), and sandbox-server gives the record of the same exec.
 * The container goes away when the work ends. Outside a workflow nothing reruns, thus the ids are random.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import { err, ok, type Result } from "neverthrow";
import { randomUUID } from "node:crypto";

import type { AuthContext, Identity, SpawnSession } from "../auth/types.js";
import type { Logger } from "../lib/logger.js";
import { durableStepKey } from "../tools/workspace/edit-file.js";
import { suspensionOfSpawnRefusal, type Suspension } from "../workflows/suspension.js";
import type { SandboxClient } from "./client.js";
import { keyedSandboxIdentity } from "./identity.js";
import { keepSuspendingRefusal } from "./sandbox-error.js";
import type { ExecEmit, ExecRequest, ExecResult, SandboxSpec } from "./types.js";

/** The pass of the harness that a sandbox serves. Its run id and its step id name no run of the analysis. */
export type SandboxPass = {
    readonly analysisId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly agentId: string;
};

/**
 * The spawn session of a pass that runs under the auth of a tool call.
 *
 * The pass mints no mandate. The session never enters durable state: the sandbox client reads its scope and
 * its frame for the mounts and the labels, and the label hook of the host reads it in process.
 */
export function passSpawnSession(caller: { readonly identity: Identity; readonly auth: AuthContext }, pass: SandboxPass): SpawnSession {
    return {
        identity: caller.identity,
        scope: { kind: "analysis", analysisId: pass.analysisId },
        provenance: { agentId: pass.agentId, callPath: [pass.agentId] },
        runFrame: { runId: pass.runId, stepId: pass.stepId },
        auth: caller.auth,
    };
}

export type StepSandboxRequest = {
    readonly session: SpawnSession;
    readonly spec: Omit<SandboxSpec, "childWorkflowId">;
    /** Tells two execs of one step apart. A step that runs one exec gives none. */
    readonly execKey?: string;
};

/**
 * The one exec of a step sandbox, with its budget in milliseconds. A pass reports no live activity, thus the
 * events go nowhere.
 */
export type StepSandboxExec = (request: ExecRequest, budgetMs: number) => Promise<ExecResult>;

const noopEmit: ExecEmit = () => {};

/**
 * Make the sandbox, give `work` its exec, and remove the sandbox when `work` ends. A suspending refusal of
 * the spawn is the `err`, and each other fault throws.
 */
export async function withStepSandbox<T>(
    client: SandboxClient,
    request: StepSandboxRequest,
    logger: Logger,
    work: (exec: StepSandboxExec) => Promise<T>,
): Promise<Result<T, Suspension>> {
    const stepKey = durableStepKey();
    const execId =
        stepKey === undefined ? `${request.session.runFrame.runId}:${randomUUID()}` : request.execKey === undefined ? stepKey : `${stepKey}:${request.execKey}`;
    const spawned = keepSuspendingRefusal(
        await client.createSandbox(
            request.session,
            { ...request.spec, childWorkflowId: DBOS.workflowID ?? execId },
            keyedSandboxIdentity(request.session.runFrame.runId, execId),
        ),
    );
    if (spawned.isErr()) return err(suspensionOfSpawnRefusal(spawned.error));
    const sandbox = spawned.value;
    try {
        return ok(await work(async (execRequest, budgetMs) => client.exec(sandbox, execRequest, noopEmit, (await DBOS.now()) + budgetMs, execId)));
    } finally {
        try {
            await client.teardown(sandbox);
        } catch (cause) {
            logger.warn("the sandbox of the pass did not tear down", { sandboxId: sandbox.sandboxId, ...logger.errorFields(cause) });
        }
    }
}
