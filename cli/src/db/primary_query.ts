import { type Result } from "neverthrow";
import type { DbError } from "./errors.ts";
import type { Anchor } from "../types/anchor.ts";
import type { Project } from "../types/project.ts";
import type { Analysis, AnalysisInput } from "../types/analysis.ts";
import { asStr256, type IdOrName } from "../lib/types.ts";
import { tryQuery } from "./util.ts";

/** A row of the columnar `anchors` table — one typed column per field (not a JSON blob), so identity and path stay filterable and joinable in SQL. */
type AnchorRow = {
    id: string;
    created_at: number;
    updated_at: number;
    cached_path: string;
    marker_written: number;
    last_seen: number;
};

function anchorFromRow(r: AnchorRow): Anchor {
    return {
        id: r.id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        cachedPath: r.cached_path,
        markerWritten: r.marker_written === 1,
        lastSeen: r.last_seen,
    };
}

const ANCHOR_COLS = "id, created_at, updated_at, cached_path, marker_written, last_seen";

/** Loads an anchor by its id (the marker UUID); `null` when there is no such row. */
export function getAnchor(id: string): Result<Anchor | null, DbError> {
    return tryQuery("getAnchor", (conn) => {
        const row = conn.query(`SELECT ${ANCHOR_COLS} FROM anchors WHERE id = ?`).get(id) as AnchorRow | null;
        return row ? anchorFromRow(row) : null;
    });
}

/** Every anchor row — the candidate set for the bounded path search during anchor reconciliation. */
export function listAnchors(): Result<Anchor[], DbError> {
    return tryQuery("listAnchors", (conn) => {
        const rows = conn.query(`SELECT ${ANCHOR_COLS} FROM anchors`).all() as AnchorRow[];
        return rows.map(anchorFromRow);
    });
}

// --- Data model: projects ---

/** A row of the columnar `projects` table — one typed column per field. */
type ProjectRow = {
    id: string;
    created_at: number;
    updated_at: number;
    name: string;
    description: string | null;
    tags: string;
};

function projectFromRow(r: ProjectRow): Project {
    return {
        id: r.id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        // Trusted source: the name was validated through `str256` before it was ever stored.
        name: asStr256(r.name),
        description: r.description,
        // tags are stored comma-joined; they hold no commas (comma-split on input), so the round-trip is lossless.
        tags: r.tags ? r.tags.split(",").filter(Boolean) : [],
    };
}

const PROJECT_COLS = "id, created_at, updated_at, name, description, tags";

/** Every project, newest first. */
export function listProjects(): Result<Project[], DbError> {
    return tryQuery("listProjects", (conn) => {
        const rows = conn.query(`SELECT ${PROJECT_COLS} FROM projects ORDER BY created_at DESC`).all() as ProjectRow[];
        return rows.map(projectFromRow);
    });
}

/**
 * Resolve an id-or-name reference to a single project in ONE query: an exact `id` hit wins
 * over a `name` hit (both columns are unique). `null` when nothing matches. See CLAUDE.md →
 * "Resolving an id-or-name reference".
 */
export function findProjectByRef(ref: IdOrName): Result<Project | null, DbError> {
    return tryQuery("findProjectByRef", (conn) => {
        const row = conn
            .query(`SELECT ${PROJECT_COLS} FROM projects WHERE id = $ref OR name = $ref ORDER BY (id = $ref) DESC LIMIT 1`)
            .get({ $ref: ref }) as ProjectRow | null;
        return row ? projectFromRow(row) : null;
    });
}

/** How many analyses are grouped under a project. `0` when the project has none (or does not exist). */
export function countAnalysesByProject(projectId: string): Result<number, DbError> {
    return tryQuery("countAnalysesByProject", (conn) => {
        const row = conn.query("SELECT COUNT(*) AS n FROM analyses WHERE project_id = ?").get(projectId) as { n: number };
        return row.n;
    });
}

/** How many analyses are homed at an anchor. `0` when it has none (or does not exist) — used by `prune` to show what a dead anchor would take with it. */
export function countAnalysesByAnchor(anchorId: string): Result<number, DbError> {
    return tryQuery("countAnalysesByAnchor", (conn) => {
        const row = conn.query("SELECT COUNT(*) AS n FROM analyses WHERE anchor_id = ?").get(anchorId) as { n: number };
        return row.n;
    });
}

// --- Data model: analyses ---

/** A row of the columnar `analyses` table — one typed column per field so it can be filtered, ordered, and joined directly in SQL. */
type AnalysisRow = {
    id: string;
    created_at: number;
    updated_at: number;
    name: string;
    slug: string;
    anchor_id: string;
    project_id: string | null;
};

function analysisFromRow(r: AnalysisRow): Analysis {
    return {
        id: r.id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        // Trusted source: the name was validated through `str256` before it was ever stored.
        name: asStr256(r.name),
        slug: r.slug,
        anchorId: r.anchor_id,
        projectId: r.project_id,
    };
}

const ANALYSIS_COLS = "id, created_at, updated_at, name, slug, anchor_id, project_id";

/**
 * Resolve an id-or-name reference to its candidate analyses in ONE query: an exact `id` hit
 * sorts first (ids are unique, so it is THE match), then `slug`/`name` hits most-recent-first.
 * Empty when nothing matches. The caller takes `[0]` as the resolved analysis and reads "more
 * than one row, none by id" as a name/slug collision (ambiguity). See CLAUDE.md → "Resolving
 * an id-or-name reference".
 */
export function findAnalysesByRef(ref: IdOrName): Result<Analysis[], DbError> {
    return tryQuery("findAnalysesByRef", (conn) => {
        const rows = conn
            .query(`SELECT ${ANALYSIS_COLS} FROM analyses WHERE id = $ref OR slug = $ref OR name = $ref ORDER BY (id = $ref) DESC, created_at DESC`)
            .all({ $ref: ref }) as AnalysisRow[];
        return rows.map(analysisFromRow);
    });
}

// Derived from ANALYSIS_COLS (one source for the column list) and qualified+aliased because the
// joined `anchors` table shares column names (`id`, `created_at`, `updated_at`) — unqualified
// selection would be ambiguous.
const ANALYSIS_COLS_QUALIFIED = ANALYSIS_COLS.split(", ")
    .map((c) => `analyses.${c} AS ${c}`)
    .join(", ");

/** An {@link AnalysisRow} joined to its anchor's cached path — `null` when the anchor row is gone (a normal local-state desync). */
type AnalysisWithAnchorRow = AnalysisRow & { anchor_cached_path: string | null };

/**
 * The {@link findAnalysesByRef} candidate selection, each row joined to its anchor folder's
 * last-known path — the disambiguating fact an ambiguity listing shows (same-named analyses
 * usually differ by WHERE they live). LEFT JOIN because the anchor row may legitimately be
 * missing (the user owns both the DB file and the folders, and the two can desync); the path is
 * then `null` on the ok channel, never an error. Same id-first, newest-first ordering as the
 * unjoined resolver.
 */
export function findAnalysesByRefWithAnchor(ref: IdOrName): Result<{ analysis: Analysis; anchorPath: string | null }[], DbError> {
    return tryQuery("findAnalysesByRefWithAnchor", (conn) => {
        const rows = conn
            .query(
                `SELECT ${ANALYSIS_COLS_QUALIFIED}, anchors.cached_path AS anchor_cached_path
                 FROM analyses LEFT JOIN anchors ON anchors.id = analyses.anchor_id
                 WHERE analyses.id = $ref OR analyses.slug = $ref OR analyses.name = $ref
                 ORDER BY (analyses.id = $ref) DESC, analyses.created_at DESC`,
            )
            .all({ $ref: ref }) as AnalysisWithAnchorRow[];
        return rows.map((r) => ({ analysis: analysisFromRow(r), anchorPath: r.anchor_cached_path }));
    });
}

/** Every analysis, newest first. */
export function listAnalyses(): Result<Analysis[], DbError> {
    return tryQuery("listAnalyses", (conn) => {
        const rows = conn.query(`SELECT ${ANALYSIS_COLS} FROM analyses ORDER BY created_at DESC`).all() as AnalysisRow[];
        return rows.map(analysisFromRow);
    });
}

/** Analyses homed at an anchor, newest first. The home is unique-slug scoped, so this is also the slug-collision candidate set at creation. */
export function listAnalysesByAnchor(anchorId: string): Result<Analysis[], DbError> {
    return tryQuery("listAnalysesByAnchor", (conn) => {
        const rows = conn.query(`SELECT ${ANALYSIS_COLS} FROM analyses WHERE anchor_id = ? ORDER BY created_at DESC`).all(anchorId) as AnalysisRow[];
        return rows.map(analysisFromRow);
    });
}

/** Analyses grouped under a project, newest first. */
export function listAnalysesByProject(projectId: string): Result<Analysis[], DbError> {
    return tryQuery("listAnalysesByProject", (conn) => {
        const rows = conn.query(`SELECT ${ANALYSIS_COLS} FROM analyses WHERE project_id = ? ORDER BY created_at DESC`).all(projectId) as AnalysisRow[];
        return rows.map(analysisFromRow);
    });
}

/** An analysis's input refs. `path` is relative-to-anchor when `anchorId` is set, absolute otherwise. */
export function listAnalysisInputs(analysisId: string): Result<AnalysisInput[], DbError> {
    return tryQuery("listAnalysisInputs", (conn) => {
        const rows = conn.query("SELECT path, is_dir, analysis_id, anchor_id FROM analysis_inputs WHERE analysis_id = ?").all(analysisId) as {
            path: string;
            is_dir: number;
            analysis_id: string;
            anchor_id: string | null;
        }[];
        return rows.map((r) => ({
            path: r.path,
            isDir: r.is_dir === 1,
            analysisId: r.analysis_id,
            anchorId: r.anchor_id,
        }));
    });
}

// --- Data model: provenance ---

/** The stored PROV-JSON serialization of an analysis's provenance document; `null` when nothing has been recorded yet (treated as an empty document). */
export function getAnalysisProvenance(id: string): Result<string | null, DbError> {
    return tryQuery("getAnalysisProvenance", (conn) => {
        const row = conn.query("SELECT provenance FROM analyses WHERE id = ?").get(id) as { provenance: string | null } | null;
        return row?.provenance ?? null;
    });
}

/** The integrity columns for an analysis's provenance. All are `null` when unsigned. */
export type AnalysisIntegrity = {
    provenance: string | null;
    prevChainHash: string | null;
    chainHash: string | null;
    signature: string | null;
};

/** Read provenance + integrity columns in one query — the verifier's single DB round-trip. */
export function getAnalysisIntegrity(id: string): Result<AnalysisIntegrity | null, DbError> {
    return tryQuery("getAnalysisIntegrity", (conn) => {
        const row = conn
            .query("SELECT provenance, provenance_prev_chain_hash, provenance_chain_hash, provenance_signature FROM analyses WHERE id = ?")
            .get(id) as {
            provenance: string | null;
            provenance_prev_chain_hash: string | null;
            provenance_chain_hash: string | null;
            provenance_signature: string | null;
        } | null;
        if (!row) return null;
        return {
            provenance: row.provenance,
            prevChainHash: row.provenance_prev_chain_hash,
            chainHash: row.provenance_chain_hash,
            signature: row.provenance_signature,
        };
    });
}

// --- Data model: LLM usage ledger ---

/**
 * Per-quantity ledger totals over one group of calls.
 *
 * Each token quantity is absent when NO row in the group reported it — `SUM()` skips NULLs and
 * returns NULL for an all-absent group, and that NULL is carried through as an absent key rather than
 * flattened to `0`, so "the provider never reported cache reads" stays distinguishable from "the
 * provider reported zero cache reads". The five are breakdowns of one another (cache and reasoning
 * counts are details *of* the input and output counts), so nothing adds them together — consumption is
 * reported as an input figure and an output figure, never as one combined number.
 *
 * `calls` is how many ledger rows the group holds. It is what separates "no usage recorded" from
 * "calls recorded whose provider reported no figures", which the all-absent totals alone cannot say.
 */
export type LlmUsageTotals = {
    calls: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    reasoningTokens?: number;
};

/** One group of {@link LlmUsageTotals} keyed by the model that actually answered; `servedModelId` is `null` for calls whose endpoint reported no served model. */
export type LlmUsageByModel = {
    servedModelId: string | null;
    totals: LlmUsageTotals;
};

/** One group of {@link LlmUsageTotals} keyed by the agent that spent them — a sub-agent's calls group under its own id. */
export type LlmUsageByAgent = {
    agentId: string;
    totals: LlmUsageTotals;
};

/** An aggregate row of `llm_usage`. Every sum is nullable because SQLite's `SUM()` yields NULL over a group in which the quantity was never reported. */
type LlmUsageTotalsRow = {
    calls: number;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_creation_input_tokens: number | null;
    cache_read_input_tokens: number | null;
    reasoning_tokens: number | null;
};

function llmUsageTotalsFromRow(r: LlmUsageTotalsRow): LlmUsageTotals {
    // Each quantity is written only when the sum is non-NULL, so an unreported one comes back as an
    // ABSENT key. `?? 0` here would be the exact defect the nullable columns exist to prevent.
    const totals: LlmUsageTotals = { calls: r.calls };
    if (r.input_tokens !== null) totals.inputTokens = r.input_tokens;
    if (r.output_tokens !== null) totals.outputTokens = r.output_tokens;
    if (r.cache_creation_input_tokens !== null) totals.cacheCreationInputTokens = r.cache_creation_input_tokens;
    if (r.cache_read_input_tokens !== null) totals.cacheReadInputTokens = r.cache_read_input_tokens;
    if (r.reasoning_tokens !== null) totals.reasoningTokens = r.reasoning_tokens;
    return totals;
}

// Aliased to the underlying column names so one row type and one mapper serve the total and both
// breakdowns. Each quantity is summed on its own — there is deliberately no expression here that
// combines two of them.
const LLM_USAGE_TOTAL_COLS = `COUNT(*) AS calls,
     SUM(input_tokens) AS input_tokens,
     SUM(output_tokens) AS output_tokens,
     SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
     SUM(cache_read_input_tokens) AS cache_read_input_tokens,
     SUM(reasoning_tokens) AS reasoning_tokens`;

// The ledger stores the harness `Scope` discriminant alongside the workload id, so a per-analysis read
// has to name the variant it wants. Must stay equal to the analysis variant's `kind` in the harness's
// Scope union, which is what the recorder writes into the column.
const ANALYSIS_SCOPE = "analysis";

/**
 * What one analysis has consumed across every recorded call.
 *
 * Rows are matched by scope id alone, with no join to `analyses`, so an analysis the user has since
 * deleted still reports its spend and — equally — another analysis's rows can never leak into this
 * one. An analysis with no rows at all reads back as `calls: 0` with every quantity absent; that is a
 * legitimate answer, not a miss, which is why this returns totals rather than `T | null`.
 */
export function getAnalysisUsageTotals(analysisId: string): Result<LlmUsageTotals, DbError> {
    return tryQuery("getAnalysisUsageTotals", (conn) => {
        // A bare aggregate with no GROUP BY always yields exactly one row (all-NULL sums over an empty
        // set), so the non-null assertion in the cast holds unconditionally.
        const row = conn
            .query(`SELECT ${LLM_USAGE_TOTAL_COLS} FROM llm_usage WHERE scope_kind = ? AND scope_id = ?`)
            .get(ANALYSIS_SCOPE, analysisId) as LlmUsageTotalsRow;
        return llmUsageTotalsFromRow(row);
    });
}

/**
 * An analysis's consumption broken down by the model that actually served each call — the answer to
 * "which model spent this". Ordered by the served id for a stable report; SQLite sorts the NULL group
 * (calls whose endpoint reported no served model) first. Empty when the analysis has no rows.
 */
export function listAnalysisUsageByModel(analysisId: string): Result<LlmUsageByModel[], DbError> {
    return tryQuery("listAnalysisUsageByModel", (conn) => {
        const rows = conn
            .query(
                `SELECT served_model_id, ${LLM_USAGE_TOTAL_COLS}
                 FROM llm_usage WHERE scope_kind = ? AND scope_id = ?
                 GROUP BY served_model_id ORDER BY served_model_id`,
            )
            .all(ANALYSIS_SCOPE, analysisId) as (LlmUsageTotalsRow & { served_model_id: string | null })[];
        return rows.map((r) => ({ servedModelId: r.served_model_id, totals: llmUsageTotalsFromRow(r) }));
    });
}

/**
 * An analysis's consumption broken down by the agent that made each call — the answer to "which agent
 * spent this", with sub-agent loops appearing under their own ids. Ordered by agent id for a stable
 * report. Empty when the analysis has no rows.
 */
export function listAnalysisUsageByAgent(analysisId: string): Result<LlmUsageByAgent[], DbError> {
    return tryQuery("listAnalysisUsageByAgent", (conn) => {
        const rows = conn
            .query(
                `SELECT agent_id, ${LLM_USAGE_TOTAL_COLS}
                 FROM llm_usage WHERE scope_kind = ? AND scope_id = ?
                 GROUP BY agent_id ORDER BY agent_id`,
            )
            .all(ANALYSIS_SCOPE, analysisId) as (LlmUsageTotalsRow & { agent_id: string })[];
        return rows.map((r) => ({ agentId: r.agent_id, totals: llmUsageTotalsFromRow(r) }));
    });
}
