/**
 * Vector-index stage isolation tests (`vectorIndexStepOutputs`).
 *
 * The stage is best-effort and degrades per-item: one rejected embedding costs
 * only its own index entry while every other file description and the step
 * summary still land, and the step never fails. A partial index returns fewer
 * search hits rather than an error, so these tests read what actually landed in
 * the pgvector store — and, for the observability case where a log line is the
 * only signal, the captured records.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";
import type { Pool } from "pg";

import { createCapturingLogger } from "../__tests__/setup/logger.js";
import { withSchema } from "../__tests__/setup/postgres.js";
import { makeLocalAuth } from "../auth/local-auth-context.js";
import type { RunSession } from "../auth/types.js";
import type { Logger } from "../lib/logger.js";
import { ProvenanceCollector } from "../provenance/collector.js";
import type { ProviderError } from "../providers/errors.js";
import type { AgentChat, EmbeddingProvider } from "../providers/types.js";
import type { ArtifactManifestEntry } from "../schemas/artifact-manifest.js";
import type { StepSummary } from "../schemas/step-summary.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import { searchIndexName } from "../workspace/search-config.js";
import type { ArtifactRegistry } from "./artifact-registry.js";
import type { FileMetadataEntry } from "./artifact-metadata.js";
import { vectorIndexStepOutputs, type PostStepPipelineDeps } from "./post-step-pipeline.js";
import type { PostStepArtifacts, PostStepContext, SandboxStepInput } from "../workflows/sandbox-step.js";

const RUN_ID = "run-vec";
const STEP_ID = "T1S1";
const AGENT_ID = "test-agent";

// `ensureSearchIndex` memoizes ensured index names for the process lifetime, and
// the name derives from the analysis id — so a per-test id guarantees the stage
// actually creates the index table inside that test's own schema.
let analysisCounter = 0;
function uniqueAnalysisId(): string {
    return `analysis_vec_${Date.now().toString(36)}_${analysisCounter++}`;
}

function makeRunSession(analysisId: string): RunSession {
    return {
        identity: { user: "user-vec" },
        scope: { kind: "analysis", analysisId },
        provenance: { agentId: AGENT_ID, callPath: [AGENT_ID] },
        runFrame: { runId: RUN_ID },
        auth: makeLocalAuth(),
    };
}

function makePostCtx(analysisId: string): PostStepContext {
    // The vector-index stage reads only `input.{analysisId,runId,stepId,agentId}`
    // and `session`; the remaining `SandboxStepInput` fields never reach it.
    const input = { analysisId, runId: RUN_ID, stepId: STEP_ID, agentId: AGENT_ID } as unknown as SandboxStepInput;
    return {
        input,
        session: makeRunSession(analysisId),
        transcript: [],
        writePrefix: "/unused",
        sandboxId: "sbx-test",
        lineageCollector: new ProvenanceCollector({ stepId: STEP_ID, runId: RUN_ID }),
    };
}

function makeDeps(pool: Pool, embedding: EmbeddingProvider, logger: Logger): PostStepPipelineDeps {
    // The vector-index stage consumes only pool, logger, and embedding; the other
    // post-step seams are never touched here.
    return {
        pool,
        logger,
        embedding,
        provider: {} as AgentChat,
        workspaceFs: {} as WorkspaceFilesystem,
        artifactRegistry: {} as ArtifactRegistry,
        resolveWorkspaceRoot: (id) => id,
        model: "test-model",
    };
}

/** Embedding provider that rejects exactly the texts matching `poison`. */
function embeddingRejecting(poison: (text: string) => boolean): EmbeddingProvider {
    return {
        dimensions: 3,
        embed: (texts) => {
            if (texts.some(poison)) {
                const providerErr: ProviderError = { type: "provider", retryable: false, message: "embedding backend rejected input" };
                return errAsync(providerErr);
            }
            return okAsync(texts.map(() => [0.1, 0.2, 0.3]));
        },
    };
}

function fileEntry(rel: string, description: string): FileMetadataEntry {
    return {
        dbPath: `runs/${RUN_ID}/${STEP_ID}/${rel}`,
        description,
        metadata: { path: rel, role: "step_output" },
    };
}

function manifestEntry(rel: string): ArtifactManifestEntry {
    return { stepId: STEP_ID, runId: RUN_ID, path: rel, size: 100, type: "output" };
}

function summaryOf(markdown: string): StepSummary {
    return { stepId: STEP_ID, agentId: AGENT_ID, markdown };
}

function vectorId(analysisId: string, rel: string): string {
    return `/${analysisId}/runs/${RUN_ID}/${STEP_ID}/${rel}`;
}

interface IndexedRow {
    id: string;
    metadata: Record<string, unknown>;
}

/** What actually landed in the per-analysis index, or `[]` if the table was never created. */
async function readIndex(pool: Pool, analysisId: string): Promise<IndexedRow[]> {
    const name = searchIndexName(analysisId);
    const present = await pool.query<{ reg: string | null }>(`SELECT to_regclass($1) AS reg`, [name]);
    if (!present.rows[0]?.reg) return [];
    const res = await pool.query<{ vector_id: string; metadata: Record<string, unknown> }>(`SELECT vector_id, metadata FROM "${name}" ORDER BY vector_id`);
    return res.rows.map((r) => ({ id: r.vector_id, metadata: r.metadata }));
}

describe("vectorIndexStepOutputs — per-item isolation", () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
        for (const drop of cleanups.splice(0)) await drop();
    });

    it("one poisoned file description costs only its own entry; the rest and the summary still land", async () => {
        const analysisId = uniqueAnalysisId();
        const { pool, drop } = await withSchema("vec-poisoned-file");
        cleanups.push(drop);

        const artifacts: PostStepArtifacts = {
            metadataEntries: [
                fileEntry("output/a.csv", "alpha description"),
                fileEntry("output/poison.csv", "poison description"),
                fileEntry("output/c.csv", "gamma description"),
            ],
            reconciledManifest: [manifestEntry("output/a.csv"), manifestEntry("output/poison.csv"), manifestEntry("output/c.csv")],
            summary: summaryOf("## step summary"),
        };
        const deps = makeDeps(
            pool,
            embeddingRejecting((t) => t === "poison description"),
            createCapturingLogger(),
        );

        // Direct await: a throw here would fail the test — the stage must swallow.
        await vectorIndexStepOutputs(deps, makePostCtx(analysisId), artifacts);

        const ids = (await readIndex(pool, analysisId)).map((r) => r.id);
        expect(ids).toContain(vectorId(analysisId, "output/a.csv"));
        expect(ids).toContain(vectorId(analysisId, "output/c.csv"));
        expect(ids).toContain(vectorId(analysisId, "output/summary.md"));
        expect(ids).not.toContain(vectorId(analysisId, "output/poison.csv"));
        expect(ids).toHaveLength(3);
    });

    it("a poisoned summary still lands every file description", async () => {
        const analysisId = uniqueAnalysisId();
        const { pool, drop } = await withSchema("vec-poisoned-summary");
        cleanups.push(drop);

        const artifacts: PostStepArtifacts = {
            metadataEntries: [fileEntry("output/a.csv", "alpha description"), fileEntry("output/b.csv", "beta description")],
            reconciledManifest: [manifestEntry("output/a.csv"), manifestEntry("output/b.csv")],
            summary: summaryOf("## poisoned summary"),
        };
        const deps = makeDeps(
            pool,
            embeddingRejecting((t) => t === "## poisoned summary"),
            createCapturingLogger(),
        );

        await vectorIndexStepOutputs(deps, makePostCtx(analysisId), artifacts);

        const ids = (await readIndex(pool, analysisId)).map((r) => r.id);
        expect(ids).toContain(vectorId(analysisId, "output/a.csv"));
        expect(ids).toContain(vectorId(analysisId, "output/b.csv"));
        expect(ids).not.toContain(vectorId(analysisId, "output/summary.md"));
        expect(ids).toHaveLength(2);
    });

    it("a setup failure indexes nothing and does not throw", async () => {
        const analysisId = uniqueAnalysisId();
        const { pool, drop } = await withSchema("vec-setup-failure");
        cleanups.push(drop);

        // A pool that rejects every query fails `ensureSearchIndex` before any item
        // is attempted; the real schema pool below is untouched.
        const brokenPool = { query: () => Promise.reject(new Error("index setup boom")) } as unknown as Pool;
        const logger = createCapturingLogger();
        const deps = makeDeps(
            brokenPool,
            embeddingRejecting(() => false),
            logger,
        );
        const artifacts: PostStepArtifacts = {
            metadataEntries: [fileEntry("output/a.csv", "alpha description")],
            reconciledManifest: [manifestEntry("output/a.csv")],
            summary: summaryOf("## step summary"),
        };

        await vectorIndexStepOutputs(deps, makePostCtx(analysisId), artifacts);

        expect(await readIndex(pool, analysisId)).toHaveLength(0);

        // The only signal is a single setup-failure warn — no per-item id/length and
        // no indexed/failed summary count, since nothing was attempted.
        const warns = logger.records.filter((r) => r.level === "warn");
        expect(warns).toHaveLength(1);
        expect(warns[0]!.msg).toBe("[post-step.vector-index] indexing failed");
        expect(warns[0]!.fields).not.toHaveProperty("id");
        expect(warns[0]!.fields).not.toHaveProperty("indexed");
    });

    it("logs each per-item failure with its id and text length, and a summary with the counts", async () => {
        const analysisId = uniqueAnalysisId();
        const { pool, drop } = await withSchema("vec-observability");
        cleanups.push(drop);

        const poisonDesc = "poison description body";
        const logger = createCapturingLogger();
        const artifacts: PostStepArtifacts = {
            metadataEntries: [fileEntry("output/ok.csv", "fine description"), fileEntry("output/bad.csv", poisonDesc)],
            reconciledManifest: [manifestEntry("output/ok.csv"), manifestEntry("output/bad.csv")],
            summary: summaryOf("## good summary"),
        };
        const deps = makeDeps(
            pool,
            embeddingRejecting((t) => t === poisonDesc),
            logger,
        );

        await vectorIndexStepOutputs(deps, makePostCtx(analysisId), artifacts);

        const warns = logger.records.filter((r) => r.level === "warn");

        const itemWarn = warns.find((r) => r.msg === "[post-step.vector-index] indexing failed");
        expect(itemWarn).toBeDefined();
        expect(itemWarn!.fields.id).toBe(vectorId(analysisId, "output/bad.csv"));
        expect(itemWarn!.fields.textLength).toBe(poisonDesc.length);

        // ok.csv + summary.md landed; bad.csv did not.
        const summaryWarn = warns.find((r) => r.msg === "[post-step.vector-index] indexed with failures");
        expect(summaryWarn).toBeDefined();
        expect(summaryWarn!.fields.indexed).toBe(2);
        expect(summaryWarn!.fields.failed).toBe(1);
    });
});
