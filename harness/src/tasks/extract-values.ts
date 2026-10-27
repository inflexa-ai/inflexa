/**
 * The extraction pass on the profile rails, and the `ExtractionArm` realization over it.
 *
 * The report resolver falls through to this arm for an over-cap file or a host parse fault. The arm runs one
 * fixed extraction script in an ephemeral sandbox, and it gives back the rows that the script read. No agent
 * loop runs anywhere in this path. A file whose extension names no tabular format never arrives here,
 * because the host decides the format and it refuses the file before the fall-through.
 *
 * The pass runs inside the step of the tool call that resolves the report (`sandbox/step-sandbox.ts`), under
 * the auth of that call, and it mints no mandate. One call can run more than one pass, thus the exec of each
 * pass takes the key of the step and a hash of its requests. The container is ephemeral, and it goes away
 * with the work, thus no standing machine exists.
 */

import { createHash } from "node:crypto";
import type { Result } from "neverthrow";

import type { AuthContext, Identity } from "../auth/types.js";
import type { ResourceSpec } from "../config/resource-limits.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { safeParseJsonAs } from "../lib/parse-json.js";
import type { ExtractionArm, ExtractionArtifact, ExtractionRequest } from "../report-model/production-resolver.js";
import type { SandboxClient } from "../sandbox/client.js";
import { passSpawnSession, withStepSandbox } from "../sandbox/step-sandbox.js";
import type { Suspension } from "../workflows/suspension.js";
import type { ExecRequest, ExecResult } from "../sandbox/types.js";
import { EXTRACTION_INPUT_ENV, EXTRACTION_SCRIPT, ExtractValuesResultSchema, type ExtractValuesResult } from "./extract-values-script.js";

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

/** The construction deps of the pass. It shares the sandbox rail of the profile. */
export type ExtractionDeps = {
    readonly sandboxClient: SandboxClient;
    /** Operational logging seam. An absent logger falls back to a no-op. */
    readonly logger?: Logger;
};

/** The caller of one pass: the analysis that it reads, and the identity and the auth of the tool call. */
export type ExtractionCaller = {
    readonly analysisId: string;
    readonly identity: Identity;
    readonly auth: AuthContext;
};

/**
 * Build the sandbox exec for one extraction pass. The command runs the fixed script through `python3 -c`.
 * The working directory is the analysis mount, thus a relative request path reads the correct file. The
 * request list rides in one environment variable.
 *
 * Each request carries its pinned hash. Thus the script can hash the file first and refuse a file that
 * drifted from the pin, before the read gives back drifted bytes.
 *
 * Each request also carries the format that the host decided. The script obeys that format, thus this arm
 * derives no reader from an extension and the two arms can never read one file two ways.
 *
 * The function is pure, thus a test asserts the command shape without a sandbox.
 */
export function buildExtractionExec(analysisId: string, requests: readonly ExtractionRequest[]): ExecRequest {
    return {
        command: ["python3", "-c", EXTRACTION_SCRIPT],
        cwd: `/${analysisId}`,
        env: { [EXTRACTION_INPUT_ENV]: JSON.stringify(scriptRequests(requests)) },
        timeoutSeconds: Math.floor(EXTRACTION_DEADLINE_MS / 1000),
    };
}

function scriptRequests(requests: readonly ExtractionRequest[]): Array<{ path: string; format: string; hash: string }> {
    return requests.map((request) => ({ path: request.path, format: request.format, hash: request.hash }));
}

/** The key of one pass inside its step: the same requests give the same exec, and other requests a new one. */
function requestKey(requests: readonly ExtractionRequest[]): string {
    return createHash("sha256")
        .update(JSON.stringify(scriptRequests(requests)), "utf8")
        .digest("hex")
        .slice(0, 16);
}

/**
 * Parse the script output from the exec result. A synthetic failure, a timeout, and a non-zero exit each
 * throw, because each means the script did not emit its map. A stdout that is not the map shape throws too.
 *
 * The function is pure, thus a test asserts the parse without a sandbox. The arm turns the throw into a
 * rejected promise.
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
    let parsed;
    try {
        parsed = safeParseJsonAs(result.stdout, ExtractValuesResultSchema);
    } catch {
        throw new Error("the extraction script did not emit valid JSON");
    }
    if (!parsed.success) throw parsed.error;
    return parsed.data;
}

/**
 * Run one extraction pass: make the container, run the script on every request, and remove the container.
 *
 * A suspending refusal of the spawn is the `err`, and the caller reports it. Each other fault throws.
 */
export async function runExtraction(
    deps: ExtractionDeps,
    caller: ExtractionCaller,
    requests: readonly ExtractionRequest[],
): Promise<Result<ExtractValuesResult, Suspension>> {
    const logger = (deps.logger ?? createNoopLogger()).named("extract-values").with({ analysisId: caller.analysisId });
    try {
        const ran = await withStepSandbox(
            deps.sandboxClient,
            {
                session: passSpawnSession(caller, {
                    analysisId: caller.analysisId,
                    runId: EXTRACT_VALUES_RUN_LITERAL,
                    stepId: EXTRACT_VALUES_STEP_LITERAL,
                    agentId: EXTRACT_VALUES_AGENT_ID,
                }),
                // The pass only reads, thus the container mounts the analysis tree read-only.
                spec: { resources: EXTRACTION_RESOURCES, readOnly: true },
                execKey: requestKey(requests),
            },
            logger,
            async (exec) => parseExtractionOutput(await exec(buildExtractionExec(caller.analysisId, requests), EXTRACTION_DEADLINE_MS)),
        );
        if (ran.isErr()) logger.warn("extraction suspended", { reason: ran.error.reason });
        return ran;
    } catch (cause) {
        logger.error("extraction failed", logger.errorFields(cause));
        throw cause;
    }
}

/** Runs one extraction pass for the bound analysis, and gives the raw value map back, or the suspension. */
export type ExtractionRunner = (requests: readonly ExtractionRequest[]) => Promise<Result<ExtractValuesResult, Suspension>>;

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
 * reference. A suspension is the `err`, and the resolver reports its reason on each reference.
 */
export function createExtractionArm(run: ExtractionRunner): ExtractionArm {
    return {
        async extract(requests) {
            return (await run(requests)).map(extractionArtifactsFromResult);
        },
    };
}
