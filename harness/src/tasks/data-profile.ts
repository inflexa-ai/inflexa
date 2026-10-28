/**
 * Data-profile DBOS workflow — scans the already-staged input tree, runs the
 * data-profiler sandbox agent over the resulting manifest, registers each staged
 * file in cortex_artifacts, and indexes the profile's groups, dimensions, and annotated
 * members into the pgvector store. Inputs are staged under `data/inputs/` by the embedder before the
 * run (see the data-profile-init spec); the body assumes a populated tree and never
 * downloads.
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

import { errorMessageOf } from "../lib/thrown.js";
import { textOf } from "../lib/unknown-text.js";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { isWorkflowCancellation } from "../runtime/dbos.js";
import { randomUUID } from "node:crypto";
import { ResultAsync, err, ok, type Result } from "neverthrow";

import { forStep, forSubAgent, type AuthContext, type RunSession } from "../auth/types.js";
import { presentFirst } from "../lib/present.js";
import { collapseWhitespace } from "../lib/text.js";
import type { EnvironmentStorePaths } from "../config/environment-stores.js";
import type { ExtendAnalysisFarm } from "../sandbox/types.js";
import type { RunAuthorizer } from "../execution/run-authorizer.js";
import type { RunLauncher } from "../execution/run-launcher.js";
import type { StagedInput } from "../execution/staged-input.js";
import { createDataProfilerAgent } from "../agents/sandbox/data-profiler.js";
import type { SandboxAgentDeps } from "../agents/sandbox/shared.js";
import type { BioToolKeys } from "../tools/bio/keys.js";
import { runWithSalvage, type LoopStep } from "../loop/run-loop.js";
import { recordedInputOf } from "../loop/tool-adapter.js";
import type { ToolOutputStore } from "../loop/tool-output.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { DbError } from "../lib/db-result.js";
import type { Querier } from "../state/db.js";
import { deliverNotice, passGate, type GateRefusal, type NoticeFailure } from "../lib/hooks.js";
import type { Logger } from "../lib/logger.js";
import type { UsageRecorder } from "../billing/usage-recorder.js";
import { unwrapOrThrow } from "../lib/result.js";
import { defineTool, type Tool, type ToolError } from "../tools/define-tool.js";
import { createDetailResolver } from "../tools/detail-resolver.js";
import type { ChatProvider, EmbeddingProvider } from "../providers/types.js";
import { renderResources, renderWorkspace } from "../prompts/briefing.js";
import type { SandboxClient } from "../sandbox/client.js";
import { keepSuspendingRefusal, SandboxFailure, type SuspendingRefusal } from "../sandbox/sandbox-error.js";
import { workPause } from "../workflows/pause.js";
import { clearPausesOfWork } from "../state/paused-work.js";
import type { SandboxRef } from "../sandbox/types.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import { toSandboxPath, type ResolveWorkspaceRoot } from "../workspace/paths.js";

import { estimateDataProfileResources } from "../sandbox/estimate-data-profile-resources.js";
import { generateExecutionId } from "../sandbox/execution-id.js";
import { mintSandboxIdentity } from "../sandbox/identity.js";
import { createVectorStore } from "../state/vector-store.js";
import { z } from "zod";

import type { AnalysisStep } from "../schemas/workflow-state.js";
import { ProfileSubmissionSchema, type ProfileSubmission } from "../schemas/data-profile-schemas.js";
import { computeInputSignature } from "../execution/input-signature.js";
import { readHeaders } from "../input-scan/enrich.js";
import { detectSets } from "../input-scan/detect-sets.js";
import { buildSetMenu, renderSetMenu, type SetMenu } from "../input-scan/menu.js";
import { readoutTargets } from "../input-scan/readout-budget.js";
import type { DetectedSets } from "../input-scan/set-types.js";
import { scanInputTree } from "../input-scan/scan.js";
import type { HeaderReadout, InputScan } from "../input-scan/types.js";
import type { DataProfileDimension, DataProfileGroup, DataProfileProbeReport } from "../contracts/data-profile.js";
import { PROFILE_INDEX_TYPES, buildProfileIndexEntries } from "./data-profile-index.js";
import { absorbRecipe, renderAbsorbDelta, type AbsorbKind, type AbsorbOutcome } from "./data-profile-absorb.js";
import { formatResolutionErrors, resolveProfileSubmission, type ProfileResolution, type ResolvedGroup } from "./data-profile-resolve.js";
import {
    completeDataProfile,
    completeEmptyDataProfile,
    failDataProfile,
    loadDataProfileStatus,
    loadSeedInputFileIds,
    recordDataProfileWorkflowId,
    tryRerunDataProfile,
    tryStartDataProfile,
    upsertArtifacts,
    type DataProfileResult,
    type DataProfileTerminalWrite,
} from "../state/index.js";
import { elapsedSinceIso, recordRunCompleted } from "../lib/metrics.js";
import { createProfileActivityEmitter, type ProfileActivityEmitter } from "./data-profile-activity.js";
import { ensureSearchIndex, searchIndexName } from "../workspace/search-config.js";
// The run literal is declared in `contracts/` — a consumer reads it back off recorded usage, and this
// module is unimportable to one that only wants the string (see the constant's own doc).
import { DATA_PROFILE_RUN_LITERAL } from "../contracts/data-profile.js";

const DATA_PROFILE_STEP_LITERAL = "profile" as const;
const DATA_PROFILE_AGENT_ID = "data-profiler" as const;

/**
 * Sandbox-server exec budget for the profile run. Twenty minutes: the deterministic
 * scan bounds the discovery half, and what remains is the agent's own reading of a
 * bounded number of example files.
 */
const DEFAULT_DEADLINE_MS = 1_200_000;

/** Index entries embedded and upserted per round trip. */
const INDEX_BATCH_SIZE = 256;

const SUBMIT_PROFILE_TOOL_ID = "submit_profile";

/** What one call of `submit_profile` tells the agent. */
const SubmitOutcomeSchema = z.discriminatedUnion("status", [
    z.object({ status: z.literal("needs_repair"), detail: z.string() }),
    z.object({
        status: z.literal("accepted"),
        groups: z.number(),
        keptFiles: z.number(),
        unclassifiedFiles: z.number(),
        unresolvedOperations: z.number(),
    }),
]);

type SubmitOutcome = z.infer<typeof SubmitOutcomeSchema>;

/**
 * The first message of the profiler. No scheduler composes a briefing for it, thus this message is its briefing: the
 * system prompt names no paths, because it is static for each agent type. The workspace frame and the resource budget
 * use the same words as the step briefing.
 */
export function composeProfilerSeed(args: {
    readonly analysisId: string;
    /** The in-sandbox working directory of the profiler. */
    readonly workingDir: string;
    readonly resources: AnalysisStep["resources"];
    readonly menu: SetMenu;
    readonly absorb: AbsorbOutcome;
}): string {
    return [
        `Profile the input data for this analysis: say what the dataset IS, so planning can proceed.`,
        ``,
        renderWorkspace({ analysisId: args.analysisId, workingDir: args.workingDir }),
        ``,
        renderResources(args.resources),
        ``,
        renderSetMenu(args.menu, STAGED_INPUT_ROOT),
        ``,
        ...(args.absorb.kind === "partial"
            ? [renderAbsorbDelta(args.absorb), ``]
            : [
                  `Author the dataset's groups as operations on this menu: \`use\` a set, \`split\` one by a slot or by a`,
                  `value mapping, \`merge\` several, or \`group\` explicit paths the scan left over. Membership and counts`,
                  `are computed from your operations — you do not state them. Inspect ONE example file per group where a`,
                  `description needs content the scan did not capture, then deliver the groups with \`submit_profile\`.`,
              ]),
    ].join("\n");
}

/** The terminal tool of the profiler: it resolves the operations of a submission against the scan and the menu. */
export function createSubmitProfileTool(detected: DetectedSets, menu: SetMenu): Tool<ProfileSubmission, SubmitOutcome> {
    return defineTool({
        id: SUBMIT_PROFILE_TOOL_ID,
        description:
            "Submit the profiling results. Call this tool after completing all profiling work — it resolves your " +
            "operations against the scan, computes every group's membership and counts, and checks the profile. " +
            "A submission whose operations do not resolve, or that leaves kept files unclaimed, comes back with " +
            "the errors; the repair is a FULL resubmit of the whole operation list. The last accepted submission is the profile.",
        inputSchema: ProfileSubmissionSchema,
        describeCall: "none",
        execute: (input): Promise<Result<SubmitOutcome, ToolError>> => {
            const resolution = resolveProfileSubmission(input, detected, menu, { finalRound: false });
            if (resolution.errors.length > 0 || resolution.unclaimed.length > 0) {
                return Promise.resolve(ok({ status: "needs_repair", detail: formatResolutionErrors(resolution) }));
            }
            return Promise.resolve(
                ok({
                    status: "accepted",
                    groups: resolution.groups.length,
                    keptFiles: resolution.partition.keptFiles,
                    unclassifiedFiles: resolution.partition.unclassifiedFiles,
                    unresolvedOperations: resolution.errors.length,
                }),
            );
        },
    });
}

/** The submissions of a run, in call order, with the outcome that the tool gave each one. */
function profileSubmissions(steps: readonly LoopStep[]): { readonly submission: ProfileSubmission; readonly accepted: boolean }[] {
    const submissions: { submission: ProfileSubmission; accepted: boolean }[] = [];
    for (const step of steps) {
        for (const call of step.calls) {
            if (call.toolName !== SUBMIT_PROFILE_TOOL_ID || call.output?.outcome !== "ok") continue;
            const submission = recordedInputOf(ProfileSubmissionSchema, call.input);
            const outcome = SubmitOutcomeSchema.safeParse(call.output.value);
            if (submission === undefined || !outcome.success) continue;
            submissions.push({ submission, accepted: outcome.data.status === "accepted" });
        }
    }
    return submissions;
}

/**
 * The submission that the profile records: the last accepted one, else the last one. A repair is a FULL
 * resubmit — nothing merges into the prior attempt. The last submission of a run with no accepted one
 * resolves as final: an operation that still does not resolve produces no group, and its members land in
 * the visible `unclassified` group rather than blocking a profile that gates planning.
 */
function selectedSubmission(
    steps: readonly LoopStep[],
): { readonly submission: ProfileSubmission; readonly accepted: boolean; readonly count: number } | undefined {
    const submissions = profileSubmissions(steps);
    const chosen = submissions.filter((entry) => entry.accepted).at(-1) ?? submissions.at(-1);
    return chosen === undefined ? undefined : { ...chosen, count: submissions.length };
}

/** Where the embedder stages this analysis's inputs (see the data-profile-init spec). */
const STAGED_INPUT_ROOT = "data/inputs";

/** The settle of one profile claim: the ledger row left `running`, and the terminal write stamped it. */
export type DataProfileSettlement = {
    readonly analysisId: string;
    readonly status: "completed" | "failed";
    /** The `data_profile_completed_at` that the terminal write stamped, as an ISO 8601 string. */
    readonly completedAt: string;
};

/** The notice of a profile settle. The workflow body calls it one time for each settled claim. */
export type NotifyDataProfileSettled = (settlement: DataProfileSettlement) => ResultAsync<void, NoticeFailure>;

/** The body's construction-time deps — closed over at registration. */
export type DataProfileDeps = EnvironmentStorePaths & {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    readonly provider: ChatProvider;
    readonly pool: Querier;
    readonly sandboxClient: SandboxClient;
    readonly workspaceFs: WorkspaceFilesystem;
    /** Workspace-root resolution seam (see workspace/paths.ts). */
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
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
    /** LLM usage-accounting seam for the profiler agent loop; omitted falls back to the no-op recorder. */
    readonly usageRecorder?: UsageRecorder;
    /** The store of the profiler loop and of its read tool. */
    readonly toolOutputStore?: ToolOutputStore;
    /**
     * The farm-extension seam of the embedder. Bound, it rides into the
     * profiler agent deps, and the substrate attaches `link_packages`. Thus
     * the profiler links a reader by need before the first plan exists.
     * Unbound keeps the current shape: no link tool, and no error.
     */
    readonly extendAnalysisFarm?: ExtendAnalysisFarm;
    /**
     * Notice of each profile settle, for the records of the embedder. Unbound, the
     * body calls nothing. It is not a provenance hook.
     */
    readonly notifyDataProfileSettled?: NotifyDataProfileSettled;
    /** The delays of the timer of an outage. Absent: the default of the pause. */
    readonly pauseRetryDelaysMs?: readonly number[];
};

/**
 * Workflow input. JSON-serialisable — DBOS persists it as the workflow's
 * input row. The `RunSession` carries the run authorization; the body reads it
 * and never mints.
 */
export type DataProfileWorkflowInput = {
    readonly analysisId: string;
    readonly runSession: RunSession;
    /**
     * Manifest of the input files staged under `data/inputs/` before the run
     * started (see the data-profile-init spec). The body assumes the tree is populated and profiles
     * exactly these files — it never downloads. JSON-serializable; rides in the
     * DBOS workflow input and survives recovery.
     */
    readonly stagedInputs: readonly StagedInput[];
};

/** Build the canonical artifact path for a staged input file. */
function inputArtifactPath(f: StagedInput): string {
    return `data/${f.relativePath}`;
}

/**
 * Project the profiler's structured output plus the staged manifest into the record
 * persisted on `cortex_analysis_state`.
 *
 * That row is the profile's ONLY durable home — the profiler's `runs/data-profile/`
 * scratch tree is deleted on completion, so nothing here is recoverable from a file
 * later. The projection is therefore total: every field the profiler reported is
 * carried through verbatim. A field this drops is not "summarized away", it is
 * destroyed, and the next agent that needs it can only get it back by re-reading the
 * raw inputs.
 *
 * `undefined` members are dropped by `JSON.stringify` on the way into the jsonb
 * column, so an optional the profiler left unset simply does not appear in the row —
 * indistinguishable from a legacy snapshot that predates the field, which is exactly
 * the reading a consumer must already tolerate.
 */
export function buildDataProfileResult(
    submission: ProfileSubmission,
    resolution: ProfileResolution,
    stagedInputs: readonly StagedInput[],
    profiledAt: string,
): DataProfileResult {
    return {
        summary: submission.analysisSummary,
        groups: withoutMembers(resolution.groups),
        dimensions: [...resolution.dimensions],
        probes: [...resolution.probes],
        partition: resolution.partition,
        recipe: [...resolution.recipe],
        caveats: submission.caveats,
        inputSignature: computeInputSignature(stagedInputs),
        profiledAt,
        domain: submission.domain,
        subtype: submission.subtype,
        organism: submission.organism,
        tissue: submission.tissue,
        cellType: submission.cellType,
        condition: submission.condition,
        accessions: submission.accessions,
        experimentalDesign: submission.experimentalDesign,
    };
}

/**
 * Read one header per set, once a container exists.
 *
 * The walk and the set detection run before any sandbox — a profile that absorbs a prior
 * recipe never provisions one. Every prefix-sufficient readout also runs in this process
 * over the workspace read seam; only a footer-indexed container reaches into the sandbox,
 * and only once per set. A readout that fails is logged and dropped: it is enrichment,
 * and a menu without it still carries every structural observation the agent's grouping
 * rests on, so failing the profile over it would trade the whole capability for a nicety.
 */
async function readSetHeaders(args: {
    readonly session: RunSession;
    readonly deps: DataProfileDeps;
    readonly analysisId: string;
    readonly detected: DetectedSets;
    readonly sandbox: SandboxRef;
    readonly deadlineMs: number;
    readonly logger: Logger;
}): Promise<ReadonlyMap<string, HeaderReadout>> {
    const { session, deps, analysisId, detected, sandbox, deadlineMs, logger } = args;
    try {
        return await readHeaders({
            targets: readoutTargets(detected),
            session,
            fs: deps.workspaceFs,
            sandboxClient: deps.sandboxClient,
            sandbox,
            mountRoot: `/${analysisId}`,
            deadlineMs,
            emit: async () => {},
        });
    } catch (err) {
        if (isWorkflowCancellation(err)) throw err;
        logger.warn("input-scan header readout failed (non-fatal)", logger.errorFields(err));
        return new Map();
    }
}

/**
 * The submission a tree with nothing to group would have produced.
 *
 * Authored here rather than by a model: with no kept file there is no judgement to make,
 * and the fields below say exactly that. Resolution turns it into the census — zero
 * groups against a full quarantine accounting — which is the honest record of such a tree
 * and is what keeps `inspect_data_profile` from reporting the analysis unprofiled.
 */
function emptySubmission(): ProfileSubmission {
    return {
        operations: [],
        analysisSummary:
            "The input scan kept no files: every staged file was quarantined as OS junk, an editor temp, or a partial download. " +
            "There is no dataset structure to describe. See the quarantine accounting for what was set aside and why.",
        domain: "",
        organism: null,
    };
}

/** The membership the persisted record deliberately does not carry. */
function withoutMembers(groups: readonly ResolvedGroup[]): DataProfileGroup[] {
    return groups.map(({ memberPaths, ...group }) => {
        void memberPaths;
        return group;
    });
}

/**
 * The prior profile re-stamped over a deterministic absorb.
 *
 * Membership, counts, the partition, the recipe, and the signature come from the replay;
 * everything the agent authored — the summary, the identity fields, the dimensions, the
 * probes, the caveats — is the profile's existing finding and is carried verbatim. An
 * absorb re-derives arithmetic, and re-deciding judgement without a model is not something
 * this path is entitled to do.
 */
export function buildAbsorbedResult(
    prior: DataProfileResult,
    resolution: ProfileResolution,
    stagedInputs: readonly StagedInput[],
    profiledAt: string,
): DataProfileResult {
    return {
        ...prior,
        groups: withoutMembers(resolution.groups),
        // Re-resolved, not carried: a slot observation's cardinality and values are computed
        // from the scan, and the scan just changed. The labels and the reasoning are the
        // profile's existing finding; the numbers under them are this replay's.
        dimensions: [...resolution.dimensions],
        partition: resolution.partition,
        recipe: [...resolution.recipe],
        inputSignature: computeInputSignature(stagedInputs),
        profiledAt,
    };
}

/**
 * Build and upsert the profile's vector index — one entry per group, one per dimension,
 * one per annotated member, none per unannotated file.
 *
 * A pure projection of the persisted profile crossed with the scan, so an absorb rebuilds
 * it from the same two things the agent path does. Embedding is not a model judgement:
 * leaving the index behind after an absorb would make the newly absorbed members
 * unsearchable while the record said they were profiled.
 */
async function indexProfile(args: {
    readonly deps: DataProfileDeps;
    readonly analysisId: string;
    readonly session: RunSession;
    readonly record: DataProfileResult;
    readonly scan: InputScan;
    readonly logger: Logger;
}): Promise<void> {
    const { deps, analysisId, session, record, scan, logger } = args;
    await ensureSearchIndex(deps.pool, analysisId, deps.embedding.dimensions);
    const vectorStore = createVectorStore(deps.pool);
    const indexName = searchIndexName(analysisId);
    const entries = buildProfileIndexEntries({ analysisId, result: record, scan });

    // Replace, don't merge. The tiers are a projection of THIS profile, and an upsert keyed
    // by entry id leaves a renamed group, a dropped dimension, and a de-annotated member
    // behind — searchable, and describing a profile that no longer exists.
    unwrapOrThrow(await vectorStore.deleteByType({ indexName, types: [...PROFILE_INDEX_TYPES] }));

    // Batched: both interfaces already take arrays, and one round trip per entry is
    // what made indexing 12 of the 39 minutes the motivating profile took.
    for (let start = 0; start < entries.length; start += INDEX_BATCH_SIZE) {
        const batch = entries.slice(start, start + INDEX_BATCH_SIZE);
        const vectors = unwrapOrThrow(
            await deps.embedding.embed(
                batch.map((entry) => entry.text),
                session,
            ),
        );
        if (vectors.length !== batch.length) throw new Error(`data-profile: embedding returned ${vectors.length} vectors for ${batch.length} entries`);
        unwrapOrThrow(
            await vectorStore.upsert({
                indexName,
                vectors,
                metadata: batch.map((entry) => ({ ...entry.metadata, text: entry.text })),
                ids: batch.map((entry) => entry.id),
            }),
        );
    }
    logger.info("indexed profile", { entries: entries.length, groups: record.groups?.length ?? 0 });
}

/**
 * The counters the catalogue's fit against real use is measured from — one structured
 * event per completed profile, emitted whether or not anything went wrong.
 */
function logProfileMonitoring(
    logger: Logger,
    args: {
        /** Absent on a profile that completed without resolving anything — an empty or wholly quarantined tree. */
        readonly resolution?: ProfileResolution;
        readonly dimensions: readonly DataProfileDimension[];
        readonly probes: readonly DataProfileProbeReport[];
        readonly repairRounds: number;
        readonly absorb: AbsorbKind;
    },
): void {
    const { resolution, dimensions, probes, repairRounds, absorb } = args;
    logger.info("profile monitoring", {
        absorb,
        repairRounds,
        unresolvedOperations: resolution?.errors.length ?? 0,
        contestedFiles: resolution?.contested.length ?? 0,
        unclassifiedFiles: resolution?.partition.unclassifiedFiles ?? 0,
        keptFiles: resolution?.partition.keptFiles ?? 0,
        scanTruncated: resolution?.partition.scanTruncated ?? false,
        otherGroupCategories: (resolution?.groups ?? []).filter((group) => group.category === "other" && !group.unclassified).length,
        otherDimensionCategories: dimensions.filter((dimension) => dimension.category === "other").length,
        probeNotFound: probes.filter((probe) => probe.outcome === "not-found").length,
    });
}

/**
 * Register the data-profile workflow with DBOS. Returns the registered
 * callable so `triggerDataProfile` can dispatch it through the run launcher.
 */
/**
 * Project the workflow deps onto the profiler agent bag. The farm-extension
 * seam rides only when the embedder bound one, and the substrate then gates
 * `link_packages` on its presence (the data-profile-init spec).
 */
export function profilerSandboxAgentDeps(deps: DataProfileDeps, step: SandboxAgentDeps["step"]): SandboxAgentDeps {
    return {
        provider: deps.provider,
        pool: deps.pool,
        sandboxClient: deps.sandboxClient,
        workspaceFs: deps.workspaceFs,
        embedding: deps.embedding,
        model: deps.model,
        skillsDir: deps.skillsDir,
        farmLockFile: deps.farmLockFile,
        imagePackagesFile: deps.imagePackagesFile,
        refStorePath: deps.refStorePath,
        extendAnalysisFarm: deps.extendAnalysisFarm,
        toolOutputStore: deps.toolOutputStore,
        bioKeys: deps.bioKeys,
        step,
    };
}

export function registerDataProfileWorkflow(deps: DataProfileDeps): (input: DataProfileWorkflowInput) => Promise<void> {
    return DBOS.registerWorkflow((input: DataProfileWorkflowInput) => runDataProfileBody(input, deps), { name: "data-profile" });
}

/**
 * Body extracted so tests can drive it without registering a workflow.
 * Updates `cortex_analysis_state` status to 'completed' on success or
 * 'failed' on error, and revokes the run authorization on every terminal path.
 */
export async function runDataProfileBody(input: DataProfileWorkflowInput, deps: DataProfileDeps): Promise<void> {
    const logger = (deps.logger ?? createNoopLogger()).named("data-profile").with({ analysisId: input.analysisId });
    const { analysisId, runSession, stagedInputs } = input;
    const revoke = (reason: string): Promise<boolean> => deliverNotice(logger, "RunAuthorizer.revoke", deps.runAuthorizer.revoke(runSession, reason));

    // The profile's activity channel. The write to the stream is bound here, while every phase and
    // phrase lives in the emitter — the phrases are the observable contract of
    // this capability, and a body that composed its own strings is a body they can drift from.
    // The frame is the workflow's synthetic one: both values are constants shared by every analysis,
    // so they identify nothing and consumers are required not to key on them.
    const activity: ProfileActivityEmitter = createProfileActivityEmitter(
        (part) => DBOS.writeStream("events", part),
        { runId: DATA_PROFILE_RUN_LITERAL, stepId: DATA_PROFILE_STEP_LITERAL },
        logger,
        () => DBOS.now(),
    );

    try {
        // Record which workflow owns this profile before anything else, so a consumer that resolves
        // the id from the ledger can subscribe from the earliest possible moment. Guarded on a real
        // ambient id: this body is also driven directly (outside a workflow), where the synthetic
        // fallback used further down names no workflow at all and must never reach the ledger.
        const ownWorkflowId = DBOS.workflowID;
        if (ownWorkflowId !== undefined) {
            await DBOS.runStep(
                async () => {
                    // A refused CAS is a normal in-band outcome, not a failure: the row left
                    // `running` underneath us (cleared, or stale-expired and re-claimed), which is
                    // the ledger correctly moving on. There is nothing to repair, and the profile's
                    // own work is unaffected — only its observability is.
                    if (!unwrapOrThrow(await recordDataProfileWorkflowId(deps.pool, analysisId, ownWorkflowId))) {
                        logger.warn("workflow-id record skipped: ledger row not running (cleared or re-claimed concurrently)");
                    }
                },
                { name: "record-workflow-id" },
            );
        }

        // 1. Input files are already staged under data/inputs/ (see the data-profile-init spec); the
        // embedder populated the tree and handed us this manifest in the workflow
        // input. The body never downloads.
        if (stagedInputs.length === 0) {
            logger.warn("no input files staged");
            // One event per completed profile, this one included: the counters are how the
            // catalogue's fit is measured, and a completion that emitted none would make the
            // empty-manifest path invisible to the same monitoring that watches every other.
            logProfileMonitoring(logger, { dimensions: [], probes: [], repairRounds: 0, absorb: "none" });
            await settleTerminalWrite(
                logger,
                analysisId,
                unwrapOrThrow(await completeDataProfile(deps.pool, analysisId)),
                "completed",
                deps.notifyDataProfileSettled,
            );
            await revoke("data-profile-completed");
            // This is a terminal completion like any other, so it reports one — a consumer watching
            // an empty-manifest profile sees it settle rather than seeing the stream simply stop.
            await activity.complete();
            return;
        }

        // 2. Register staged files in cortex_artifacts
        unwrapOrThrow(
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
            ),
        );

        const executionId = generateExecutionId(DATA_PROFILE_AGENT_ID);
        const workflowId = DBOS.workflowID ?? `${DATA_PROFILE_RUN_LITERAL}:${executionId}`;
        // The profile waits in place, with its row `running`: the profile pauses, and it does not fail.
        const pause = workPause({
            pool: deps.pool,
            workId: workflowId,
            workKind: "profile",
            analysisId,
            emit: (part) => DBOS.writeStream("events", part),
            retryDelaysMs: deps.pauseRetryDelaysMs,
            run: { session: runSession, authorizer: deps.runAuthorizer },
            logger,
        });
        const childSession = forSubAgent(runSession, DATA_PROFILE_AGENT_ID);
        // A resolver rejection fails the workflow loudly (workspace-root-resolution
        // contract) — profiling an analysis whose root cannot be resolved is
        // meaningless, so no softer handling is warranted.
        const workspaceRoot = await deps.resolveWorkspaceRoot(analysisId);
        const profileWritePrefix = `${workspaceRoot}/runs/${DATA_PROFILE_RUN_LITERAL}/${DATA_PROFILE_STEP_LITERAL}`;

        // 3. The deterministic scan, before any container and before the agent's first turn.
        // It is always needed and its result does not depend on agent judgement, so spending
        // an agent turn to request it would be waste — and a briefing carrying one line per
        // input file consumes context that carries no structure. It runs BEFORE the sandbox
        // because the absorb below may complete the profile without ever needing one.
        await activity.scanning();
        const scan = await scanInputTree({ session: childSession, fs: deps.workspaceFs, root: STAGED_INPUT_ROOT });
        const detected = detectSets(scan.files);
        const menu = buildSetMenu(detected, { truncated: scan.manifest.truncated });
        logger.info("input scan complete", {
            files: detected.fileCount,
            kept: detected.keptFileCount,
            sets: detected.sets.length,
            listedSets: menu.sets.length,
            leftovers: detected.leftovers.memberCount,
            quarantined: detected.quarantine.count,
            truncated: scan.manifest.truncated,
        });

        // 3a. A tree the scan kept nothing of. There is no menu to author against and no file
        // to describe, so a sandbox and a model pass would produce an empty submission at the
        // cost of a container. The quarantine accounting is the whole finding, and it is a
        // real one: it names every file and why each was set aside.
        if (detected.keptFileCount === 0) {
            logger.warn("every scanned file was quarantined", { scanned: detected.fileCount, quarantined: detected.quarantine.count });
            const resolution = resolveProfileSubmission(emptySubmission(), detected, menu, { finalRound: true });
            const record = buildDataProfileResult(emptySubmission(), resolution, stagedInputs, new Date().toISOString());
            await activity.indexing();
            await indexProfile({ deps, analysisId, session: runSession, record, scan, logger });
            logProfileMonitoring(logger, { resolution, dimensions: [], probes: [], repairRounds: 0, absorb: "none" });
            await settleTerminalWrite(
                logger,
                analysisId,
                unwrapOrThrow(await completeDataProfile(deps.pool, analysisId, record)),
                "completed",
                deps.notifyDataProfileSettled,
            );
            await revoke("data-profile-completed");
            await activity.complete();
            return;
        }

        // 3b. Absorption — replay a prior profile's recipe against the fresh scan. A recipe
        // covering every kept file completes the profile here: an added directory of files
        // that instantiate templates the profile already describes is arithmetic, and paying
        // a container and a model pass for it is what this pre-step exists to remove.
        const prior = unwrapOrThrow(await loadDataProfileStatus(deps.pool, analysisId))?.result ?? null;
        const absorb = absorbRecipe(prior, detected, menu);
        if (absorb.kind === "stranded") {
            logger.warn("prior recipe stranded — re-profiling from scratch", { reason: absorb.reason });
        }
        if (absorb.kind === "full" && prior) {
            logger.info("absorbed the prior recipe", { groups: absorb.resolution.groups.length, keptFiles: absorb.resolution.partition.keptFiles });
            await activity.indexing();
            const absorbed = buildAbsorbedResult(prior, absorb.resolution, stagedInputs, new Date().toISOString());
            await indexProfile({ deps, analysisId, session: runSession, record: absorbed, scan, logger });
            logProfileMonitoring(logger, {
                resolution: absorb.resolution,
                dimensions: absorbed.dimensions ?? [],
                probes: absorbed.probes ?? [],
                repairRounds: 0,
                absorb: absorb.kind,
            });
            await settleTerminalWrite(
                logger,
                analysisId,
                unwrapOrThrow(await completeDataProfile(deps.pool, analysisId, absorbed)),
                "completed",
                deps.notifyDataProfileSettled,
            );
            await revoke("data-profile-completed");
            await activity.complete();
            return;
        }

        // 4. Run the data-profiler sandbox agent.
        logger.info("starting sandbox", { executionId });

        // Reported BEFORE the container exists, deliberately: provisioning is the longest single
        // operation in a profile and it precedes the agent entirely, so a body that reported only
        // from the agent loop would leave the longest wait of all unreported — the same defect the
        // run panel's activity readout was built to remove.
        await activity.sandboxInit();

        const resources = estimateDataProfileResources(stagedInputs);
        const spawn = async (): Promise<Result<SandboxRef, SuspendingRefusal>> =>
            keepSuspendingRefusal(
                await deps.sandboxClient.createSandbox(
                    forStep(runSession, DATA_PROFILE_STEP_LITERAL),
                    { childWorkflowId: workflowId, resources },
                    mintSandboxIdentity(DATA_PROFILE_RUN_LITERAL),
                ),
            );
        let spawned = await spawn();
        // A refusal of the label gate with the suspend flag waits in a pause, and the spawn runs again after the
        // resume. A body that runs outside a workflow cannot wait, thus the refusal fails the profile there.
        while (spawned.isErr()) {
            const waited = await pause.forCause({ kind: "host", reason: spawned.error.reason }, 0);
            if (waited === undefined) throw new SandboxFailure(spawned.error);
            spawned = await spawn();
        }
        const sandbox = spawned.value;

        try {
            // Checkpointed clock, not `Date.now()`: one deadline bounds every exec of the
            // profile, and a wall-clock deadline would grow on each recovery (see
            // sandbox-step.ts, which captures its step deadline the same way).
            const deadlineAbs = (await DBOS.now()) + DEFAULT_DEADLINE_MS;

            const headers = await readSetHeaders({
                session: childSession,
                deps,
                analysisId,
                detected,
                sandbox,
                deadlineMs: deadlineAbs,
                logger,
            });
            const briefingMenu: SetMenu = { ...menu, headers };

            // The profiler runs outside `executeAnalysis`, so no scheduler composes a
            // briefing for it — this prompt IS its briefing, and the sandbox system
            // prompt names no paths (it is static per agent type, for the prompt cache).
            // Its workspace frame and its resource budget therefore have to be stated here,
            // in the same words the step briefing uses.
            const prompt = composeProfilerSeed({
                analysisId,
                workingDir: toSandboxPath(workspaceRoot, analysisId, profileWritePrefix),
                resources,
                menu: briefingMenu,
                absorb,
            });

            const sandboxAgentDeps: SandboxAgentDeps = profilerSandboxAgentDeps(deps, {
                sandbox,
                workspaceRoot,
                analysisId,
                // The profiler writes Python scripts and intermediate artifacts under
                // the synthetic step path; the post-agent `rm -rf runs/data-profile/`
                // cleanup wipes them.
                allowedWritePrefix: profileWritePrefix,
                deadlineMs: () => deadlineAbs,
            });

            const submitProfileTool = createSubmitProfileTool(detected, briefingMenu);

            const baseAgent = createDataProfilerAgent(sandboxAgentDeps);
            const agentDef = { ...baseAgent, tools: [...baseAgent.tools, submitProfileTool] };
            // The profiler's own roster, `submit_profile` included, so every call it
            // makes is phrased by the tool that was called.
            const resolveDetail = createDetailResolver(agentDef.tools, logger);

            const signal = new AbortController().signal;

            // Covers the gap between a ready sandbox and the agent's first tool call, which would
            // otherwise still read as `Starting sandbox` long after the container was up. The run
            // path's `Running ${agentId}` serves the same purpose at the same point.
            await activity.agentStarting();

            const run = await runWithSalvage(
                agentDef,
                [{ role: "user", content: prompt }],
                childSession,
                {
                    provider: deps.provider,
                    signal,
                    // Every tool call the profiler makes becomes live activity. Only `tool-started`
                    // is forwarded: the loop's other events (iteration boundaries, model deltas,
                    // tool completions) describe machinery rather than work, and the panel this
                    // feeds carries a single line whose value is that it always names what is
                    // happening now. The events of a tool call arrive from inside its step.
                    emit: async (event) => {
                        if (event.type === "tool-started") await activity.forTool(event.toolUseId, event.name, event.input, resolveDetail);
                    },
                    invocationId: workflowId,
                    usageRecorder: deps.usageRecorder,
                    toolOutputStore: deps.toolOutputStore,
                    pause: pause.afterFailure,
                },
                {
                    tools: [SUBMIT_PROFILE_TOOL_ID],
                    nudge:
                        "You stopped without an accepted submit_profile, so no profile was " +
                        "recorded. Call submit_profile now with your operations on the menu, " +
                        "what each resulting group means, and the dimensions you saw with " +
                        "their observations — base it on the scan and the work you already did.",
                    hasOutcome: (steps) => profileSubmissions(steps).some((entry) => entry.accepted),
                },
            );

            const selected = selectedSubmission(run.steps);
            if (selected === undefined) {
                throw new Error("Data profiling failed: agent did not call submit_profile");
            }
            const { submission } = selected;
            // A submission that no call accepted resolves as final: nothing that follows can repair an
            // overlap, so a contested file sweeps rather than being awarded to whichever operation the
            // agent happened to write first. The resolution is pure, thus it gives the answer of the call.
            const resolution: ProfileResolution = resolveProfileSubmission(submission, detected, briefingMenu, { finalRound: !selected.accepted });

            // 5. Index into vector store — one entry per group, one per dimension, one per annotated member.
            //
            // Reported as `indexing`, not `persisting`: the contract defines `persisting` as step
            // bytes uploading to an artifact store, and a profile uploads nothing — its durable
            // products are this vector index and the ledger row.
            await activity.indexing();

            const profileRecord = buildDataProfileResult(submission, resolution, stagedInputs, new Date().toISOString());
            await indexProfile({ deps, analysisId, session: runSession, record: profileRecord, scan, logger });
            logProfileMonitoring(logger, {
                resolution,
                dimensions: resolution.dimensions,
                probes: resolution.probes,
                repairRounds: selected.count - 1,
                absorb: absorb.kind,
            });

            // 6. Complete — store the FULL profiler finding plus the input signature for
            // staleness detection. The scratch tree is gone; this row is all that survives.
            await settleTerminalWrite(
                logger,
                analysisId,
                unwrapOrThrow(await completeDataProfile(deps.pool, analysisId, profileRecord)),
                "completed",
                deps.notifyDataProfileSettled,
            );
            await revoke("data-profile-completed");
            // LAST statement of the success path, and that placement is the guarantee that exactly
            // one terminal activity is ever emitted. Everything that could still throw — the ledger
            // write above, the revoke — is already behind us, so any failure on the way here reaches
            // the catch having emitted no terminal at all and reports `failed` alone. Emitted any
            // earlier, a failing write would produce BOTH terminals and leave the fold's winner
            // decided by arrival order. The sandbox teardown below emits nothing for the same reason.
            await activity.complete();
        } finally {
            try {
                await deps.sandboxClient.teardown(sandbox);
            } catch (teardownErr) {
                logger.warn("teardown failed (non-fatal)", { executionId, ...logger.errorFields(teardownErr) });
            }
        }
    } catch (err) {
        if (isWorkflowCancellation(err)) {
            // `stopDataProfile` writes the row, but only the body holds the run session.
            await revoke("data-profile-stopped");
            throw err;
        }
        // A failure with a cause of a pause waited in the loop, thus this one fails the profile.
        logger.error("profile failed", logger.errorFields(err));
        const reason = profileFailureReason(err);
        await settleTerminalWrite(
            logger,
            analysisId,
            unwrapOrThrow(await failDataProfile(deps.pool, analysisId, reason)),
            "failed",
            deps.notifyDataProfileSettled,
        );
        await revoke("data-profile-failed");
        // The same bounded, user-safe line the ledger receives — never the raw error, whose paths and
        // stack frames stay in the log record above. This is the only other terminal emission, so
        // reaching it means the success path did not emit one.
        await activity.failed(reason);
    }
}

/**
 * Log a terminal ledger write the running-CAS refused: the row was cleared
 * (emptied inputs) or expired (stale-timeout) out from under a live workflow, so
 * there is no `running` row to stamp. Not an error — the ledger correctly moved
 * on; the workflow still revokes its own authorization on the same terminal path.
 */
function logTerminalNoop(logger: Logger, analysisId: string, write: string): void {
    logger.warn("terminal write skipped: ledger row not running (cleared or expired concurrently)", { analysisId, write });
}

/**
 * Settle one terminal write of the profile ledger. A refused stamp is logged
 * (see `logTerminalNoop`) and sends no notice. An accepted stamp records the
 * profile's run outcome and then delivers the settle notice when the deps bind
 * one: the CAS admits one write per `running` claim, so this is the exactly-once
 * point of the transition — a recovery replay of the body finds the row no
 * longer `running`, and does neither again. The duration runs from the
 * `data_profile_started_at` the claim stamped, never from a body-local clock.
 * A crash between the stamp and the notice loses that one notice.
 */
async function settleTerminalWrite(
    logger: Logger,
    analysisId: string,
    write: DataProfileTerminalWrite,
    status: "completed" | "failed",
    notify: NotifyDataProfileSettled | undefined,
): Promise<void> {
    if (!write.stamped) {
        logTerminalNoop(logger, analysisId, status === "completed" ? "completion" : "failure");
        return;
    }
    recordRunCompleted({ workflow: "data_profile", status, durationMs: elapsedSinceIso(write.startedAt) });
    if (notify === undefined) return;
    await deliverNotice(logger, "notifyDataProfileSettled", notify({ analysisId, status, completedAt: write.completedAt }));
}

/**
 * What the trigger did:
 * - `"started"`: a first profile claimed the row and a workflow runs.
 * - `"restarted"`: a re-profile claimed a `completed` row and a workflow runs.
 * - `"already_running"`: a workflow already owns the row, and nothing new ran.
 * - `"completed"`: the analysis has no input files, so the row is `completed` at once
 *   with no result. No workflow ran (see {@link completeEmptyDataProfile}).
 * - `"failed"`: the trigger refused the call, and the row is unchanged.
 */
export type DataProfileTriggerResult = "started" | "restarted" | "already_running" | "completed" | "failed";

/**
 * Why the dispatch of a claimed profile started no workflow. The dispatch writes `failed` to the claimed
 * row before a caller reads the `err`:
 * - `refused`: `RunAuthorizer.authorize` gave an `err`. `reason` and `suspend` are the values of the host.
 * - `start_failed`: DBOS did not start the workflow. `cause` is the throw of DBOS.
 */
export type DataProfileStartError =
    { readonly type: "refused"; readonly reason: string; readonly suspend: boolean } | { readonly type: "start_failed"; readonly cause: unknown };

/** A one-line, user-facing description of a `DataProfileStartError`. */
export function describeDataProfileStartError(e: DataProfileStartError): string {
    switch (e.type) {
        case "refused":
            return `the profile run was not authorized: ${e.reason}`;
        case "start_failed":
            return `the profile workflow did not start: ${profileFailureReason(e.cause)}`;
    }
}

/**
 * Route-side deps for triggering the data-profile workflow: the ledger pool,
 * the run authorizer, and the registered workflow callable. The body's
 * construction-time deps are closed over at registration
 * (`registerDataProfileWorkflow`); the route never holds them.
 */
export type DataProfileTriggerDeps = {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    readonly pool: Querier;
    readonly runAuthorizer: RunAuthorizer;
    /**
     * Starts the profile workflow. A tool call of a chat turn runs in a step, and DBOS refuses a workflow start
     * inside a step, thus the start goes through the launcher, which enqueues there.
     */
    readonly runLauncher: RunLauncher;
    readonly workflow: (input: DataProfileWorkflowInput) => Promise<void>;
};

/**
 * Identity + staged inputs for a profile run. The caller (the managed route /
 * the CLI) stages `data/inputs/` BEFORE triggering (see the data-profile-init spec) and passes the
 * resulting manifest here; this trigger never stages — it forwards the manifest
 * into the workflow input.
 */
export type DataProfileTriggerParams = {
    readonly auth: AuthContext;
    readonly analysisId: string;
    readonly stagedInputs: readonly StagedInput[];
};

/**
 * Resolve the `RunSession` the workflow runs under. Whether the authorization
 * is freshly minted or reused is decided by the `RunAuthorizer` seam from the
 * opaque auth; this passes that auth straight through and never inspects it.
 */
export function authorizeDataProfile(deps: DataProfileTriggerDeps, params: DataProfileTriggerParams): ResultAsync<RunSession, GateRefusal> {
    const { auth, analysisId } = params;
    return passGate(
        "RunAuthorizer.authorize",
        deps.runAuthorizer.authorize({
            auth,
            scope: { kind: "analysis", analysisId },
            provenance: { agentId: DATA_PROFILE_AGENT_ID, callPath: [DATA_PROFILE_AGENT_ID] },
            frame: { runId: DATA_PROFILE_RUN_LITERAL, stepId: DATA_PROFILE_STEP_LITERAL },
        }),
    );
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
 * Start the data-profile workflow under the authorization and a per-attempt id
 * `dataprofile:{analysisId}:{nonce}` — concurrent triggers are already
 * serialized by the ledger CAS. The caller has already staged the inputs and
 * supplied the manifest in `params.stagedInputs`; this forwards it into the
 * workflow input. The handle result is not awaited.
 */
async function startDataProfileWorkflow(deps: DataProfileTriggerDeps, params: DataProfileTriggerParams, runSession: RunSession): Promise<void> {
    const attemptNonce = randomUUID();
    await deps.runLauncher.launch(
        deps.workflow,
        { workflowId: dataProfileWorkflowId(params.analysisId, attemptNonce) },
        {
            analysisId: params.analysisId,
            runSession,
            stagedInputs: params.stagedInputs,
        },
    );
}

/**
 * Authorize and start a claimed profile. The claim already flipped the row to
 * `running`, thus a refused authorization and a failed start each settle the
 * row as `failed` before the `err`, and the row never wedges at `running`. A
 * rejected `authorize` promise is a defect of the host: the row is settled the
 * same way, and the rejection passes through.
 */
async function dispatchClaimedProfile(
    deps: DataProfileTriggerDeps,
    params: DataProfileTriggerParams,
    phase: string,
): Promise<Result<void, DataProfileStartError>> {
    const authorized = await Promise.resolve(authorizeDataProfile(deps, params)).catch(async (defect: unknown) => {
        await compensateStartFailure(deps, params.analysisId, phase, defect);
        throw defect;
    });
    if (authorized.isErr()) {
        await refuseClaimedProfile(deps, params.analysisId, phase, authorized.error);
        return err({ type: "refused", reason: authorized.error.reason, suspend: authorized.error.kind === "suspended" });
    }
    const started = await ResultAsync.fromPromise(startDataProfileWorkflow(deps, params, authorized.value), (cause) => cause);
    if (started.isErr()) {
        await compensateStartFailure(deps, params.analysisId, phase, started.error);
        return err({ type: "start_failed", cause: started.error });
    }
    return ok(undefined);
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
 * An analysis with no input files takes none of the claims. An empty manifest against
 * a seed that names no file stamps the row `completed` at once, with no result and no
 * workflow (see {@link completeEmptyDataProfile}), and the trigger returns
 * `"completed"`. An empty manifest against a seed that names files is a divergence
 * between the caller and the ledger, and the trigger refuses it.
 *
 * Returns what happened, so the caller can surface it (e.g. in the seed response). A
 * failed ledger read or claim is the `err`. The dispatch settles its own row, thus a
 * refusal or a failed start after a claim shows on the ledger only.
 */
export function triggerDataProfile(deps: DataProfileTriggerDeps, params: DataProfileTriggerParams): ResultAsync<DataProfileTriggerResult, DbError> {
    return new ResultAsync(claimAndDispatchProfile(deps, params));
}

async function claimAndDispatchProfile(deps: DataProfileTriggerDeps, params: DataProfileTriggerParams): Promise<Result<DataProfileTriggerResult, DbError>> {
    const logger = (deps.logger ?? createNoopLogger()).named("data-profile").with({ analysisId: params.analysisId });
    const { analysisId } = params;
    // ADVISORY pre-check, not the enforcement — the claim CAS carries the same seed
    // conjunct (see `SEEDED` in state/data-profile.ts) and is what actually makes a
    // seedless `running` row impossible. This read exists only to name the cause: on
    // the ordinary non-racing path it turns an opaque "no claim matched" into a
    // precise reason. An empty array is not a seed — it names zero files. Reads via
    // `loadSeedInputFileIds`, which returns null for BOTH a missing analysis row and
    // a NULL-seed row (`loadDataProfileStatus` would hide the seed of a cleared row).
    const seedRead = await loadSeedInputFileIds(deps.pool, analysisId);
    if (seedRead.isErr()) return err(seedRead.error);
    const seeded = seedRead.value;

    if (params.stagedInputs.length === 0) {
        // The trigger validates the manifest it is about to dispatch against the ledger
        // seed. A seeded row profiled against an EMPTY manifest would claim `running` and
        // then hit the body's empty-manifest path, and complete with a NULL result while
        // the seed still names files. Refuse the divergence before any claim.
        if (seeded !== null && seeded.length > 0) {
            logger.error("trigger rejected: empty manifest dispatched against a non-empty seed", { seededCount: seeded.length });
            return ok("failed");
        }

        // The analysis has no input files, so there is nothing to profile. The row is
        // `completed` at once, with no workflow. The CAS carries the same seed
        // predicate as this pre-read, so a seed upsert that lands in between cannot be
        // hidden behind a finished profile: the stamp refuses, and the status read
        // below names the cause.
        const completed = await completeEmptyDataProfile(deps.pool, analysisId);
        if (completed.isErr()) return err(completed.error);
        if (completed.value) return ok("completed");
        const current = await loadDataProfileStatus(deps.pool, analysisId);
        if (current.isErr()) return err(current.error);
        if (current.value?.status === "running") return ok("already_running");
        logger.error("trigger rejected: empty-set completion refused (no analysis row, or the seed now names files)");
        return ok("failed");
    }

    // A non-empty manifest against a seed that names no file: the caller skipped the
    // seed, or the analysis row is missing. Name the cause before any claim.
    if (seeded === null || seeded.length === 0) {
        logger.error("trigger rejected: no seeded input set (missing analysis row or caller skipped seeding)");
        return ok("failed");
    }

    const started = await tryStartDataProfile(deps.pool, analysisId);
    if (started.isErr()) return err(started.error);
    if (started.value) {
        dispatchInBackground(deps, params, "Run");
        return ok("started");
    }
    const restarted = await tryRerunDataProfile(deps.pool, analysisId);
    if (restarted.isErr()) return err(restarted.error);
    if (restarted.value) {
        dispatchInBackground(deps, params, "Re-run");
        return ok("restarted");
    }
    const status = await loadDataProfileStatus(deps.pool, analysisId);
    if (status.isErr()) return err(status.error);
    return ok(status.value?.status === "running" ? "already_running" : "failed");
}

/** The dispatch settles the row on each arm and logs a defect, thus the trigger keeps no outcome of it. */
function dispatchInBackground(deps: DataProfileTriggerDeps, params: DataProfileTriggerParams, phase: string): void {
    void dispatchClaimedProfile(deps, params, phase).catch(() => undefined);
}

/**
 * Compensate a start that failed after the claim. The ledger CAS in
 * `tryStart`/`tryRerun`/`tryRetry` already flipped the row to `running`; if the
 * dispatch never landed a workflow, DBOS has nothing to recover, so without
 * this the row would sit at `running` forever and every later trigger would
 * report `already_running`. Failing the ledger lets the retry path recover.
 * Best-effort — a compensation write that itself fails is only logged, since
 * there is no further channel to report it on.
 */
async function compensateStartFailure(deps: DataProfileTriggerDeps, analysisId: string, phase: string, cause: unknown): Promise<void> {
    const logger = (deps.logger ?? createNoopLogger()).named("data-profile").with({ analysisId });
    logger.error("start failed", { phase, ...logger.errorFields(cause) });
    await failClaimedProfile(deps, analysisId, phase, profileFailureReason(cause));
}

async function refuseClaimedProfile(deps: DataProfileTriggerDeps, analysisId: string, phase: string, refusal: GateRefusal): Promise<void> {
    const logger = (deps.logger ?? createNoopLogger()).named("data-profile").with({ analysisId });
    logger.error("the profile was not authorized", { phase, reason: refusal.reason, suspend: refusal.kind === "suspended" });
    // No work exists yet, thus a refusal with the suspend flag fails the row the same as each other refusal.
    await failClaimedProfile(deps, analysisId, phase, refusal.reason);
}

async function failClaimedProfile(deps: DataProfileTriggerDeps, analysisId: string, phase: string, reason: string): Promise<void> {
    const logger = (deps.logger ?? createNoopLogger()).named("data-profile").with({ analysisId });
    const failed = await failDataProfile(deps.pool, analysisId, reason);
    if (failed.isErr()) {
        logger.error("failed to mark failed after a start error", { phase, err: failed.error });
    } else if (!failed.value.stamped) {
        // The row this compensation was written to fail is no longer `running` — a
        // concurrent clear/expire already moved it on, so the running-CAS refused the
        // stamp. Nothing wedged at `running`, which is the outcome compensation exists
        // to guarantee; just record the no-op.
        logTerminalNoop(logger, analysisId, "compensation");
    } else {
        // A profile that failed at start is a failed profile: its claim opened a run the ledger now closes.
        recordRunCompleted({ workflow: "data_profile", status: "failed", durationMs: elapsedSinceIso(failed.value.startedAt) });
    }
}

/**
 * Start the data-profile workflow for an already-claimed analysis (the retry
 * route claims via `tryRetryDataProfile`, then calls this). The caller does not
 * wait for the completion of the workflow. A refused authorization and a failed
 * start each settle the row as `failed` before the `err` (see
 * {@link dispatchClaimedProfile}), thus a caller that minted an authorization
 * can revoke it.
 */
export function runDataProfile(deps: DataProfileTriggerDeps, params: DataProfileTriggerParams): ResultAsync<void, DataProfileStartError> {
    return new ResultAsync(dispatchClaimedProfile(deps, params, "Retry"));
}

/** The ledger error of a profile that a stop ended. A client shows it, and a retry can follow it. */
export const DATA_PROFILE_STOPPED = "Data profiling was stopped";

/** What the stop of a data profile reaches: the ledger pool, and the notice of a settled profile. */
export type DataProfileStopDeps = {
    readonly pool: Querier;
    readonly logger?: Logger;
    readonly notifyDataProfileSettled?: NotifyDataProfileSettled;
};

/**
 * Stop the profile workflow of an analysis, and fail its row. The body passes a cancel through its failure path,
 * thus the row, the rows of its pauses, and the settled notice converge here. The revoke of the mandate and the
 * teardown of the sandbox stay in the body, which runs them on its way out. The `running` guard of the row write keeps a profile that settled first.
 */
export async function stopDataProfile(deps: DataProfileStopDeps, analysisId: string, workflowId: string): Promise<void> {
    const logger = (deps.logger ?? createNoopLogger()).named("data-profile").with({ analysisId });
    await DBOS.cancelWorkflow(workflowId);
    const cleared = await clearPausesOfWork(deps.pool, workflowId);
    if (cleared.isErr()) logger.warn("the pauses of a stopped profile did not clear", { op: cleared.error.op });
    const failed = await failDataProfile(deps.pool, analysisId, DATA_PROFILE_STOPPED);
    if (failed.isErr()) {
        logger.error("the row of a stopped profile did not fail", { op: failed.error.op });
        return;
    }
    await settleTerminalWrite(logger, analysisId, failed.value, "failed", deps.notifyDataProfileSettled);
}

/**
 * Concise, UI-safe failure reason. `data_profile_error` is surfaced verbatim
 * to the frontend, so raw errors — K8s API response bodies, multi-line stack
 * traces — must never reach it. The full error is preserved in the logs; this
 * collapses to a single bounded line for display.
 */
const PROFILE_ERROR_MAX_LEN = 200;
function profileFailureReason(err: unknown): string {
    const raw = errorMessageOf(err) ?? textOf(err);
    const firstLine = collapseWhitespace(presentFirst(raw.split("\n", 1), "the first line of the error"));
    return firstLine.length > PROFILE_ERROR_MAX_LEN ? firstLine.slice(0, PROFILE_ERROR_MAX_LEN - 1) + "…" : firstLine || "Data profiling failed";
}
