/**
 * The harness's post-step pipeline — the per-step bookkeeping that runs after a sandbox
 * agent loop finishes: describe the output files, write an interpretive
 * summary, reconcile + register the artifact manifest, and index the
 * descriptions into the per-analysis vector store.
 *
 * These leaf bodies are host-neutral: the only place an embedder differs is the
 * injected `ArtifactRegistry` (filesystem vs. external provenance) and the
 * write-side `EmbeddingProvider` (billing). The sandbox-step workflow body owns
 * the orchestration — which stage is `DBOS.runStep`-wrapped, which stage is
 * fail-fast vs. best-effort. This module owns only the stage bodies.
 */

import { join } from "node:path";
import type { Pool } from "pg";

import type { AgentChat, EmbeddingProvider } from "../providers/types.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import type { ResolveWorkspaceRoot } from "../workspace/paths.js";
import type { ArtifactManifestEntry } from "../schemas/artifact-manifest.js";
import type { StepSummary } from "../schemas/step-summary.js";
import { unwrapOrThrow } from "../lib/result.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { writeFileWithinRoot } from "../lib/fs-helpers.js";

import type { ArtifactRegistry } from "./artifact-registry.js";
import { registerStepArtifacts } from "./artifact-registration.js";
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
    /** Non-streaming chat — the metadata + summary sub-agent loops. */
    readonly provider: AgentChat;
    /** Write-side embedder for the vector index. */
    readonly embedding: EmbeddingProvider;
    readonly workspaceFs: WorkspaceFilesystem;
    readonly artifactRegistry: ArtifactRegistry;
    /** Workspace-root resolution seam (see workspace/paths.ts). */
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    /** Sandbox model id — provenance label for metadata + summary. */
    readonly model: string;
}

/**
 * Describe each manifest file. Returns one entry per file — a file the model
 * fails to describe gets a deterministic fallback, never a dropped entry.
 */
export async function generateStepFileMetadata(
    deps: PostStepPipelineDeps,
    postCtx: PostStepContext,
    manifest: readonly ArtifactManifestEntry[],
): Promise<readonly FileMetadataEntry[]> {
    const { input, session, transcript, writePrefix } = postCtx;
    if (manifest.length === 0) return [];

    const dbPathPrefix = `runs/${input.runId}/${input.stepId}/`;
    const artifactsForMeta: ArtifactForMetadata[] = manifest.map((a) => ({
        dbPath: `${dbPathPrefix}${a.path}`,
        displayPath: a.path,
        sizeBytes: a.size,
    }));
    const result = await coreGenerateFileMetadata({
        provider: deps.provider,
        session,
        artifacts: artifactsForMeta,
        resourceId: input.analysisId,
        extraMetadata: {
            role: "step_output",
            producerStep: input.stepId,
            producerRun: input.runId,
            producerAgent: input.agentId,
        },
        modelId: deps.model,
        messages: transcript,
        workspaceFs: deps.workspaceFs,
        workingDir: writePrefix,
    });
    return result.entries;
}

/**
 * Generate the interpretive step summary and persist it to
 * `output/summary.md`. A write failure is non-fatal (logged) — the summary is
 * still returned for vector indexing.
 */
export async function generateStepSummaryAndWrite(
    deps: PostStepPipelineDeps,
    postCtx: PostStepContext,
    manifest: readonly ArtifactManifestEntry[],
): Promise<StepSummary | undefined> {
    const { input, session, transcript, writePrefix } = postCtx;

    const summary = await coreGenerateStepSummary({
        provider: deps.provider,
        session,
        modelId: deps.model,
        messages: transcript,
        artifactPaths: manifest.map((a) => a.path),
        workspaceFs: deps.workspaceFs,
        workingDir: writePrefix,
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

/**
 * Reconcile the manifest against disk (drop phantoms, rehash) and register the
 * survivors with the local ledger + the injected `ArtifactRegistry`. Fail-fast
 * (see the artifact-manifest spec): a non-zero `externalFailed` is a persistent rejection that
 * orphans real outputs, so it throws with the per-file detail (the OSS
 * filesystem registry returns `externalFailed: 0`, so it never trips). Returns
 * the reconciled manifest.
 */
export async function reconcileAndRegisterStepArtifacts(
    deps: PostStepPipelineDeps,
    postCtx: PostStepContext,
    manifest: readonly ArtifactManifestEntry[],
): Promise<readonly ArtifactManifestEntry[]> {
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

    if (reconciled.manifest.length === 0) return reconciled.manifest;

    const reg = await registerStepArtifacts(
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
    if (reg.externalFailed > 0) {
        const wholeActivityFailed = reg.externalRegistered === 0;
        const detail = reg.failureDetails.map((f) => `${f.path}: ${f.error}`).join("\n  ");
        const msg =
            `[post-step.reconcile] external registration failed for ${input.stepId}: ` +
            `${reg.externalFailed} row(s) rejected, ${reg.externalRegistered}/${reg.localCount} local artifact(s) registered` +
            (wholeActivityFailed ? " (WHOLE ACTIVITY ROLLED BACK — outputs orphaned)" : "") +
            (detail ? `\n  ${detail}` : "");
        // Logged as fields as well as thrown: the throw reaches `failStep` as one
        // opaque string, so the per-path rejections are only queryable from here.
        // This is what distinguishes a registry rejection from the attestation
        // throws in `reconcileManifestWithDisk` when a step dies.
        (deps.logger ?? createNoopLogger()).named("post-step").named("reconcile").error("external registration failed", {
            runId: input.runId,
            stepId: input.stepId,
            externalFailed: reg.externalFailed,
            externalRegistered: reg.externalRegistered,
            localCount: reg.localCount,
            wholeActivityFailed,
            failures: reg.failureDetails,
        });
        throw new Error(msg);
    }

    return reconciled.manifest;
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
        const ok = await indexOne(`/${input.analysisId}/${entry.dbPath}`, entry.description, { text: entry.description, type: "output", ...entry.metadata });
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
