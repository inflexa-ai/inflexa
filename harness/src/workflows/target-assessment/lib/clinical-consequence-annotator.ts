/**
 * Per-row LLM clinical-consequence annotator with Postgres caching.
 *
 * Any off-target row missing a `clinical_consequence` gets annotated by a
 * focused tool-less LLM specialist that returns ONE sentence + provenance.
 * Results are cached in `cortex_off_target_annotations` keyed by
 * (primary_target_gene, off_target_key) so repeat assessments reuse prior
 * work.
 *
 * Cache miss path: when a `deps` bundle is supplied, build a compact JSON
 * prompt, run a single-shot harness agent loop (no tools, max 2 iterations),
 * parse JSON out of the final assistant text, INSERT on success, return the
 * consequence. With no `deps`, the function returns null on cache miss
 * (no LLM call). Cache hit path: a single primary-key lookup, no LLM call.
 * Per-row failures (LLM, schema validation, DB) are swallowed — annotation
 * is supplementary; the dossier renders fine with null.
 */

import { z } from "zod";

import { withHost } from "../../../lib/host-concurrency.js";
import { tryQuery, tryMutation } from "../../../lib/db-result.js";
import type { Pool } from "pg";
import { offTargetAnnotatorPrompt } from "../../../prompts/target-assessment/off-target-annotator.js";
import { composeSystemPrompt } from "../../../agents/system-prompt.js";
import type { AgentSession } from "../../../auth/types.js";
import { forSubAgent } from "../../../auth/types.js";
import { finalText, runAgent } from "../../../loop/run-agent.js";
import { passthroughStep } from "../../../loop/run-step.js";
import type { AgentDefinition } from "../../../loop/types.js";
import type { ChatProvider } from "../../../providers/types.js";

export const OffTargetAnnotationSchema = z.object({
    clinical_consequence: z.string().min(10),
    provenance: z.string().min(3),
});
export type OffTargetAnnotation = z.infer<typeof OffTargetAnnotationSchema>;

export interface ClinicalConsequenceAnnotatorDeps {
    readonly provider: ChatProvider;
    readonly session: AgentSession;
    readonly model: string;
}

export interface AnnotationInput {
    primaryTargetGene: string;
    offTargetId: string | null;
    offTargetName: string;
    offTargetAccession: string | null;
    pchembl: number;
    /** Optional one-line family-relationship hint (e.g., "obligate cofactor"). */
    context?: string;
}

function cacheKey(input: Pick<AnnotationInput, "offTargetId" | "offTargetName">): string | null {
    const id = input.offTargetId?.trim();
    if (id) return id;
    const name = input.offTargetName.trim().toLowerCase();
    return name ? `name:${name}` : null;
}

async function readCache(pool: Pool, primaryTargetGene: string, key: string): Promise<OffTargetAnnotation | null> {
    // Annotation is supplementary — a cache-read failure must NOT surface. The
    // `DbError` is collapsed to `null` (treated as a cache miss) via `.unwrapOr`.
    return tryQuery("offTargetAnnotations.readCache", async () => {
        const res = await pool.query<{ clinical_consequence: string; provenance: string | null }>(
            `SELECT clinical_consequence, provenance
       FROM cortex_off_target_annotations
       WHERE primary_target_gene = $1 AND off_target_key = $2
       LIMIT 1`,
            [primaryTargetGene, key],
        );
        if (res.rows.length === 0) return null;
        const row = res.rows[0]!;
        return {
            clinical_consequence: row.clinical_consequence,
            provenance: row.provenance ?? "",
        };
    }).unwrapOr(null);
}

async function writeCache(
    pool: Pool,
    primaryTargetGene: string,
    key: string,
    offTargetName: string,
    annotation: OffTargetAnnotation,
    model: string,
): Promise<void> {
    // Cache-write failures must not affect the assembly result — the `DbError`
    // is swallowed (both branches no-op) so annotation never surfaces a DB fault.
    await tryMutation("offTargetAnnotations.writeCache", async () => {
        await pool.query(
            `INSERT INTO cortex_off_target_annotations
         (primary_target_gene, off_target_key, off_target_name, clinical_consequence, provenance, model)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (primary_target_gene, off_target_key) DO NOTHING`,
            [primaryTargetGene, key, offTargetName, annotation.clinical_consequence, annotation.provenance, model],
        );
    }).match(
        () => {},
        () => {},
    );
}

function buildPrompt(input: AnnotationInput): string {
    return JSON.stringify(
        {
            primary_target_gene: input.primaryTargetGene,
            off_target_id: input.offTargetId,
            off_target_name: input.offTargetName,
            off_target_accession: input.offTargetAccession,
            pchembl: input.pchembl,
            context: input.context ?? null,
        },
        null,
        2,
    );
}

/**
 * Best-effort JSON extraction from an LLM text response. Strips fenced
 * code blocks and surrounding prose so a slightly-out-of-spec reply still
 * parses.
 */
function extractJsonObject(text: string): unknown | null {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1]! : text;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) return null;
    try {
        return JSON.parse(candidate.slice(start, end + 1));
    } catch {
        return null;
    }
}

const ANNOTATOR_AGENT_ID = "off-target-annotator";

function buildAnnotatorAgent(model: string): AgentDefinition {
    return {
        id: ANNOTATOR_AGENT_ID,
        systemPrompt: composeSystemPrompt(offTargetAnnotatorPrompt),
        model,
        tools: [],
        maxIterations: 2,
    };
}

/**
 * Annotate a single off-target row. Returns null on any failure (cache
 * miss + no deps, cache miss + LLM unavailable, schema validation failure,
 * DB unreachable, etc.) — callers must treat null as "no annotation" and
 * leave `clinical_consequence` as their original fallback.
 */
export async function annotateClinicalConsequence(
    pool: Pool,
    input: AnnotationInput,
    deps?: ClinicalConsequenceAnnotatorDeps,
): Promise<OffTargetAnnotation | null> {
    if (!input.primaryTargetGene) return null;
    const key = cacheKey(input);
    if (!key) return null;

    const cached = await readCache(pool, input.primaryTargetGene, key);
    if (cached) return cached;
    if (!deps) return null;

    try {
        const agent = buildAnnotatorAgent(deps.model);
        const session = forSubAgent(deps.session, ANNOTATOR_AGENT_ID);
        const controller = new AbortController();
        const { messages } = await runAgent(agent, [{ role: "user", content: buildPrompt(input) }], session, {
            provider: deps.provider,
            signal: controller.signal,
            emit: () => {},
            runStep: passthroughStep,
        });
        const raw = extractJsonObject(finalText(messages));
        if (raw === null) return null;
        const parsed = OffTargetAnnotationSchema.safeParse(raw);
        if (!parsed.success) return null;
        await writeCache(pool, input.primaryTargetGene, key, input.offTargetName, parsed.data, deps.model);
        return parsed.data;
    } catch {
        return null;
    }
}

/**
 * Annotate every row in an off-target panel whose `clinical_consequence`
 * is currently null. Mutates the supplied arrays in-place. Pure assembly-
 * time helper — no return value.
 *
 * Per-row LLM calls are bounded by the "annotation-llm" host budget (4 in
 * flight). Cache hits skip the LLM entirely and consume only a cheap
 * Postgres lookup, so the budget gate is held briefly for those rows.
 * Without `deps`, the panel is annotated cache-only — rows missing a
 * cached entry remain with their original fallback.
 */
export async function annotateOffTargetPanel(
    pool: Pool,
    panel: {
        rows: Array<Record<string, unknown>>;
        excluded_rows: Array<Record<string, unknown>>;
    },
    primaryTargetGene: string,
    deps?: ClinicalConsequenceAnnotatorDeps,
): Promise<void> {
    if (!primaryTargetGene) return;
    const allRows = [...panel.rows, ...panel.excluded_rows];
    const needsAnnotation = allRows.filter((r) => r && (r.clinical_consequence == null || r.clinical_consequence === ""));
    if (needsAnnotation.length === 0) return;

    await Promise.all(
        needsAnnotation.map((r) =>
            withHost("annotation-llm", async () => {
                const annotation = await annotateClinicalConsequence(
                    pool,
                    {
                        primaryTargetGene,
                        offTargetId: typeof r.off_target_id === "string" ? r.off_target_id : null,
                        offTargetName: typeof r.off_target_name === "string" ? r.off_target_name : "",
                        offTargetAccession: typeof r.accession === "string" ? r.accession : null,
                        pchembl: typeof r.pchembl === "number" ? r.pchembl : 0,
                        context: r.relationship === "obligate_cofactor" ? "obligate cofactor with the primary protein" : undefined,
                    },
                    deps,
                );
                if (annotation) r.clinical_consequence = annotation.clinical_consequence;
            }),
        ),
    );
}
