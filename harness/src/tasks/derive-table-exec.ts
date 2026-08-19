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
 */

import { DBOS, type WorkflowHandle } from "@dbos-inc/dbos-sdk";
import { randomUUID } from "node:crypto";

import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import type { SandboxClient } from "../sandbox/client.js";
import { mintSandboxIdentity } from "../sandbox/identity.js";
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
 * A fault of any seam call throws. The tool reads a rejection as one short detail, thus the caller needs no
 * result type here.
 */
export async function runDeriveTableExecBody(input: DeriveTableExecInput, deps: DeriveTableExecDeps): Promise<ExecResult> {
    const logger = (deps.logger ?? createNoopLogger()).named("derive-table-exec").with({ analysisId: input.analysisId });
    const workflowId = DBOS.workflowID ?? `${DERIVE_RUN_LITERAL}:${input.executionId}`;

    const sandbox = await deps.sandboxClient.createSandbox(
        {
            runId: DERIVE_RUN_LITERAL,
            stepId: DERIVE_STEP_LITERAL,
            analysisId: input.analysisId,
            childWorkflowId: workflowId,
            resources: DERIVATION_RESOURCES,
            writableTail: input.writableTail,
        },
        mintSandboxIdentity(DERIVE_RUN_LITERAL),
    );

    try {
        // A checkpointed clock, not `Date.now()`: the await gates on this absolute deadline, and a
        // wall-clock deadline that grew on replay would shift which loop iteration crosses it.
        const deadline = (await (deps.now ?? (() => DBOS.now()))()) + DERIVATION_DEADLINE_MS;
        await deps.sandboxClient.submitExec(
            sandbox,
            buildDerivationExec({
                script: input.script,
                execId: input.executionId,
                workingDir: input.workingDir,
                inputs: input.inputs,
                output: input.output,
            }),
        );
        return await deps.sandboxClient.awaitExec(sandbox, input.executionId, noopEmit, deadline);
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
export function registerDeriveTableExecWorkflow(deps: DeriveTableExecDeps): (input: DeriveTableExecInput) => Promise<ExecResult> {
    return DBOS.registerWorkflow((input: DeriveTableExecInput) => runDeriveTableExecBody(input, deps), { name: "derive-table-exec" });
}

/** The per-attempt workflow id. The execution id is unique already, and the nonce keeps a retry distinct. */
export function deriveTableExecWorkflowId(executionId: string, nonce: string): string {
    return `${DERIVE_RUN_LITERAL}:${executionId}:${nonce}`;
}

/**
 * The async edge. It starts the registered workflow and it awaits the terminal result.
 *
 * The tool authorizes the derivation before this call and it revokes after, thus this edge holds no
 * lifecycle of its own. A workflow fault rejects the returned promise.
 */
export async function triggerDeriveTableExec(workflow: (input: DeriveTableExecInput) => Promise<ExecResult>, input: DeriveTableExecInput): Promise<ExecResult> {
    const handle = (await DBOS.startWorkflow(workflow, {
        workflowID: deriveTableExecWorkflowId(input.executionId, randomUUID()),
    })(input)) as WorkflowHandle<ExecResult>;
    return handle.getResult();
}
