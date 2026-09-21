/**
 * The container of one report-session derivation, as a registered DBOS workflow.
 *
 * The `derive_table` tool runs inside one live chat turn, and a chat turn is not a workflow body. An await
 * of an exec under the callback transport calls `DBOS.recv`, which a workflow body alone can call. Thus the
 * container lives here, behind a registered workflow, and the tool starts it and awaits the handle.
 *
 * The shape is the shape of `tasks/extract-values.ts`: a body that a test drives directly, a registration
 * that closes over the construction-time deps, and a trigger that starts the workflow and gives the result
 * back. The tool holds the trigger as a plain function, thus no module under `tools/` imports DBOS.
 *
 * The body owns the whole machine lifetime. It creates the container, submits one exec, awaits the terminal
 * result, and tears the container down on both paths. A teardown fault reaches the log alone, because the
 * work is done by then.
 *
 * The exec id is `${workflowId}:${stepId}:${fnId}`, the one shape that `workflowIdFromExec` parses. A
 * callback host reads the owner workflow out of the exec id alone, thus a flat id makes the completion
 * callback unroutable and it lands as a `400`. The pull backstop still settles such an exec, but it pays
 * the quiet interval first.
 */

import { DBOS, type WorkflowHandle } from "@dbos-inc/dbos-sdk";
import { err, ok, type Result } from "neverthrow";

import { forStep } from "../auth/types.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { unwrapOrThrow } from "../lib/result.js";
import type { SandboxClient } from "../sandbox/client.js";
import { mintSandboxIdentity } from "../sandbox/identity.js";
import { keepSuspendingRefusal } from "../sandbox/sandbox-error.js";
import { suspendAnalysis } from "../state/analyses.js";
import type { Querier } from "../state/db.js";
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

/** The awaitExec callback. A derivation reports no live activity, thus the callback drops each event. */
const noopEmit: ExecEmit = () => {};

/** The construction-time deps of the body. The registration closes over them, thus the trigger holds none. */
export interface DeriveTableExecDeps {
    readonly sandboxClient: SandboxClient;
    /** The app pool, for the mark of the analysis when the derivation suspends. */
    readonly pool: Querier;
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
 * (workflow-suspension spec). The body marks the analysis as suspended before it returns the `err`.
 */
export async function runDeriveTableExecBody(input: DeriveTableExecInput, deps: DeriveTableExecDeps): Promise<Result<ExecResult, Suspension>> {
    const logger = (deps.logger ?? createNoopLogger()).named("derive-table-exec").with({ analysisId: input.analysisId });
    const workflowId = DBOS.workflowID ?? deriveTableExecWorkflowId(input.executionId);
    // One workflow submits one exec, thus the function id is a constant. The three segments are what a
    // callback host parses to find the workflow that awaits this exec.
    const execId = `${workflowId}:${DERIVE_STEP_LITERAL}:fn-0`;

    // The sandbox takes its ids from the session that the tool authorized, and the client calls the label
    // hook of the host with it. A refusal of that hook with the suspend flag is a value; each other spawn failure throws.
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
        unwrapOrThrow(await suspendAnalysis(deps.pool, input.analysisId));
        return err(suspension);
    }
    const sandbox = spawned.value;

    try {
        // A checkpointed clock, not `Date.now()`: the await gates on this absolute deadline, and a
        // wall-clock deadline that grew on replay would shift which loop iteration crosses it.
        const deadline = (await (deps.now ?? (() => DBOS.now()))()) + DERIVATION_DEADLINE_MS;
        await deps.sandboxClient.submitExec(
            sandbox,
            buildDerivationExec({
                script: input.script,
                execId,
                workingDir: input.workingDir,
                inputs: input.inputs,
                output: input.output,
            }),
        );
        return ok(await deps.sandboxClient.awaitExec(sandbox, execId, noopEmit, deadline));
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

/**
 * The workflow id of one derivation.
 *
 * It carries exactly one colon, because `workflowIdFromExec` recovers the id by a strip of the last two
 * colon-delimited segments of the exec id. The execution id is unique already, thus no nonce joins it.
 */
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
