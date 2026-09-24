/**
 * The harness's post-step pipeline — the per-step bookkeeping that runs after a sandbox
 * agent loop finishes: describe the output files, write an interpretive
 * summary, reconcile + register the artifact manifest, and index the
 * descriptions into the per-analysis vector store. The description and the
 * summary are continuations of the conversation of the step agent.
 *
 * These leaf bodies are host-neutral: the only place an embedder differs is the
 * injected `ArtifactRegistry` (filesystem vs. external provenance) and the
 * write-side `EmbeddingProvider` (billing). The sandbox-step workflow body owns
 * the orchestration — which stage is `DBOS.runStep`-wrapped, which stage is
 * fail-fast vs. best-effort. This module owns only the stage bodies.
 */

import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import type { Pool } from "pg";

import type { LoopMessage } from "../loop/types.js";
import type { AgentChat, EmbeddingProvider } from "../providers/types.js";
import type { ResolveWorkspaceRoot } from "../workspace/paths.js";
import type { ArtifactManifestEntry } from "../schemas/artifact-manifest.js";
import type { StepSummary } from "../schemas/step-summary.js";
import { unwrapOrThrow } from "../lib/result.js";
import { createNoopLogger } from "../lib/console-logger.js";
import { describeDbError } from "../lib/db-result.js";
import type { Logger } from "../lib/logger.js";
import type { UsageRecorder } from "../billing/usage-recorder.js";
import { writeFileWithinRoot } from "../lib/fs-helpers.js";

import type { ArtifactRegistry } from "./artifact-registry.js";
import { registerStepArtifacts, type ArtifactRegistrationFailure } from "./artifact-registration.js";
import { reconcileManifestWithDisk } from "./reconcile-manifest.js";
import { generateFileMetadata as coreGenerateFileMetadata, type ArtifactForMetadata, type FileMetadataEntry } from "./artifact-metadata.js";
import { generateStepSummary as coreGenerateStepSummary } from "./step-summary.js";
import { createVectorStore } from "../state/vector-store.js";
import { ensureSearchIndex, searchIndexName } from "../workspace/search-config.js";
import type { PostStepArtifacts, PostStepContext, StepFileEntry, StepOutputs } from "../workflows/sandbox-step.js";

/**
 * The subset of `SandboxStepDeps` the post-step stages consume. The sandbox-step
 * body passes its own `deps` straight through (it is a structural superset).
 */
export interface PostStepPipelineDeps {
    readonly pool: Pool;
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    /** LLM usage-accounting seam for the metadata + summary continuations; omitted falls back to the no-op recorder. */
    readonly usageRecorder?: UsageRecorder;
    /** Non-streaming chat — the provider of the task, which the metadata + summary continuations extend. */
    readonly provider: AgentChat;
    /** Write-side embedder for the vector index. */
    readonly embedding: EmbeddingProvider;
    readonly artifactRegistry: ArtifactRegistry;
    /** Workspace-root resolution seam (see workspace/paths.ts). */
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
}

/** The product of the file-metadata stage, as its `DBOS.runStep` checkpoints it. */
export interface StepFileMetadata {
    /** One entry per manifest file, described or fallback. */
    readonly entries: readonly FileMetadataEntry[];
    /**
     * The messages of the file-metadata exchange: the request, then each message
     * after it. Empty when no continuation ran. The summary continues the
     * conversation after them, thus a replay gives the summary the same prefix.
     */
    readonly messages: readonly LoopMessage[];
}

/**
 * Describe each manifest file through a continuation of the conversation of the
 * step agent. Returns one entry per file — a file the model fails to describe
 * gets a deterministic fallback, never a dropped entry — and the messages of
 * the exchange.
 */
export async function generateStepFileMetadata(
    deps: PostStepPipelineDeps,
    postCtx: PostStepContext,
    manifest: readonly ArtifactManifestEntry[],
): Promise<StepFileMetadata> {
    const { input, session, transcript, agent, fileMetadata } = postCtx;
    if (manifest.length === 0) return { entries: [], messages: [] };

    const dbPathPrefix = `runs/${input.runId}/${input.stepId}/`;
    const artifactsForMeta: ArtifactForMetadata[] = manifest.map((a) => ({
        dbPath: `${dbPathPrefix}${a.path}`,
        displayPath: a.path,
        sizeBytes: a.size,
    }));
    const result = await coreGenerateFileMetadata({
        logger: deps.logger,
        provider: deps.provider,
        usageRecorder: deps.usageRecorder,
        session,
        agent,
        cell: fileMetadata,
        transcript,
        artifacts: artifactsForMeta,
        resourceId: input.analysisId,
        extraMetadata: {
            role: "step_output",
            producerStep: input.stepId,
            producerRun: input.runId,
            producerAgent: input.agentId,
        },
    });
    return { entries: result.entries, messages: result.messages };
}

/**
 * Generate the interpretive step summary and persist it to
 * `output/summary.md`. The summary continues the conversation of the step
 * agent after `metadataMessages`, the messages of the file-metadata exchange.
 * A write failure is non-fatal (logged) — the summary is still returned for
 * vector indexing.
 */
export async function generateStepSummaryAndWrite(
    deps: PostStepPipelineDeps,
    postCtx: PostStepContext,
    manifest: readonly ArtifactManifestEntry[],
    metadataMessages: readonly LoopMessage[],
): Promise<StepSummary | undefined> {
    const { input, session, transcript, agent, writePrefix } = postCtx;

    const summary = await coreGenerateStepSummary({
        logger: deps.logger,
        provider: deps.provider,
        usageRecorder: deps.usageRecorder,
        session,
        agent,
        conversation: [...transcript, ...metadataMessages],
        artifactPaths: manifest.map((a) => a.path),
        stepId: input.stepId,
        agentId: input.agentId,
        runId: input.runId,
    });
    if (summary && summary.markdown.trim().length > 0) {
        try {
            // Host-side write into the step's own RW subtree. Confine to the step
            // prefix (not the whole workspace) so a symlink a compromised agent
            // planted cannot redirect it onto a host file — and so this write can
            // never reach the hard-linked `data/` inputs, which are RO by design.
            await writeFileWithinRoot(writePrefix, join(writePrefix, "output", "summary.md"), summary.markdown);
        } catch (err) {
            const logger = (deps.logger ?? createNoopLogger()).named("post-step").named("summary");
            logger.warn("writeFile output/summary.md failed", {
                runId: input.runId,
                stepId: input.stepId,
                ...logger.errorFields(err),
            });
        }
    }
    return summary;
}

export type StepRegistrationFailure = ArtifactRegistrationFailure | { readonly kind: "rejected"; readonly message: string };

export function describeStepRegistrationFailure(failure: StepRegistrationFailure): string {
    switch (failure.kind) {
        case "refused":
            return `the artifact registry refused the registration: ${failure.refusal.reason}`;
        case "ledger_failed":
            return `the artifact ledger write failed: ${describeDbError(failure.error)}`;
        case "rejected":
            return failure.message;
    }
}

/**
 * Reconcile the manifest against disk (drop phantoms, rehash) and register the
 * survivors with the local ledger + the injected `ArtifactRegistry`. Fail-fast
 * (see the artifact-manifest spec): `externalFailed` counts only the terminal
 * rejections — a rejected output whose bytes exist nowhere but the step tree,
 * plus anything rejected as a consequence of one — so a non-zero count means
 * real outputs went unregistered, and the `err` carries the per-file detail (the
 * OSS filesystem registry returns `externalFailed: 0`, so it never trips). A
 * refusal of the `register` gate and a failed ledger write are the other `err`s.
 * Returns the reconciled manifest.
 */
export async function reconcileAndRegisterStepArtifacts(
    deps: PostStepPipelineDeps,
    postCtx: PostStepContext,
    manifest: readonly ArtifactManifestEntry[],
): Promise<Result<readonly ArtifactManifestEntry[], StepRegistrationFailure>> {
    const { input, session, lineageCollector } = postCtx;

    const reconciled = await reconcileManifestWithDisk({
        workspaceRoot: deps.resolveWorkspaceRoot(input.analysisId),
        resourceId: input.analysisId,
        runId: input.runId,
        stepId: input.stepId,
        agentId: input.agentId,
        manifest: [...manifest],
        collector: lineageCollector,
        ...(deps.logger ? { logger: deps.logger } : {}),
    });

    if (reconciled.manifest.length === 0) return ok(reconciled.manifest);

    const registered = await registerStepArtifacts(
        deps.pool,
        deps.artifactRegistry,
        {
            resourceId: input.analysisId,
            runId: input.runId,
            stepId: input.stepId,
            artifacts: reconciled.manifest,
            collector: lineageCollector,
        },
        session,
        deps.logger,
    );
    if (registered.isErr()) return err(registered.error);
    const reg = registered.value;
    if (reg.externalFailed > 0) {
        // The registry commits per leaf and per activity, so accepted and rejected
        // rows arriving together is ordinary and `externalRegistered` is what
        // genuinely landed. Zero of it means this batch registered nothing at all:
        // no row carries an `artifact_id`, so the byte-sync that follows selects
        // none of them and every output stays local-only. That reads as a payload-
        // or credential-shaped rejection rather than a per-file one, so it rides on
        // the message and as its own field.
        const noneRegistered = reg.externalRegistered === 0;
        const detail = reg.failureDetails.map((f) => `${f.path}: ${f.error}`).join("\n  ");
        const msg =
            `[post-step.reconcile] external registration failed for ${input.stepId}: ` +
            `${reg.externalFailed} terminal rejection(s), ${reg.externalRegistered}/${reg.localCount} local artifact(s) registered` +
            (noneRegistered ? " (nothing in this batch registered)" : "") +
            (detail ? `\n  ${detail}` : "");
        // Logged as fields as well as returned: the failure reaches `failStep` as one
        // opaque string, so the per-path rejections are only queryable from here.
        // This is what distinguishes a registry rejection from the attestation
        // throws in `reconcileManifestWithDisk` when a step dies.
        (deps.logger ?? createNoopLogger()).named("post-step").named("reconcile").error("external registration failed", {
            runId: input.runId,
            stepId: input.stepId,
            externalFailed: reg.externalFailed,
            externalRegistered: reg.externalRegistered,
            localCount: reg.localCount,
            noneRegistered,
            failures: reg.failureDetails,
        });
        return err({ kind: "rejected", message: msg });
    }

    return ok(reconciled.manifest);
}

/**
 * Vector-index the threaded file descriptions + the step summary into the
 * per-analysis pgvector store. Best-effort (see the artifact-manifest spec):
 * indexing degrades without failing the step.
 *
 * Degradation is per-item. Index setup (ensuring the index exists and building
 * the store) is all-or-nothing — a setup failure logs and skips the stage,
 * because without an index there is nowhere to index into. Past setup, each
 * file description and the summary is embedded and upserted under its own
 * failure boundary, so one rejected input (e.g. an over-length document the
 * embedding backend rejects) costs only its own entry and every other item is
 * still attempted. A partial index is invisible at the search surface — it
 * returns fewer hits, never an error — so each per-item failure logs the item
 * id and input text length, and when any item fails a final record carries the
 * indexed/failed counts as the only signal that degradation occurred.
 */
export async function vectorIndexStepOutputs(deps: PostStepPipelineDeps, postCtx: PostStepContext, artifacts: PostStepArtifacts): Promise<void> {
    const { input } = postCtx;
    const { metadataEntries, summary, reconciledManifest } = artifacts;
    const logger = (deps.logger ?? createNoopLogger()).named("post-step").named("vector-index").with({ runId: input.runId, stepId: input.stepId });

    let vectorStore: ReturnType<typeof createVectorStore>;
    let indexName: string;
    try {
        // Setup is all-or-nothing: without an index there is nothing to index into.
        await ensureSearchIndex(deps.pool, input.analysisId, deps.embedding.dimensions);
        vectorStore = createVectorStore(deps.pool);
        indexName = searchIndexName(input.analysisId);
    } catch (err) {
        logger.warn("indexing failed", logger.errorFields(err));
        return;
    }

    const embedOne = async (text: string): Promise<number[]> => {
        const [vec] = unwrapOrThrow(await deps.embedding.embed([text], postCtx.session));
        if (!vec) throw new Error("vectorIndexStepOutputs: empty embedding response");
        return vec;
    };

    /** Index one item, absorbing its failure so the rest of the step still lands. */
    const indexOne = async (id: string, text: string, metadata: Record<string, unknown>): Promise<boolean> => {
        try {
            const embedding = await embedOne(text);
            unwrapOrThrow(await vectorStore.upsert({ indexName, vectors: [embedding], metadata: [metadata], ids: [id] }));
            return true;
        } catch (err) {
            // Text length rides as a field because over-length input is the known
            // failure driver, and the description/summary itself stays out of logs.
            logger.warn("indexing failed", { id, textLength: text.length, ...logger.errorFields(err) });
            return false;
        }
    };

    const dbPathPrefix = `runs/${input.runId}/${input.stepId}/`;
    const survivingPaths = new Set(reconciledManifest.map((a) => a.path));
    const liveMetadata = metadataEntries.filter((e) => survivingPaths.has(e.dbPath.slice(dbPathPrefix.length)));

    let indexed = 0;
    let failed = 0;
    for (const entry of liveMetadata) {
        const ok = await indexOne(`/${input.analysisId}/${entry.dbPath}`, entry.description, {
            text: entry.description,
            type: "output",
            ...entry.metadata,
            path: entry.dbPath,
        });
        if (ok) indexed++;
        else failed++;
    }

    if (summary && summary.markdown.trim().length > 0) {
        const relPath = `runs/${input.runId}/${input.stepId}/output/summary.md`;
        const ok = await indexOne(`/${input.analysisId}/${relPath}`, summary.markdown, {
            text: summary.markdown,
            type: "summary",
            stepId: input.stepId,
            runId: input.runId,
            agentId: input.agentId,
            path: relPath,
        });
        if (ok) indexed++;
        else failed++;
    }

    // A partial index is invisible at the search surface — it returns fewer hits,
    // never an error — so the count of what did not land is the only signal.
    if (failed > 0) logger.warn("indexed with failures", { indexed, failed });
}

/**
 * Assemble the step-detail payload (file tree, summary markdown, output file
 * descriptions) from the threaded post-step products. Pure — returns
 * `undefined` when nothing was produced.
 */
export function collectStepOutputs(postCtx: PostStepContext, artifacts: PostStepArtifacts): StepOutputs | undefined {
    const { input } = postCtx;
    const { metadataEntries, summary, reconciledManifest } = artifacts;

    const dbPathPrefix = `runs/${input.runId}/${input.stepId}/`;
    const descByPath = new Map<string, string>();
    for (const e of metadataEntries) {
        const rel = e.dbPath.startsWith(dbPathPrefix) ? e.dbPath.slice(dbPathPrefix.length) : e.dbPath;
        descByPath.set(rel, e.description);
    }

    const files: StepFileEntry[] = reconciledManifest.map((a) => ({
        path: a.path,
        size: a.size,
        fileType: a.type,
        description: descByPath.get(a.path) ?? "",
    }));

    const summaryMarkdown = summary?.markdown ?? "";
    if (files.length === 0 && summaryMarkdown.trim().length === 0) {
        return undefined;
    }
    return { files, summaryMarkdown };
}
