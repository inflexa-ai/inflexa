/**
 * Data-profile DBOS workflow — profiles the already-staged input files, runs
 * the data-profiler sandbox agent, writes per-file metadata to
 * cortex_artifacts, and indexes descriptions into the pgvector store. Inputs
 * are staged under `data/inputs/` by the embedder before the run (see the data-profile-init spec);
 * the body assumes a populated tree and never downloads.
 *
 * Recoverable: a crashed Cortex pod resumes the workflow from the DBOS step
 * cache. The run authorization is minted at the async edge (`triggerDataProfile`)
 * and rides in `input.runSession`; the body never mints. The body revokes the
 * authorization on every terminal path.
 *
 * The `cortex_analysis_state.data_profile_status` ledger (claimed via
 * `tryStartDataProfile` / `tryRerunDataProfile` / `tryRetryDataProfile`)
 * still drives the UI status and the trigger's return value. Concurrent
 * triggers dedup via the ledger CAS (only one `tryStart/tryRerun/tryRetry`
 * UPDATE wins); each winning attempt starts a workflow under a per-attempt id.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import { randomUUID } from "node:crypto";
import { ok } from "neverthrow";
import type { Pool } from "pg";

import { forSubAgent, type AuthContext, type RunSession } from "../auth/types.js";
import type { RunAuthorization, RunAuthorizer } from "../execution/run-authorizer.js";
import type { StagedInput } from "../execution/staged-input.js";
import { createDataProfilerAgent } from "../agents/sandbox/data-profiler.js";
import type { SandboxAgentDeps } from "../agents/sandbox/shared.js";
import type { BioToolKeys } from "../tools/bio/keys.js";
import { runToTerminal } from "../loop/run-to-terminal.js";
import { durableStep } from "../loop/run-step.js";
import { unwrapOrThrow } from "../lib/result.js";
import { defineTool } from "../tools/define-tool.js";
import type { ChatProvider, EmbeddingProvider } from "../providers/types.js";
import type { SandboxClient } from "../sandbox/client.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";

import { estimateDataProfileResources } from "../sandbox/estimate-data-profile-resources.js";
import { generateExecutionId } from "../sandbox/execution-id.js";
import { mintSandboxIdentity } from "../sandbox/identity.js";
import { createVectorStore } from "../state/vector-store.js";
import { ProfilerOutputSchema, type ProfilerOutput } from "../schemas/data-profile-schemas.js";
import { completeDataProfile, failDataProfile, loadDataProfileStatus, tryRerunDataProfile, tryStartDataProfile, upsertArtifacts } from "../state/index.js";
import { ensureSearchIndex, searchIndexName } from "../workspace/search-config.js";

/** Synthetic run/step literal for the data-profile workflow. */
const DATA_PROFILE_RUN_LITERAL = "data-profile" as const;
const DATA_PROFILE_STEP_LITERAL = "profile" as const;
const DATA_PROFILE_AGENT_ID = "data-profiler" as const;

/** Sandbox-server exec budget for the profile run. */
const DEFAULT_DEADLINE_MS = 300_000;

/** The body's construction-time deps — closed over at registration. */
export interface DataProfileDeps {
    readonly provider: ChatProvider;
    readonly pool: Pool;
    readonly sandboxClient: SandboxClient;
    readonly workspaceFs: WorkspaceFilesystem;
    readonly sessionsBasePath: string;
    /** Model id — provenance / metric label; the provider owns the wire model. */
    readonly model: string;
    readonly runAuthorizer: RunAuthorizer;
    /** API keys for the bio/chem tools the profiler sandbox agent may use. */
    readonly bioKeys: BioToolKeys;
    /**
     * Write-side embedder for the vector indexer. An instance, not endpoint
     * config: the host composes its own realization (cloud endpoint, local
     * in-process model, …) and the provider's `dimensions` sizes the
     * per-analysis index — matching every other write-side workflow dep.
     */
    readonly embedding: EmbeddingProvider;
    /** Absolute path to the skills tree (one subdirectory per skill). */
    readonly skillsDir: string;
}

/**
 * Workflow input. JSON-serialisable — DBOS persists it as the workflow's
 * input row. The `RunSession` carries the run authorization; the body reads it
 * and never mints.
 */
export interface DataProfileWorkflowInput {
    readonly analysisId: string;
    readonly runSession: RunSession;
    /**
     * Manifest of the input files staged under `data/inputs/` before the run
     * started (see the data-profile-init spec). The body assumes the tree is populated and profiles
     * exactly these files — it never downloads. JSON-serializable; rides in the
     * DBOS workflow input and survives recovery.
     */
    readonly stagedInputs: readonly StagedInput[];
    /**
     * True when Cortex owns the run-authorization lifecycle and therefore must
     * revoke it on every terminal path. False when the caller supplied its own
     * authorization: the caller owns the lifecycle, so the body must NOT revoke
     * it. The ownership decision is made by the `RunAuthorizer` seam — see
     * `authorizeDataProfile`.
     *
     * Optional because a workflow persisted before this field existed (recovered
     * across the deploy that added it) deserializes without it; the body defaults
     * absent → true, matching the prior Cortex-owned behavior.
     */
    readonly ownsMandate?: boolean; // oss-core-managed-ok
}

/** Build the canonical artifact path for a staged input file. */
function inputArtifactPath(f: StagedInput): string {
    return `data/${f.relativePath}`;
}

/** Lowercased extension of a path, or `"unknown"` when none. */
function fileExtension(p: string): string {
    const base = p.slice(p.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : "unknown";
}

/**
 * Register the data-profile workflow with DBOS. Returns the registered
 * callable so `triggerDataProfile` can dispatch via `DBOS.startWorkflow`.
 */
export function registerDataProfileWorkflow(deps: DataProfileDeps): (input: DataProfileWorkflowInput) => Promise<void> {
    return DBOS.registerWorkflow((input: DataProfileWorkflowInput) => runDataProfileBody(input, deps), { name: "data-profile" });
}

/**
 * Body extracted so tests can drive it without registering a workflow.
 * Updates `cortex_analysis_state` status to 'completed' on success or
 * 'failed' on error, and revokes the run authorization on every terminal path.
 */
export async function runDataProfileBody(input: DataProfileWorkflowInput, deps: DataProfileDeps): Promise<void> {
    // Ownership defaults to true for inputs persisted before the field existed
    // (a #247 workflow recovered across this deploy): those were always
    // Cortex-owned and must be revoked here.
    const { analysisId, runSession, ownsMandate = true, stagedInputs } = input; // oss-core-managed-ok
    const authorization: RunAuthorization = { runSession, ownsMandate }; // oss-core-managed-ok

    try {
        // 1. Input files are already staged under data/inputs/ (see the data-profile-init spec); the
        // embedder populated the tree and handed us this manifest in the workflow
        // input. The body never downloads.
        if (stagedInputs.length === 0) {
            console.warn(`[data-profile] No input files staged for ${analysisId}`);
            unwrapOrThrow(await completeDataProfile(deps.pool, analysisId));
            await deps.runAuthorizer.revoke(authorization, "data-profile-completed");
            return;
        }

        // 2. Register staged files in cortex_artifacts
        await upsertArtifacts(
            deps.pool,
            stagedInputs.map((f) => ({
                resourceId: analysisId,
                path: inputArtifactPath(f),
                hash: f.hash,
                size: f.size,
                role: "input" as const,
                fileId: f.fileId,
            })),
        );

        // 3. Run data-profiler sandbox agent
        const fileList = stagedInputs.map((f) => inputArtifactPath(f));
        const prompt = [
            `Profile all input data files for this analysis.`,
            ``,
            `IMPORTANT: You MUST use execute_command to profile files before submitting results. Do NOT submit empty files or placeholder text.`,
            ``,
            `CRITICAL: File and directory paths may contain spaces. You MUST always double-quote paths in shell commands (e.g. head "data/inputs/My Folder/file.csv"). Unquoted paths with spaces will silently break commands.`,
            ``,
            `The following input files are available (paths relative to analysis root):`,
            ...fileList.map((f) => `- ${f}`),
            ``,
            `Steps:`,
            `1. For each file, use head and wc to inspect structure (ALWAYS double-quote file paths)`,
            `2. Write a Python script for detailed profiling — use pathlib or os.path for path handling (handles spaces natively)`,
            `3. Call the \`submit_profile\` tool with structured metadata for EVERY file listed above`,
            ``,
            `The analysis root is mounted at /${analysisId}/. All file paths in your response must be relative to the analysis root and must EXACTLY match the paths listed above.`,
        ].join("\n");

        const executionId = generateExecutionId(DATA_PROFILE_AGENT_ID);
        const workflowId = DBOS.workflowID ?? `${DATA_PROFILE_RUN_LITERAL}:${executionId}`;
        const childSession = forSubAgent(runSession, DATA_PROFILE_AGENT_ID);

        console.log(`[data-profile] execution=${executionId} analysis=${analysisId} starting sandbox`);

        const sandbox = await deps.sandboxClient.createSandbox(
            {
                runId: DATA_PROFILE_RUN_LITERAL,
                stepId: DATA_PROFILE_STEP_LITERAL,
                analysisId,
                childWorkflowId: workflowId,
                resources: estimateDataProfileResources(stagedInputs),
            },
            mintSandboxIdentity(DATA_PROFILE_RUN_LITERAL),
        );

        try {
            // Checkpointed clock, not `Date.now()`: `awaitExec` gates on this absolute
            // deadline and its recovery-pull is a durable step, so a wall-clock deadline
            // that grew on replay would shift which loop iteration crosses the deadline
            // and desynchronise the recorded function-ID sequence (see sandbox-step.ts,
            // which captures its step deadline the same way).
            const deadlineAbs = (await DBOS.now()) + DEFAULT_DEADLINE_MS;
            const nextFunctionId = makeNextFunctionId();

            const sandboxAgentDeps: SandboxAgentDeps = {
                provider: deps.provider,
                pool: deps.pool,
                sandboxClient: deps.sandboxClient,
                workspaceFs: deps.workspaceFs,
                embedding: deps.embedding,
                model: deps.model,
                skillsDir: deps.skillsDir,
                bioKeys: deps.bioKeys,
                step: {
                    sandbox,
                    sessionsBasePath: deps.sessionsBasePath,
                    analysisId,
                    runId: DATA_PROFILE_RUN_LITERAL,
                    stepId: DATA_PROFILE_STEP_LITERAL,
                    workflowId,
                    // The profiler writes Python scripts and intermediate artifacts under
                    // the synthetic step path; the post-agent `rm -rf runs/data-profile/`
                    // cleanup wipes them.
                    allowedWritePrefix: `${deps.sessionsBasePath}/${analysisId}/runs/${DATA_PROFILE_RUN_LITERAL}/${DATA_PROFILE_STEP_LITERAL}`,
                    nextFunctionId,
                    deadlineMs: () => deadlineAbs,
                },
            };

            let capturedProfile: ProfilerOutput | null = null;
            const submitProfileTool = defineTool({
                id: "submit_profile",
                description:
                    "Submit the profiling results. Call this tool once after completing " + "all profiling work — it validates and records your findings.",
                inputSchema: ProfilerOutputSchema,
                execute: async (input) => {
                    capturedProfile = input;
                    return ok({ status: "accepted" });
                },
            });

            const baseAgent = createDataProfilerAgent(sandboxAgentDeps);
            const agentDef = { ...baseAgent, tools: [...baseAgent.tools, submitProfileTool] };

            const signal = new AbortController().signal;
            await runToTerminal(
                agentDef,
                [{ role: "user", content: prompt }],
                childSession,
                {
                    provider: deps.provider,
                    signal,
                    emit: () => {},
                    runStep: durableStep,
                },
                {
                    resolved: () => capturedProfile !== null,
                    tools: [submitProfileTool],
                    nudge:
                        "You stopped without calling submit_profile, so no profile was " +
                        "recorded. Call submit_profile now with structured metadata for " +
                        "every input file — base it on the profiling you already did.",
                },
            );

            if (!capturedProfile) {
                throw new Error("Data profiling failed: agent did not call submit_profile");
            }
            const profilerData = capturedProfile as ProfilerOutput;

            // 4. Index into vector store — real files only, consistent type metadata
            const profilerByPath = new Map(profilerData.files.map((f) => [f.path, f]));
            const normPath = (p: string): string =>
                p
                    .replace(/\/+/g, "/")
                    .replace(/^\/|\/$/g, "")
                    .trim();
            const profilerByNorm = new Map(profilerData.files.map((f) => [normPath(f.path), f]));
            await ensureSearchIndex(deps.pool, analysisId, deps.embedding.dimensions);
            const vectorStore = createVectorStore(deps.pool);
            const embedOne = async (text: string, session: RunSession): Promise<number[]> => {
                const [vec] = unwrapOrThrow(await deps.embedding.embed([text], session));
                if (!vec) throw new Error("data-profile: empty embedding response");
                return vec;
            };
            const indexName = searchIndexName(analysisId);
            let indexed = 0;
            let fallbackCount = 0;
            for (const matFile of stagedInputs) {
                const dbPath = inputArtifactPath(matFile);
                const desc = profilerByPath.get(dbPath) ?? profilerByNorm.get(normPath(dbPath));

                // Lossless: a materialized input file the profiler agent omitted
                // still gets a deterministic, no-LLM description so it stays
                // discoverable via search. The agent's profile is enrichment, not a
                // gate on indexing — mirrors the step-output metadata fallback.
                const searchMeta: Record<string, unknown> = desc
                    ? {
                          text: desc.description,
                          type: "input",
                          dataType: desc.dataType,
                          format: desc.format,
                          ...(desc.tags ? { tags: desc.tags } : {}),
                      }
                    : {
                          text: `${dbPath} — input file (${fileExtension(dbPath)}, ${matFile.size} bytes); automated profile unavailable.`,
                          type: "input",
                          dataType: "unknown",
                          format: fileExtension(dbPath),
                      };
                if (!desc) fallbackCount++;

                const embedding = await embedOne(searchMeta.text as string, runSession);
                unwrapOrThrow(
                    await vectorStore.upsert({
                        indexName,
                        vectors: [embedding],
                        metadata: [searchMeta],
                        ids: [`/${analysisId}/${dbPath}`],
                    }),
                );
                indexed++;
            }

            if (fallbackCount > 0) {
                console.warn(
                    `[data-profile] ${fallbackCount}/${stagedInputs.length} input file(s) used a deterministic fallback description (analysis=${analysisId}) — profiler omitted them`,
                );
            }
            console.log(`[data-profile] Indexed ${indexed} file(s) for ${analysisId}`);

            // 5. Complete — store result with input snapshot for staleness detection
            unwrapOrThrow(
                await completeDataProfile(deps.pool, analysisId, {
                    summary: profilerData.analysisSummary,
                    files: profilerData.files.map((f) => ({
                        path: f.path,
                        description: f.description,
                    })),
                    inputFileIds: stagedInputs.map((f) => f.fileId),
                    // The drift comparand beside the audit record: `inputFileIds` says WHICH files
                    // this profile covered, `inputFiles` says whether they held the same bytes.
                    inputFiles: stagedInputs.map((f) => ({ fileId: f.fileId, size: f.size, mtimeMs: f.mtimeMs })),
                    profiledAt: new Date().toISOString(),
                }),
            );
            await deps.runAuthorizer.revoke(authorization, "data-profile-completed");
        } finally {
            try {
                await deps.sandboxClient.teardown(sandbox);
            } catch (teardownErr) {
                console.warn(`[data-profile] execution=${executionId} teardown failed (non-fatal):`, teardownErr);
            }
        }
    } catch (err) {
        console.error(`[data-profile] Failed for ${analysisId}:`, err);
        unwrapOrThrow(await failDataProfile(deps.pool, analysisId, profileFailureReason(err)));
        await deps.runAuthorizer.revoke(authorization, "data-profile-failed");
    }
}

export type DataProfileTriggerResult = "started" | "restarted" | "already_running" | "failed";

/**
 * Route-side deps for triggering the data-profile workflow: the ledger pool,
 * the run authorizer, and the registered workflow callable. The body's
 * construction-time deps are closed over at registration
 * (`registerDataProfileWorkflow`); the route never holds them.
 */
export interface DataProfileTriggerDeps {
    readonly pool: Pool;
    readonly runAuthorizer: RunAuthorizer;
    readonly workflow: (input: DataProfileWorkflowInput) => Promise<void>;
}

/**
 * Identity + staged inputs for a profile run. The caller (the managed route /
 * the CLI) stages `data/inputs/` BEFORE triggering (see the data-profile-init spec) and passes the
 * resulting manifest here; this trigger never stages — it forwards the manifest
 * into the workflow input.
 */
export interface DataProfileTriggerParams {
    readonly auth: AuthContext;
    readonly analysisId: string;
    readonly stagedInputs: readonly StagedInput[];
}

/**
 * Resolve the `RunSession` the workflow runs under. Whether the authorization
 * is freshly minted (Cortex-owned) or reused (caller-owned) is decided by the
 * `RunAuthorizer` seam from the opaque auth; this passes that auth straight
 * through and never inspects it.
 */
export async function authorizeDataProfile(deps: DataProfileTriggerDeps, params: DataProfileTriggerParams): Promise<RunAuthorization> {
    const { auth, analysisId } = params;
    return deps.runAuthorizer.authorize({
        auth,
        scope: { kind: "analysis", analysisId },
        provenance: { agentId: DATA_PROFILE_AGENT_ID, callPath: [DATA_PROFILE_AGENT_ID] },
        frame: { runId: DATA_PROFILE_RUN_LITERAL, stepId: DATA_PROFILE_STEP_LITERAL },
    });
}

/**
 * Per-attempt DBOS workflow id. The `nonce` is fresh per attempt (a bare
 * `randomUUID()` minted at the trigger), so each (re-)profile of the same
 * analysis gets a distinct id. DBOS workflow ids are permanent idempotency
 * keys: a stable `dataprofile:{analysisId}` would make every attempt after the
 * first a no-op — a re-profile/retry would dedup against the first (terminal)
 * run, the body would never re-execute, and the ledger would sit at 'running'
 * until it timed out. Concurrent double-starts are already prevented by the
 * ledger CAS in tryStart/tryRerun/tryRetry, so the id does not need to dedup
 * them. (`runId` is the constant `DATA_PROFILE_RUN_LITERAL`, so it can't key
 * the id; an explicit nonce is what distinguishes attempts.)
 */
export function dataProfileWorkflowId(analysisId: string, nonce: string): string {
    return `dataprofile:${analysisId}:${nonce}`;
}

/**
 * Authorize the run via the `RunAuthorizer` and start the data-profile workflow
 * under a per-attempt id `dataprofile:{analysisId}:{nonce}` — concurrent
 * triggers are already serialized by the ledger CAS. The caller has already
 * staged the inputs and supplied the manifest in `params.stagedInputs`; this
 * forwards it into the workflow input. Fire-and-forget: the handle result is
 * not awaited.
 */
async function startDataProfileWorkflow(deps: DataProfileTriggerDeps, params: DataProfileTriggerParams): Promise<void> {
    const { runSession, ownsMandate } = await authorizeDataProfile(deps, params); // oss-core-managed-ok
    const attemptNonce = randomUUID();
    await DBOS.startWorkflow(deps.workflow, {
        workflowID: dataProfileWorkflowId(params.analysisId, attemptNonce),
    })({
        analysisId: params.analysisId,
        runSession,
        ownsMandate, // oss-core-managed-ok
        stagedInputs: params.stagedInputs,
    });
}

/**
 * Attempt to claim and run data profiling for an analysis, then start the workflow
 * fire-and-forget for whichever claim won. Safe to call from multiple sites
 * concurrently: the claims are CAS UPDATEs, so at most one caller dispatches.
 *
 * Every claim requires a non-empty `seed_input_file_ids` — a profile must always name
 * the files it covers. The startable claim takes `'pending'` or a NULL status (NULL is
 * the cleared-then-reseeded state); the rerun claim takes `'completed'`. A `'failed'`
 * row is claimed by neither: retrying a failure is a deliberate act the caller drives
 * through `tryRetryDataProfile` + `runDataProfile`.
 *
 * Returns what happened, so the caller can surface it (e.g. in the seed response).
 */
export async function triggerDataProfile(deps: DataProfileTriggerDeps, params: DataProfileTriggerParams): Promise<DataProfileTriggerResult> {
    const { analysisId } = params;
    try {
        // ADVISORY pre-check, not the enforcement — the claim CAS carries the same seed
        // conjunct (see `SEEDED` in state/data-profile.ts) and is what actually makes a
        // seedless `running` row impossible. This read exists only to name the cause: on
        // the ordinary non-racing path it turns an opaque "no claim matched" into a
        // precise "the caller skipped seeding". An empty array is not a seed — it names
        // zero files. `loadDataProfileStatus` collapses NULL-status rows to null by
        // contract, so the seed column is read directly.
        const seeded = await deps.pool
            .query<{ seed: string[] | null }>({
                text: "SELECT seed_input_file_ids AS seed FROM cortex_analysis_state WHERE analysis_id = $1",
                values: [analysisId],
            })
            .then((r) => r.rows[0]?.seed ?? null);
        if (seeded === null || seeded.length === 0) {
            console.error(`[data-profile] Trigger rejected for ${analysisId}: no seeded input set (caller skipped seeding)`);
            return "failed";
        }

        const started = unwrapOrThrow(await tryStartDataProfile(deps.pool, analysisId));
        if (started) {
            startDataProfileWorkflow(deps, params).catch((err) => compensateStartFailure(deps, analysisId, "Run", err));
            return "started";
        }
        const restarted = unwrapOrThrow(await tryRerunDataProfile(deps.pool, analysisId));
        if (restarted) {
            startDataProfileWorkflow(deps, params).catch((err) => compensateStartFailure(deps, analysisId, "Re-run", err));
            return "restarted";
        }
        const status = unwrapOrThrow(await loadDataProfileStatus(deps.pool, analysisId));
        if (status?.status === "running") return "already_running";
        return "failed";
    } catch (err) {
        console.error(`[data-profile] Trigger error for ${analysisId}:`, err);
        return "failed";
    }
}

/**
 * Compensate a fire-and-forget start that rejected. The ledger CAS in
 * `tryStart`/`tryRerun`/`tryRetry` already flipped the row to `running`; if the
 * dispatch never landed a workflow, DBOS has nothing to recover, so without
 * this the row would sit at `running` forever and every later trigger would
 * report `already_running`. Failing the ledger lets the retry path recover.
 * Best-effort — a compensation write that itself fails is only logged, since
 * there is no further channel to report it on.
 */
async function compensateStartFailure(deps: DataProfileTriggerDeps, analysisId: string, phase: string, err: unknown): Promise<void> {
    console.error(`[data-profile] ${phase} error for ${analysisId}:`, err);
    const failed = await failDataProfile(deps.pool, analysisId, profileFailureReason(err));
    if (failed.isErr()) {
        console.error(`[data-profile] Failed to mark ${analysisId} failed after a start error:`, failed.error);
    }
}

/**
 * Start the data-profile workflow for an already-claimed analysis (the retry
 * route claims via `tryRetryDataProfile`, then calls this). The caller does not
 * await the workflow's completion, but a start that rejects compensates the
 * ledger (see {@link compensateStartFailure}) before re-throwing, so a caller's
 * own `.catch` still observes the error and the row never wedges at `running`.
 */
export async function runDataProfile(deps: DataProfileTriggerDeps, params: DataProfileTriggerParams): Promise<void> {
    try {
        await startDataProfileWorkflow(deps, params);
    } catch (err) {
        await compensateStartFailure(deps, params.analysisId, "Retry", err);
        throw err;
    }
}

/**
 * Concise, UI-safe failure reason. `data_profile_error` is surfaced verbatim
 * to the frontend, so raw errors — K8s API response bodies, multi-line stack
 * traces — must never reach it. The full error is preserved in the logs; this
 * collapses to a single bounded line for display.
 */
const PROFILE_ERROR_MAX_LEN = 200;
function profileFailureReason(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    const firstLine = raw.split("\n", 1)[0]!.replace(/\s+/g, " ").trim();
    return firstLine.length > PROFILE_ERROR_MAX_LEN ? firstLine.slice(0, PROFILE_ERROR_MAX_LEN - 1) + "…" : firstLine || "Data profiling failed";
}

/** Per-call function-id minter — replay-deterministic. */
function makeNextFunctionId(): () => string {
    let n = 0;
    return () => `fn-${(n++).toString(36)}`;
}
