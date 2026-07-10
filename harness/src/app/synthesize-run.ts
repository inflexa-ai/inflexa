/**
 * Run-level synthesis — the host-agnostic ability lifted out of the managed
 * workflow-dep closure so every embedder reuses it (see CONTEXT.md
 * "Application service layer"). Loads the completed run's step summaries,
 * drives the literature-grounded synthesizer, indexes + persists the result,
 * and reports progress phases — returning the quick-display findings for the
 * run-completed card.
 *
 * Owns the ability end-to-end; owns no transport. The injected `embedding`
 * provider carries the host's own billing choice (a no-op locally); `emit` is
 * the loop/chat-part sink the caller binds to its stream; `onProgress`
 * is the domain progress callback the caller serializes to the wire. A genuine
 * synthesis failure re-throws (D10) so the caller fails the run loudly; the
 * honest non-fatal outcomes (no summaries, blocker) return empty findings after
 * a `skipped` phase.
 */

import type { Pool } from "pg";

import type { SynthesisPhase } from "@inflexa-ai/harness/contracts/chat-parts.js";

import type { RunSession } from "../auth/types.js";
import { forSubAgent } from "../auth/types.js";
import type { EmitFn } from "../loop/types.js";
import type { ChatProvider, EmbeddingProvider } from "../providers/types.js";
import type { BioToolKeys } from "../tools/bio/keys.js";
import type { RunFinding } from "../workflows/execute-analysis.js";
import {
    buildRunSynthesisPart,
    formatSynthesisEmbeddingText,
    generateRunSynthesis,
    loadStepSummariesFromDisk,
    persistSynthesis,
} from "../execution/run-synthesis.js";
import type { ResolveWorkspaceRoot } from "../workspace/paths.js";
import { ensureSearchIndex, searchIndexName } from "../workspace/search-config.js";
import { createVectorStore } from "../state/vector-store.js";
import { loadPlan, queryRun } from "../state/index.js";
import { unwrapOrThrow } from "../lib/result.js";

export interface SynthesizeRunDeps {
    readonly pool: Pool;
    readonly provider: ChatProvider;
    /** Write-side embedder — its `dimensions` sizes the per-analysis index. */
    readonly embedding: EmbeddingProvider;
    /** Embedder-supplied workspace-root resolution seam (see workspace/paths.ts). */
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    /** Model id for the synthesizer agent loop. */
    readonly synthesisModel: string;
    /** API keys for the bio/chem tools the embedded literature reviewer uses. */
    readonly bioKeys: BioToolKeys;
}

/** Optional fields for a progress update, mirroring the wire part. */
export interface SynthesisProgressExtra {
    readonly delegationCount?: number;
    readonly validationAttempts?: number;
    readonly reason?: string;
    readonly error?: string;
}

export interface SynthesizeRunParams {
    readonly analysisId: string;
    readonly runId: string;
    readonly completedSteps: readonly string[];
    readonly session: RunSession;
    /** Loop-event + run-synthesis chat-part sink (forwarded to the synthesizer loop). */
    readonly emit: EmitFn;
    /** Domain progress callback — the phases the run-completed UI renders. */
    readonly onProgress: (phase: SynthesisPhase, activity: string, extra?: SynthesisProgressExtra) => void | Promise<void>;
}

export interface SynthesizeRunResult {
    readonly findings: readonly RunFinding[];
}

export async function synthesizeRun(deps: SynthesizeRunDeps, params: SynthesizeRunParams): Promise<SynthesizeRunResult> {
    const { pool, provider, embedding, resolveWorkspaceRoot, synthesisModel, bioKeys } = deps;
    const { analysisId, runId, completedSteps, session, emit, onProgress } = params;

    await onProgress("starting", "Beginning literature-grounded synthesis");

    try {
        const workspaceRoot = resolveWorkspaceRoot(analysisId);
        const summaries = await loadStepSummariesFromDisk({
            workspaceRoot,
            runId,
            completedSteps,
        });
        if (summaries.length === 0) {
            await onProgress("skipped", "No step summaries available for synthesis", {
                reason: "no-summaries",
            });
            return { findings: [] };
        }

        const planNarrative = await loadPlanNarrative(pool, runId, analysisId);
        const synthesizerSession = forSubAgent(session, "run-synthesizer");

        const result = await generateRunSynthesis({
            provider,
            session: synthesizerSession,
            model: synthesisModel,
            bioKeys,
            summaries,
            planNarrative,
            runId,
            emit,
        });

        if (result.kind === "skipped") {
            await onProgress("skipped", "Synthesis skipped — run did not produce synthesizable content", { reason: result.reason });
            return { findings: [] };
        }

        const synthesis = result.synthesis;

        await onProgress("indexing", "Indexing synthesis for search");
        try {
            await ensureSearchIndex(pool, analysisId, embedding.dimensions);
            const vectorStore = createVectorStore(pool);
            const indexName = searchIndexName(analysisId);
            const synthesisText = formatSynthesisEmbeddingText(synthesis);
            const [vector] = unwrapOrThrow(await embedding.embed([synthesisText], synthesizerSession));
            if (!vector) throw new Error("synthesize-run: empty embedding response");
            unwrapOrThrow(
                await vectorStore.upsert({
                    indexName,
                    vectors: [vector],
                    metadata: [{ text: synthesisText, type: "synthesis", runId }],
                    ids: [`/${analysisId}/runs/${runId}/synthesis.json`],
                }),
            );
        } catch (indexErr) {
            console.warn(`[synthesize-run] vector indexing failed for run ${runId}:`, indexErr instanceof Error ? indexErr.message : indexErr);
        }

        await onProgress("persisting", "Persisting synthesis");
        await persistSynthesis({ workspaceRoot, runId, synthesis });

        await emit(buildRunSynthesisPart(runId, synthesis));
        await onProgress("complete", "Literature-grounded synthesis ready");
        return {
            findings: synthesis.findings.map((f) => ({
                title: f.title,
                confidence: f.confidence,
            })),
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await onProgress("failed", "Synthesis could not be completed — step summaries are still available", { error: msg });
        // A genuine synthesis failure must fail the run loudly (D10): re-throw so
        // the synthesis step errors and the parent workflow goes to ERROR. The
        // honest non-fatal outcomes (no-summaries / blocker) early-return above.
        throw err;
    }
}

async function loadPlanNarrative(pool: Pool, runId: string, analysisId: string): Promise<string> {
    const run = unwrapOrThrow(await queryRun(pool, runId));
    const planId = run?.planId ?? null;
    if (!planId) return "";
    const plan = unwrapOrThrow(await loadPlan(pool, planId, { analysisId })) as { analytical_narrative?: string } | null;
    return plan?.analytical_narrative ?? "";
}
