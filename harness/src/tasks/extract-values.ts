/**
 * The extraction workflow on the profile rails, and the `ExtractionArm` realization over it.
 *
 * The report resolver falls through to this arm for an over-cap file, an unknown format, or a host parse
 * fault. The arm runs one fixed extraction script in an ephemeral sandbox, and it gives back the rows that
 * the script read. No agent loop runs anywhere in this path.
 *
 * The shape matches the data profile (`src/tasks/data-profile.ts`). The authorization mints at the async
 * edge (`triggerExtractValues`) and rides in the workflow input. The body never mints, and it revokes the
 * authorization on every terminal path. The container is ephemeral, and it goes away with the work, thus no
 * standing machine exists.
 */

import { DBOS, type WorkflowHandle } from "@dbos-inc/dbos-sdk";
import { randomUUID } from "node:crypto";

import type { AuthContext, RunSession } from "../auth/types.js";
import type { ResourceSpec } from "../config/resource-limits.js";
import type { RunAuthorization, RunAuthorizer } from "../execution/run-authorizer.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import type { ExtractionArm, ExtractionArtifact, ExtractionRequest } from "../report-model/production-resolver.js";
import type { SandboxClient } from "../sandbox/client.js";
import { generateExecutionId } from "../sandbox/execution-id.js";
import { mintSandboxIdentity } from "../sandbox/identity.js";
import type { ExecEmit, ExecResult, SubmitExecBody } from "../sandbox/types.js";
import {
    detectExtractionFormat,
    EXTRACTION_INPUT_ENV,
    EXTRACTION_SCRIPT,
    ExtractValuesResultSchema,
    type ExtractValuesResult,
} from "./extract-values-script.js";

// The registration in the runtime assembly needs the result type, thus this module re-exports it.
export type { ExtractValuesResult } from "./extract-values-script.js";

/** The synthetic run id and step id of the extraction pass. Both are constants shared by every analysis. */
const EXTRACT_VALUES_RUN_LITERAL = "extract-values" as const;
const EXTRACT_VALUES_STEP_LITERAL = "extract" as const;

/** The provenance agent id. No agent loop runs, thus this names the extraction pass, not a model agent. */
const EXTRACT_VALUES_AGENT_ID = "value-extractor" as const;

/** The exec budget for one extraction pass. It matches the profile budget. */
const EXTRACTION_DEADLINE_MS = 300_000;

/**
 * The container size for one extraction pass. The fall-through reads a file that is over the host cap, thus
 * the container needs headroom to load the file into pandas. The size is fixed, because the seam request
 * carries no file size. A later change can size it from the batch.
 */
const EXTRACTION_RESOURCES: ResourceSpec = { cpu: 2, memoryGb: 8 };

/** The awaitExec callback. The extraction pass reports no live activity, thus the callback drops each event. */
const noopEmit: ExecEmit = () => {};

/**
 * The body's construction-time deps, closed over at registration. The extraction pass shares the profile's
 * sandbox and authorization rails, thus it draws the same three seams and nothing else.
 */
export interface ExtractValuesDeps {
    /** Operational logging seam. An absent logger falls back to a no-op. */
    readonly logger?: Logger;
    readonly sandboxClient: SandboxClient;
    readonly runAuthorizer: RunAuthorizer;
}

/**
 * The workflow input. It is JSON-serializable, thus DBOS persists it as the workflow's input row. The
 * `RunSession` carries the run authorization. The body reads it and never mints.
 */
export interface ExtractValuesWorkflowInput {
    readonly analysisId: string;
    readonly runSession: RunSession;
    /** The fall-through artifacts of one document pass. One submission covers every request. */
    readonly requests: readonly ExtractionRequest[];
    /**
     * True when this workflow owns the run-authorization lifecycle, thus the body revokes on every terminal
     * path. An input persisted before this field existed reads as absent, and the body defaults it to true,
     * which matches the prior owned behavior.
     */
    readonly ownsMandate?: boolean; // oss-core-managed-ok
}

/**
 * Build the sandbox exec for one extraction pass. The command runs the fixed script through `python3 -c`.
 * The working directory is the analysis mount, thus a relative request path reads the correct file. The
 * request list rides in one environment variable.
 *
 * The function is pure, thus a test asserts the command shape without a sandbox.
 */
export function buildExtractionExec(analysisId: string, requests: readonly ExtractionRequest[], execId: string): SubmitExecBody {
    const scriptRequests = requests.map((request) => ({ path: request.path, format: detectExtractionFormat(request.path) }));
    return {
        command: ["python3", "-c", EXTRACTION_SCRIPT],
        execId,
        cwd: `/${analysisId}`,
        env: { [EXTRACTION_INPUT_ENV]: JSON.stringify(scriptRequests) },
        timeoutSeconds: Math.floor(EXTRACTION_DEADLINE_MS / 1000),
    };
}

/**
 * Parse the script output from the exec result. A synthetic failure, a timeout, and a non-zero exit each
 * throw, because each means the script did not emit its map. A stdout that is not the map shape throws too.
 *
 * The function is pure, thus a test asserts the parse without a sandbox. The throw crosses the workflow
 * boundary, and the arm turns it into a rejected promise.
 */
export function parseExtractionOutput(result: ExecResult): ExtractValuesResult {
    if (result.syntheticFailure !== undefined) {
        throw new Error(`the extraction sandbox failed: ${result.syntheticFailure.reason}`);
    }
    if (result.timedOut) {
        throw new Error("the extraction sandbox reached the deadline");
    }
    if (result.exitCode !== 0) {
        throw new Error(`the extraction script exited with code ${String(result.exitCode)}`);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(result.stdout);
    } catch {
        throw new Error("the extraction script did not emit valid JSON");
    }
    return ExtractValuesResultSchema.parse(parsed);
}

/**
 * The body, extracted so a test drives it without a registered workflow. It creates the ephemeral
 * container, submits one exec, awaits the result durably, and gives the value map back. It revokes the run
 * authorization on every terminal path, and it tears the container down on both paths.
 */
export async function runExtractValuesBody(input: ExtractValuesWorkflowInput, deps: ExtractValuesDeps): Promise<ExtractValuesResult> {
    const logger = (deps.logger ?? createNoopLogger()).named("extract-values").with({ analysisId: input.analysisId });
    const { analysisId, runSession, requests, ownsMandate = true } = input; // oss-core-managed-ok
    const authorization: RunAuthorization = { runSession, ownsMandate }; // oss-core-managed-ok

    try {
        const executionId = generateExecutionId(EXTRACT_VALUES_AGENT_ID);
        const workflowId = DBOS.workflowID ?? `${EXTRACT_VALUES_RUN_LITERAL}:${executionId}`;

        // The container mounts the analysis tree read-only. The extraction pass only reads, thus it needs
        // no writable step mount.
        const sandbox = await deps.sandboxClient.createSandbox(
            {
                runId: EXTRACT_VALUES_RUN_LITERAL,
                stepId: EXTRACT_VALUES_STEP_LITERAL,
                analysisId,
                childWorkflowId: workflowId,
                resources: EXTRACTION_RESOURCES,
                readOnly: true,
            },
            mintSandboxIdentity(EXTRACT_VALUES_RUN_LITERAL),
        );

        try {
            // A checkpointed clock, not `Date.now()`: the await gates on this absolute deadline, and a
            // wall-clock deadline that grew on replay would shift which loop iteration crosses it.
            const deadlineAbs = (await DBOS.now()) + EXTRACTION_DEADLINE_MS;
            await deps.sandboxClient.submitExec(sandbox, buildExtractionExec(analysisId, requests, executionId));
            const result = await deps.sandboxClient.awaitExec(sandbox, executionId, noopEmit, deadlineAbs);
            const map = parseExtractionOutput(result);
            await deps.runAuthorizer.revoke(authorization, "extract-values-completed");
            return map;
        } finally {
            try {
                await deps.sandboxClient.teardown(sandbox);
            } catch (teardownErr) {
                logger.warn("teardown failed (non-fatal)", { executionId, ...logger.errorFields(teardownErr) });
            }
        }
    } catch (err) {
        logger.error("extraction failed", logger.errorFields(err));
        await deps.runAuthorizer.revoke(authorization, "extract-values-failed");
        throw err;
    }
}

/**
 * Register the extraction workflow with DBOS. It gives back the registered callable, thus a trigger
 * dispatches with `DBOS.startWorkflow`.
 */
export function registerExtractValuesWorkflow(deps: ExtractValuesDeps): (input: ExtractValuesWorkflowInput) => Promise<ExtractValuesResult> {
    return DBOS.registerWorkflow((input: ExtractValuesWorkflowInput) => runExtractValuesBody(input, deps), { name: "extract-values" });
}

/** The per-attempt workflow id. A fresh nonce keeps each pass under a distinct id. */
export function extractValuesWorkflowId(analysisId: string, nonce: string): string {
    return `extract-values:${analysisId}:${nonce}`;
}

/**
 * The route-side deps for the trigger: the run authorizer, and the registered workflow callable. The body's
 * construction-time deps are closed over at registration, thus the trigger never holds them.
 */
export interface ExtractValuesTriggerDeps {
    readonly runAuthorizer: RunAuthorizer;
    readonly workflow: (input: ExtractValuesWorkflowInput) => Promise<ExtractValuesResult>;
}

/** The identity and the requests for one extraction pass. */
export interface ExtractValuesTriggerParams {
    readonly auth: AuthContext;
    readonly analysisId: string;
    readonly requests: readonly ExtractionRequest[];
}

/**
 * The async edge. It authorizes through the `RunAuthorizer`, starts the workflow, and awaits the outcome.
 * The body owns the revoke, thus the trigger holds no lifecycle. A workflow fault rejects the returned
 * promise.
 */
export async function triggerExtractValues(deps: ExtractValuesTriggerDeps, params: ExtractValuesTriggerParams): Promise<ExtractValuesResult> {
    const { auth, analysisId, requests } = params;
    const { runSession, ownsMandate } = await deps.runAuthorizer.authorize({
        // oss-core-managed-ok
        auth,
        scope: { kind: "analysis", analysisId },
        provenance: { agentId: EXTRACT_VALUES_AGENT_ID, callPath: [EXTRACT_VALUES_AGENT_ID] },
        frame: { runId: EXTRACT_VALUES_RUN_LITERAL, stepId: EXTRACT_VALUES_STEP_LITERAL },
    });
    const handle = (await DBOS.startWorkflow(deps.workflow, {
        workflowID: extractValuesWorkflowId(analysisId, randomUUID()),
    })({ analysisId, runSession, requests: [...requests], ownsMandate })) as WorkflowHandle<ExtractValuesResult>; // oss-core-managed-ok
    return handle.getResult();
}

/** Runs one extraction pass for the bound analysis, and gives the raw value map back. */
export type ExtractionRunner = (requests: readonly ExtractionRequest[]) => Promise<ExtractValuesResult>;

/**
 * Bind the trigger to one analysis and one auth context. The result runs one pass with every request in it.
 */
export function bindExtractionTrigger(deps: ExtractValuesTriggerDeps, binding: { readonly auth: AuthContext; readonly analysisId: string }): ExtractionRunner {
    return (requests) => triggerExtractValues(deps, { auth: binding.auth, analysisId: binding.analysisId, requests });
}

/**
 * Turn the raw script output into the arm result. A path with rows enters the map. A path with an error
 * drops out, thus the reference at that path reads as an unread artifact, which the seam contract expects.
 *
 * The function is pure, thus a test asserts the mapping without a sandbox.
 */
export function extractionArtifactsFromResult(result: ExtractValuesResult): Map<string, ExtractionArtifact> {
    const out = new Map<string, ExtractionArtifact>();
    for (const [path, outcome] of Object.entries(result)) {
        if ("rows" in outcome) {
            out.set(path, { rows: outcome.rows });
        }
    }
    return out;
}

/**
 * Make the extraction arm over a runner. One `extract` call makes one run with every request in it, and it
 * gives the value map. A run fault rejects the promise, and the resolver turns the rejection into a failed
 * reference.
 */
export function createExtractionArm(run: ExtractionRunner): ExtractionArm {
    return {
        async extract(requests) {
            return extractionArtifactsFromResult(await run(requests));
        },
    };
}
