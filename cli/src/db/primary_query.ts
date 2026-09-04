import { type Result } from "neverthrow";
// The data profile's synthetic run id, imported so the CLI never writes it: the harness authors the
// value where it stamps the frame, and a copy here would keep compiling through a rename there —
// silently returning the profile's rows to the run grouping as an unnamed run, which is the exact
// defect the exclusion below removes.
//
// Reached through the `contracts/` subpath rather than the package barrel on weight alone. This
// module is loaded by essentially every text command and costs ~5ms on its own, while the barrel
// evaluates the whole harness graph (~735ms measured) and the workflow that STAMPS this literal
// drags in DBOS and the profiler agent graph (~118ms) — a price no reader of the string should pay,
// least of all `inflexa usage`, which is documented as answering with the engine cold. `contracts/`
// is dependency-free by construction, so this import costs nothing measurable. The barrel re-exports
// the same constant; that export is the contract, this is the access path.
import { DATA_PROFILE_RUN_LITERAL } from "@inflexa-ai/harness/contracts/data-profile.js";
import type { StoreEcosystem, StoreFlightRow, StoreFlightStatus, TransferKind, TransferPhase, TransferRow, TransferStatus } from "../types/store.ts";
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

/** One group of {@link LlmUsageTotals} keyed by the conversation thread the calls ran under — the chat-turn grain. */
export type LlmUsageBySession = {
    threadId: string;
    totals: LlmUsageTotals;
};

/** One group of {@link LlmUsageTotals} keyed by the run the calls ran under. */
export type LlmUsageByRun = {
    runId: string;
    totals: LlmUsageTotals;
};

/**
 * One group of {@link LlmUsageTotals} keyed by the step within ONE run. `stepId` is `null` for the
 * run's calls that ran outside any step (the plan/synthesis frames the run owns directly), which is an
 * absence of a step rather than a step named this.
 */
export type LlmUsageByStep = {
    stepId: string | null;
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
 * The grain reads' row order: lexicographic over the quantities AS REPORTED, biggest first.
 *
 * There is deliberately no single magnitude to sort on. The cache counts are a breakdown OF
 * `input_tokens` and the reasoning count a breakdown OF `output_tokens`, so any expression combining
 * them would rank a group by a number that counts its cached prefix twice — the exact figure no
 * surface here is allowed to construct. Input leads because it is the quantity that dominates
 * consumption in practice: a group reporting 42.6k in and 40 out is a large consumer an output-led
 * sort would bury. The call count breaks the remaining ties so the order is total and stable.
 *
 * The aggregates are repeated rather than referenced by output alias: `input_tokens` names both a
 * table column and this query's alias for its sum, and spelling out `SUM(...)` leaves no room for that
 * ambiguity to be resolved the wrong way. SQLite sorts NULL below every value, so DESC puts a group
 * whose provider reported nothing last — which is where a group that measured nothing belongs.
 */
const LLM_USAGE_GRAIN_ORDER = "ORDER BY SUM(input_tokens) DESC, SUM(output_tokens) DESC, COUNT(*) DESC";

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
 * The same headline as {@link getAnalysisUsageTotals}, for SEVERAL analyses in one round trip — what a
 * picker listing analyses side by side needs, so it does not issue a query per row it draws.
 *
 * Keyed by analysis id rather than returned as a list of groups because the caller's access pattern is
 * a lookup per rendered row; a list would only be scanned back into one. The map is TOTAL over
 * `analysisIds`: an analysis with no ledger rows is present with `calls: 0` and every quantity absent,
 * so this answers exactly what one {@link getAnalysisUsageTotals} call per id would, and a caller never
 * has to decide whether a missing key means "nothing recorded" or "id not asked for". Duplicate ids
 * collapse, as a keyed answer must.
 *
 * An empty list short-circuits without touching the database — `IN ()` is a syntax error in SQLite,
 * and there is nothing to ask anyway.
 */
export function listUsageTotalsByAnalysis(analysisIds: readonly string[]): Result<Map<string, LlmUsageTotals>, DbError> {
    return tryQuery("listUsageTotalsByAnalysis", (conn) => {
        // Seeded before the query so the map is total over the input, not over the rows that came back.
        const totals = new Map<string, LlmUsageTotals>(analysisIds.map((id) => [id, { calls: 0 }]));
        if (totals.size === 0) return totals;

        // One placeholder per DISTINCT id (the map already deduped), which keeps the bound-parameter
        // count at the smallest it can be. SQLite's ceiling is 32766 parameters — far above any list a
        // picker draws, and a caller handing over more would fail loudly rather than silently truncate.
        // TODO(robustness): chunk the ids if a caller ever legitimately needs more than that.
        const ids = [...totals.keys()];
        const rows = conn
            .query(
                `SELECT scope_id, ${LLM_USAGE_TOTAL_COLS}
                 FROM llm_usage WHERE scope_kind = ? AND scope_id IN (${ids.map(() => "?").join(", ")})
                 GROUP BY scope_id`,
            )
            .all(ANALYSIS_SCOPE, ...ids) as (LlmUsageTotalsRow & { scope_id: string })[];
        for (const r of rows) totals.set(r.scope_id, llmUsageTotalsFromRow(r));
        return totals;
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

// --- Data model: the ledger's where-it-ran grains ---
//
// Four reads that partition ONE analysis's rows by the frame each call ran in — chat turns under their
// session, run work under its run, the data profile under itself, and everything else under neither.
// The partition is closed by construction and the predicates below are what close it:
//
//   sessions      thread_id IS NOT NULL AND run_id IS NULL
//   runs          run_id IS NOT NULL AND run_id <> DATA_PROFILE_RUN_LITERAL
//   data profile  run_id = DATA_PROFILE_RUN_LITERAL
//   unattributed  thread_id IS NULL AND run_id IS NULL
//
// Every row satisfies exactly one, so the four summed per quantity equal the analysis headline and no
// call is counted twice. The recorder does not write both discriminators today (a chat turn carries a
// thread, a run frame carries a run), but a session read of "thread_id IS NOT NULL" alone would depend
// on that staying true forever; excluding run rows there makes the disjointness a property of THIS
// query rather than of the writer, and matches the rule the design pins — a call belongs to the frame
// it ran in, so a run launched from a chat reports under the run.
//
// The profile rides the same `run_id` column but is NOT a run: it has no `cortex_runs` row, no run
// listing shows it, and the sidebar has always drawn DATA PROFILE and RUNS as separate entities — only
// this one column conflates them, and left in the run grouping it produced a row a reader could not
// cross-reference against anything. Splitting it out here rather than relabelling it at each surface
// is what keeps "by run" meaning runs at every future call site.
//
// Each is constrained to one analysis, which is what keeps `idx_llm_usage_scope` the selective index:
// `thread_id`/`run_id`/`step_id` carry no index of their own, and the group-by then runs over one
// analysis's rows rather than the table. That is a deliberate trade (design "Risks"), not an oversight
// — an index nothing else reads would be cost without a reader.

/**
 * An analysis's consumption broken down by the conversation thread its chat turns ran under.
 *
 * A session's figures cover its OWN turns only: a run launched from that conversation reports under
 * the run, because attribution follows the frame the call ran in and a run-frame call has no thread to
 * sum under a session even in principle. Empty when the analysis has never had a chat turn recorded.
 */
export function listAnalysisUsageBySession(analysisId: string): Result<LlmUsageBySession[], DbError> {
    return tryQuery("listAnalysisUsageBySession", (conn) => {
        const rows = conn
            .query(
                `SELECT thread_id, ${LLM_USAGE_TOTAL_COLS}
                 FROM llm_usage WHERE scope_kind = ? AND scope_id = ? AND thread_id IS NOT NULL AND run_id IS NULL
                 GROUP BY thread_id ${LLM_USAGE_GRAIN_ORDER}`,
            )
            .all(ANALYSIS_SCOPE, analysisId) as (LlmUsageTotalsRow & { thread_id: string })[];
        return rows.map((r) => ({ threadId: r.thread_id, totals: llmUsageTotalsFromRow(r) }));
    });
}

/**
 * An analysis's consumption broken down by the run its calls ran under — the answer to "which run
 * spent this". Rows carrying no run are excluded here and reported by the session and unattributed
 * reads instead. Empty when the analysis has never run one.
 *
 * The data profile is excluded too, and reported by {@link getAnalysisDataProfileUsageTotals}: it is
 * the one other thing the ledger's `run_id` column carries, and it is not a run.
 */
export function listAnalysisUsageByRun(analysisId: string): Result<LlmUsageByRun[], DbError> {
    return tryQuery("listAnalysisUsageByRun", (conn) => {
        const rows = conn
            .query(
                `SELECT run_id, ${LLM_USAGE_TOTAL_COLS}
                 FROM llm_usage WHERE scope_kind = ? AND scope_id = ? AND run_id IS NOT NULL AND run_id <> ?
                 GROUP BY run_id ${LLM_USAGE_GRAIN_ORDER}`,
            )
            .all(ANALYSIS_SCOPE, analysisId, DATA_PROFILE_RUN_LITERAL) as (LlmUsageTotalsRow & { run_id: string })[];
        return rows.map((r) => ({ runId: r.run_id, totals: llmUsageTotalsFromRow(r) }));
    });
}

/**
 * ONE run's totals — what a run row shows beside its own status and timings, without the caller
 * pulling the whole run grouping to find a single row in it.
 *
 * Answers about the run id it is HANDED, with no data-profile exclusion: the exclusion belongs to the
 * read that enumerates runs, where a profile row is a row a reader cannot cross-reference. A caller
 * that names a frame is asking about that frame, and silently zeroing one id would be the more
 * surprising behaviour by far. {@link getAnalysisDataProfileUsageTotals} is the named way to ask for
 * the profile's; nothing stops this read answering the same question, it just does not advertise it.
 *
 * `analysisId` is what keeps the read on `idx_llm_usage_scope` — `run_id` carries no index of its own
 * — and, as everywhere else here, attribution is by scope rather than by a join. Always answers: a run
 * with no recorded calls reads back as `calls: 0` with every quantity absent.
 */
export function getRunUsageTotals(analysisId: string, runId: string): Result<LlmUsageTotals, DbError> {
    return tryQuery("getRunUsageTotals", (conn) => {
        // A bare aggregate with no GROUP BY always yields exactly one row (all-NULL sums over an empty
        // set), so the cast holds unconditionally — same guarantee as getAnalysisUsageTotals.
        const row = conn
            .query(
                `SELECT ${LLM_USAGE_TOTAL_COLS}
                 FROM llm_usage WHERE scope_kind = ? AND scope_id = ? AND run_id = ?`,
            )
            .get(ANALYSIS_SCOPE, analysisId, runId) as LlmUsageTotalsRow;
        return llmUsageTotalsFromRow(row);
    });
}

/**
 * ONE run's consumption broken down by step. Scoped to that run, so another run's steps cannot appear
 * even when both runs share a step id — plan step ids are slugs (`s2_align`), unique only within their
 * plan, so the run predicate is what makes a step id mean one thing here.
 *
 * `analysisId` is not redundant with `runId`: it is what keeps the read on the scope index rather than
 * scanning the whole ledger for an unindexed `run_id`, and it is the same guard the other reads use —
 * rows are attributed by scope, never by a join.
 *
 * Groups by step within ONE named run rather than over runs, so the data-profile exclusion does not
 * apply here — there is no list of runs for a profile row to appear in.
 */
export function listRunUsageByStep(analysisId: string, runId: string): Result<LlmUsageByStep[], DbError> {
    return tryQuery("listRunUsageByStep", (conn) => {
        const rows = conn
            .query(
                `SELECT step_id, ${LLM_USAGE_TOTAL_COLS}
                 FROM llm_usage WHERE scope_kind = ? AND scope_id = ? AND run_id = ?
                 GROUP BY step_id ${LLM_USAGE_GRAIN_ORDER}`,
            )
            .all(ANALYSIS_SCOPE, analysisId, runId) as (LlmUsageTotalsRow & { step_id: string | null })[];
        return rows.map((r) => ({ stepId: r.step_id, totals: llmUsageTotalsFromRow(r) }));
    });
}

/**
 * What an analysis's DATA PROFILE consumed — the grain the profile's rows report under now that they
 * no longer appear among the runs.
 *
 * A grain rather than a group list: the profile runs at most once per analysis, so there is nothing to
 * enumerate, and the ledger identifies its calls by a single synthetic run id the harness stamps
 * (`DATA_PROFILE_RUN_LITERAL`) rather than by anything the CLI mints.
 *
 * The profile carries no thread, so it belongs to no session and cannot be folded into one even in
 * principle — its figures have exactly one home, which is this read. Always answers, like
 * {@link getAnalysisUsageTotals}: an analysis that has never profiled reads back as `calls: 0` with
 * every quantity absent, which is a legitimate report rather than a miss.
 */
export function getAnalysisDataProfileUsageTotals(analysisId: string): Result<LlmUsageTotals, DbError> {
    return tryQuery("getAnalysisDataProfileUsageTotals", (conn) => {
        // A bare aggregate with no GROUP BY always yields exactly one row (all-NULL sums over an empty
        // set), so the cast holds unconditionally — same guarantee as getAnalysisUsageTotals.
        const row = conn
            .query(
                `SELECT ${LLM_USAGE_TOTAL_COLS}
                 FROM llm_usage WHERE scope_kind = ? AND scope_id = ? AND run_id = ?`,
            )
            .get(ANALYSIS_SCOPE, analysisId, DATA_PROFILE_RUN_LITERAL) as LlmUsageTotalsRow;
        return llmUsageTotalsFromRow(row);
    });
}

/**
 * What an analysis consumed in calls belonging to NEITHER a session nor a run — background and
 * boot-time work, which runs under an analysis scope carrying no frame of either kind.
 *
 * This is the last bucket that makes the breakdown close. Without it the session, run, and data-profile
 * figures need not reach the headline, and consumption present in a total but absent from every part
 * beneath it reads as a defect in the ledger; naming it is strictly better than hiding it. Like
 * {@link getAnalysisUsageTotals} it always answers — no such calls reads back as `calls: 0` with every
 * quantity absent, which is a legitimate report, not a miss.
 */
export function getAnalysisUnattributedUsageTotals(analysisId: string): Result<LlmUsageTotals, DbError> {
    return tryQuery("getAnalysisUnattributedUsageTotals", (conn) => {
        // A bare aggregate with no GROUP BY always yields exactly one row (all-NULL sums over an empty
        // set), so the cast holds unconditionally — same guarantee as getAnalysisUsageTotals.
        const row = conn
            .query(
                `SELECT ${LLM_USAGE_TOTAL_COLS}
                 FROM llm_usage WHERE scope_kind = ? AND scope_id = ? AND thread_id IS NULL AND run_id IS NULL`,
            )
            .get(ANALYSIS_SCOPE, analysisId) as LlmUsageTotalsRow;
        return llmUsageTotalsFromRow(row);
    });
}

// --- Data model: one conversation and the work it launched ---
//
// The reads below answer a DIFFERENT question from the session grain above, over the same column. All
// three match `thread_id = ?` and nothing else, so a run launched from that conversation is INCLUDED —
// the recorder stamps a run's calls with the thread that started them, which is what makes the fold
// possible at all.
//
//   session grain      thread_id = ? AND run_id IS NULL   the conversation's own turns
//   these reads        thread_id = ?                      the conversation and everything it launched
//
// The two are not a discrepancy to reconcile: they differ by the whole of a run, which in a real
// ledger was 11.1k input against 820.3k. The grain reads partition the analysis headline, so a session
// there must not absorb work that also reports under a run. These reads have no total to reconcile
// against and one question to answer — "what has this conversation cost" — where reporting the 11.1k
// moments after the user watched the 809.2k be spent would be wrong rather than conservative. Each
// surface says which reading it shows; the hazard was never that both exist, it is both being called
// "session usage" without saying so.

/**
 * ONE conversation's total consumption, the runs it launched INCLUDED.
 *
 * Deliberately not the same number as this thread's group in {@link listAnalysisUsageBySession}, which
 * covers the conversation's own turns ONLY so the grains still partition the analysis headline. The two
 * differ by the whole of every run the conversation started — a factor of 74 in the ledger this was
 * designed against (11.1k in / 2.9k out for the turns, 820.3k / 43.3k with the run folded in). Neither
 * is a bug; read the section note above before "fixing" one to match the other.
 *
 * Always answers: a thread with no recorded calls reads back as `calls: 0` with every quantity absent.
 */
export function getSessionUsageTotalsIncludingRuns(analysisId: string, threadId: string): Result<LlmUsageTotals, DbError> {
    return tryQuery("getSessionUsageTotalsIncludingRuns", (conn) => {
        // A bare aggregate with no GROUP BY always yields exactly one row (all-NULL sums over an empty
        // set), so the cast holds unconditionally — same guarantee as getAnalysisUsageTotals.
        const row = conn
            .query(
                `SELECT ${LLM_USAGE_TOTAL_COLS}
                 FROM llm_usage WHERE scope_kind = ? AND scope_id = ? AND thread_id = ?`,
            )
            .get(ANALYSIS_SCOPE, analysisId, threadId) as LlmUsageTotalsRow;
        return llmUsageTotalsFromRow(row);
    });
}

/**
 * ONE conversation's consumption broken down by the model that actually served each call, runs
 * included — {@link listAnalysisUsageByModel} narrowed from the analysis to a single thread.
 *
 * Scoped by analysis AND thread: the analysis predicate is what keeps the read on
 * `idx_llm_usage_scope` (`thread_id` carries no index), and a thread id is unique enough that the pair
 * is belt and braces rather than a correctness requirement — which is exactly why it costs nothing to
 * keep. Ordered by the served id, matching its analysis-wide twin so the two render identically at
 * different scopes; SQLite sorts the NULL group (calls whose endpoint reported no served model) first.
 * Empty when the thread has no rows.
 */
export function listSessionUsageByModel(analysisId: string, threadId: string): Result<LlmUsageByModel[], DbError> {
    return tryQuery("listSessionUsageByModel", (conn) => {
        const rows = conn
            .query(
                `SELECT served_model_id, ${LLM_USAGE_TOTAL_COLS}
                 FROM llm_usage WHERE scope_kind = ? AND scope_id = ? AND thread_id = ?
                 GROUP BY served_model_id ORDER BY served_model_id`,
            )
            .all(ANALYSIS_SCOPE, analysisId, threadId) as (LlmUsageTotalsRow & { served_model_id: string | null })[];
        return rows.map((r) => ({ servedModelId: r.served_model_id, totals: llmUsageTotalsFromRow(r) }));
    });
}

/**
 * ONE conversation's consumption broken down by the agent that made each call, runs included — the
 * grouping that shows a run's sub-agent loops under their own ids rather than under the conversation
 * that started them. {@link listAnalysisUsageByAgent} narrowed from the analysis to a single thread,
 * ordered by agent id to match it. Empty when the thread has no rows.
 */
export function listSessionUsageByAgent(analysisId: string, threadId: string): Result<LlmUsageByAgent[], DbError> {
    return tryQuery("listSessionUsageByAgent", (conn) => {
        const rows = conn
            .query(
                `SELECT agent_id, ${LLM_USAGE_TOTAL_COLS}
                 FROM llm_usage WHERE scope_kind = ? AND scope_id = ? AND thread_id = ?
                 GROUP BY agent_id ORDER BY agent_id`,
            )
            .all(ANALYSIS_SCOPE, analysisId, threadId) as (LlmUsageTotalsRow & { agent_id: string })[];
        return rows.map((r) => ({ agentId: r.agent_id, totals: llmUsageTotalsFromRow(r) }));
    });
}

// --- Data model: the package-store transfers ---

/**
 * The columns of `transfers`, in the house order: identity, then core data. The table has no foreign
 * key, and the id IS the transfer kind — one row per kind.
 */
const TRANSFER_COLS = "id, created_at, updated_at, state, bytes_transferred, total_bytes, layers_completed, total_layers, digest, message, holder_pid, phase";

/** A row of the columnar `transfers` table — one typed column per field, so a reader filters on the state in SQL. */
type TransferDbRow = {
    id: string;
    created_at: number;
    updated_at: number;
    state: string;
    bytes_transferred: number;
    total_bytes: number | null;
    layers_completed: number;
    total_layers: number | null;
    digest: string | null;
    message: string | null;
    holder_pid: number | null;
    phase: string | null;
};

function transferFromRow(r: TransferDbRow): TransferRow {
    return {
        // Each of the three cast columns carries a CHECK constraint that names exactly the members of its
        // union, thus SQLite refuses any other value and no cast can widen. `phase` also permits NULL,
        // which the union carries as its own member.
        id: r.id as TransferKind,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        state: r.state as TransferStatus,
        bytesTransferred: r.bytes_transferred,
        totalBytes: r.total_bytes,
        layersCompleted: r.layers_completed,
        totalLayers: r.total_layers,
        digest: r.digest,
        message: r.message,
        holderPid: r.holder_pid,
        phase: r.phase as TransferPhase | null,
    };
}

/**
 * The transfer row of one kind, or `null` when no transfer of that kind ever ran on this machine.
 *
 * Absence rides the ok channel, never the error channel: an image or a store can arrive by a route
 * that wrote no row, and such a machine is completely usable. The read takes no lock — the database
 * runs in WAL mode, thus this never blocks the live child.
 */
export function getTransfer(kind: TransferKind): Result<TransferRow | null, DbError> {
    return tryQuery("getTransfer", (conn) => {
        const row = conn.query(`SELECT ${TRANSFER_COLS} FROM transfers WHERE id = ?`).get(kind) as TransferDbRow | null;
        return row ? transferFromRow(row) : null;
    });
}

/** Every transfer row, in the fixed kind order. A kind with no row is simply absent. */
export function listTransfers(): Result<TransferRow[], DbError> {
    return tryQuery("listTransfers", (conn) => {
        const rows = conn.query(`SELECT ${TRANSFER_COLS} FROM transfers ORDER BY id`).all() as TransferDbRow[];
        return rows.map(transferFromRow);
    });
}

// --- Data model: the package-store acquisition flights ---

/** The columns of `package_store_flights`, in the house order: identity, then core data. The table has no foreign key. */
const STORE_FLIGHT_COLS = "id, created_at, updated_at, state, ecosystem, spelling, specifier, progress, message, holder_pid";

/** A row of the columnar `package_store_flights` table — one typed column for each field, so a reader filters on the state in SQL. */
type StoreFlightDbRow = {
    id: string;
    created_at: number;
    updated_at: number;
    state: string;
    ecosystem: string | null;
    spelling: string;
    specifier: string;
    progress: string | null;
    message: string | null;
    holder_pid: number;
};

function storeFlightFromRow(r: StoreFlightDbRow): StoreFlightRow {
    return {
        id: r.id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        // Each of the two columns carries a CHECK constraint that names exactly the members of its union,
        // thus SQLite refuses any other value and neither cast can widen.
        state: r.state as StoreFlightStatus,
        ecosystem: r.ecosystem as StoreEcosystem | null,
        spelling: r.spelling,
        specifier: r.specifier,
        progress: r.progress,
        message: r.message,
        holderPid: r.holder_pid,
    };
}

/** One flight row, or `null` when no process owns a flight for that key. Absence rides the ok channel, because no flight is a normal state. */
export function getStoreFlight(id: string): Result<StoreFlightRow | null, DbError> {
    return tryQuery("getStoreFlight", (conn) => {
        const row = conn.query(`SELECT ${STORE_FLIGHT_COLS} FROM package_store_flights WHERE id = ?`).get(id) as StoreFlightDbRow | null;
        return row ? storeFlightFromRow(row) : null;
    });
}

/** One flight row joined to one subscription of it, so the whole readout comes from a single query. */
type StoreFlightWithSubscriberRow = StoreFlightDbRow & { analysis_id: string | null };

/**
 * Every flight row with the analyses subscribed to it, oldest flight first.
 *
 * ONE query with a LEFT JOIN, then a group in JS: the readout wants the two facts together, and a read
 * of each flight and then of its subscriptions would be a round trip for each row. A LEFT JOIN keeps a
 * flight whose only subscriber cancelled, which is exactly the state the owner is about to act on.
 *
 * A `null` analysis id is a subscription that belongs to no analysis — a plain `inflexa store add` in a
 * terminal — and it is dropped from the named set rather than reported as an unnamed analysis.
 */
export function listStoreFlights(): Result<{ flight: StoreFlightRow; analysisIds: readonly string[] }[], DbError> {
    return tryQuery("listStoreFlights", (conn) => {
        const rows = conn
            .query(
                `SELECT ${STORE_FLIGHT_COLS.split(", ")
                    .map((c) => `f.${c} AS ${c}`)
                    .join(", ")}, s.analysis_id AS analysis_id
                 FROM package_store_flights f
                 LEFT JOIN package_store_flight_subscriptions s ON s.flight_id = f.id
                 ORDER BY f.created_at, s.analysis_id`,
            )
            .all() as StoreFlightWithSubscriberRow[];
        const grouped: { flight: StoreFlightRow; analysisIds: string[] }[] = [];
        const byId = new Map<string, { flight: StoreFlightRow; analysisIds: string[] }>();
        for (const row of rows) {
            let entry = byId.get(row.id);
            if (entry === undefined) {
                entry = { flight: storeFlightFromRow(row), analysisIds: [] };
                byId.set(row.id, entry);
                grouped.push(entry);
            }
            if (row.analysis_id !== null) entry.analysisIds.push(row.analysis_id);
        }
        return grouped;
    });
}

/** How many subscriptions a flight still carries. The owner stops the flight when this reaches zero. */
export function countStoreFlightSubscribers(flightId: string): Result<number, DbError> {
    return tryQuery("countStoreFlightSubscribers", (conn) => {
        const row = conn.query("SELECT COUNT(*) AS n FROM package_store_flight_subscriptions WHERE flight_id = ?").get(flightId) as { n: number } | null;
        return row?.n ?? 0;
    });
}

/**
 * Whether one subscriber still holds a subscription to a flight.
 *
 * A subscriber that waits on somebody else's flight asks this: a cancel removed its own subscription
 * while the flight goes on for another analysis, and only this answer separates that from the flight
 * ending. The two branches are one statement each, because SQLite compares a bound NULL with `=` as
 * unknown and the terminal subscription would never match.
 */
export function hasStoreFlightSubscriber(params: { flightId: string; analysisId: string | null }): Result<boolean, DbError> {
    return tryQuery("hasStoreFlightSubscriber", (conn) => {
        const row = (
            params.analysisId === null
                ? conn.query("SELECT COUNT(*) AS n FROM package_store_flight_subscriptions WHERE flight_id = ? AND analysis_id IS NULL").get(params.flightId)
                : conn
                      .query("SELECT COUNT(*) AS n FROM package_store_flight_subscriptions WHERE flight_id = ? AND analysis_id = ?")
                      .get(params.flightId, params.analysisId)
        ) as { n: number } | null;
        return (row?.n ?? 0) > 0;
    });
}

// --- Data model: the pending set of `inflexa store add` ---

/** A row of the columnar `pending_store_adds` table. */
type PendingStoreAddDbRow = {
    id: string;
    created_at: number;
    spelling: string;
    specifier: string;
    ecosystem: string | null;
    analysis_id: string | null;
};

/** One enqueued add of the pending set. */
export type PendingStoreAdd = {
    readonly id: string;
    readonly createdAt: number;
    /** The spelling of the request, verbatim — the installer ref and the render both need it. */
    readonly spelling: string;
    /** The exact-version specifier (`==<v>`), or an empty string for the newest. */
    readonly specifier: string;
    /** The ecosystem when the add named one, or `null` for a name the acquire run resolves. */
    readonly ecosystem: StoreEcosystem | null;
    /** The analysis whose farm the add extends after the commit, or `null` for a terminal add. */
    readonly analysisId: string | null;
};

/** Every pending add, oldest first. The flush claims through the mutation layer, and this is the read the surfaces use. */
export function listPendingStoreAdds(): Result<PendingStoreAdd[], DbError> {
    return tryQuery("listPendingStoreAdds", (conn) => {
        const rows = conn
            .query("SELECT id, created_at, spelling, specifier, ecosystem, analysis_id FROM pending_store_adds ORDER BY created_at, id")
            .all() as PendingStoreAddDbRow[];
        return rows.map((r) => ({
            id: r.id,
            createdAt: r.created_at,
            spelling: r.spelling,
            specifier: r.specifier,
            // The CHECK constraint names exactly the members of the union, thus the cast cannot widen.
            ecosystem: r.ecosystem as StoreEcosystem | null,
            analysisId: r.analysis_id,
        }));
    });
}
