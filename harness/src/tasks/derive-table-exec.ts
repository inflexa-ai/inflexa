/**
 * The container of one report-session derivation, as a registered DBOS workflow.
 *
 * The `derive_table` tool runs inside one live chat turn, and a chat turn is not a workflow. An exec runs as
 * a durable step of a workflow, and the reaper maps each container to the workflow that owns it. Thus the
 * container lives here, behind a registered workflow, and the tool starts it and awaits the handle.
 *
 * The shape is the shape of `tasks/extract-values.ts`: a body that a test drives directly, a registration
 * that closes over the construction-time deps, and a trigger that starts the workflow and gives the result
 * back. The tool holds the trigger as a plain function, thus no module under `tools/` imports DBOS.
 *
 * The body owns the whole machine lifetime. It creates the container, runs one exec to its terminal
 * result, and tears the container down on both paths. A teardown fault reaches the log alone, because the
 * work is done by then.
 */

import { DBOS, type WorkflowHandle } from "@dbos-inc/dbos-sdk";
import { err, ok, type Result } from "neverthrow";

import { forStep } from "../auth/types.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import type { SandboxClient } from "../sandbox/client.js";
import { mintSandboxIdentity } from "../sandbox/identity.js";
import { keepSuspendingRefusal } from "../sandbox/sandbox-error.js";
import { suspensionOfSpawnRefusal, type Suspension } from "../workflows/suspension.js";
import type { ExecEmit, ExecResult } from "../sandbox/types.js";
import {
    buildDerivationExec,
    DERIVATION_DEADLINE_MS,
    DERIVATION_RESOURCES,
    DERIVE_RUN_LITERAL,
    DERIVE_STEP_LITERAL,
    type DeriveTableExecInput,
} from "../tools/report-session/derive-table.js";

/** The exec progress callback. A derivation reports no live activity, thus the callback drops each event. */
const noopEmit: ExecEmit = () => {};

/** The construction-time deps of the body. The registration closes over them, thus the trigger holds none. */
export interface DeriveTableExecDeps {
    readonly sandboxClient: SandboxClient;
    /**
     * The checkpointed clock of the deadline. It defaults to `DBOS.now()`, which a replay reads again from
     * the checkpoint. A test injects a fixed clock, thus it drives this body with no launched runtime.
     */
    readonly now?: () => Promise<number>;
    readonly logger?: Logger;
}

/**
 * The body, exported so a test drives it without a registered workflow.
 *
 * A fault of any seam call throws. The tool reads a rejection as one short detail. A chat turn awaits this
 * workflow, thus a suspension is the `err` of the result, and the workflow does not cancel
 * (workflow-suspension spec). The body does not mark the analysis: the tool reports the suspension to the
 * conversation agent.
 */
export async function runDeriveTableExecBody(input: DeriveTableExecInput, deps: DeriveTableExecDeps): Promise<Result<ExecResult, Suspension>> {
    const logger = (deps.logger ?? createNoopLogger()).named("derive-table-exec").with({ analysisId: input.analysisId });
    const workflowId = DBOS.workflowID ?? deriveTableExecWorkflowId(input.executionId);

    const spawned = keepSuspendingRefusal(
        await deps.sandboxClient.createSandbox(
            forStep(input.runSession, DERIVE_STEP_LITERAL),
            { childWorkflowId: workflowId, resources: DERIVATION_RESOURCES, writableTail: input.writableTail },
            mintSandboxIdentity(DERIVE_RUN_LITERAL),
        ),
    );
    if (spawned.isErr()) {
        const suspension = suspensionOfSpawnRefusal(spawned.error);
        logger.warn("derivation suspended", { reason: suspension.reason });
        return err(suspension);
    }
    const sandbox = spawned.value;

    try {
        // A checkpointed clock, not `Date.now()`: a wall-clock deadline would grow on each recovery.
        const deadline = (await (deps.now ?? (() => DBOS.now()))()) + DERIVATION_DEADLINE_MS;
        const request = buildDerivationExec({
            script: input.script,
            workingDir: input.workingDir,
            inputs: input.inputs,
            output: input.output,
        });
        return ok(await deps.sandboxClient.exec(sandbox, request, noopEmit, deadline));
    } finally {
        try {
            await deps.sandboxClient.teardown(sandbox);
        } catch (cause) {
            logger.warn("the derivation sandbox did not tear down", logger.errorFields(cause));
        }
    }
}

/**
 * Register the derivation workflow with DBOS. It gives back the registered callable, thus a trigger
 * dispatches with `DBOS.startWorkflow`.
 */
export function registerDeriveTableExecWorkflow(deps: DeriveTableExecDeps): (input: DeriveTableExecInput) => Promise<Result<ExecResult, Suspension>> {
    return DBOS.registerWorkflow((input: DeriveTableExecInput) => runDeriveTableExecBody(input, deps), { name: "derive-table-exec" });
}

/** The workflow id of one derivation. The execution id is unique already, thus no nonce joins it. */
export function deriveTableExecWorkflowId(executionId: string): string {
    return `${DERIVE_RUN_LITERAL}:${executionId}`;
}

/**
 * The async edge. It starts the registered workflow and it awaits the terminal result.
 *
 * The tool authorizes the derivation before this call and it revokes after, thus this edge holds no
 * lifecycle of its own. A workflow fault rejects the returned promise, and a suspension is the `err`.
 */
export async function triggerDeriveTableExec(
    workflow: (input: DeriveTableExecInput) => Promise<Result<ExecResult, Suspension>>,
    input: DeriveTableExecInput,
): Promise<Result<ExecResult, Suspension>> {
    const handle = (await DBOS.startWorkflow(workflow, {
        workflowID: deriveTableExecWorkflowId(input.executionId),
    })(input)) as WorkflowHandle<Result<ExecResult, Suspension>>;
    return handle.getResult();
}
