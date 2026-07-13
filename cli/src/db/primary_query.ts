import { type Result } from "neverthrow";
import type { DbError } from "./errors.ts";
import type { Session, Part, StoredMessage } from "../types/session.ts";
import type { Anchor } from "../types/anchor.ts";
import type { Project } from "../types/project.ts";
import type { Analysis, AnalysisInput } from "../types/analysis.ts";
import { asStr256, type IdOrName } from "../lib/types.ts";
import { tryQuery } from "./util.ts";

/** Loads a session by id; `null` when there is no such row. */
export function getSession(id: string): Result<Session | null, DbError> {
    return tryQuery("getSession", (conn) => {
        const row = conn.query("SELECT data FROM sessions WHERE id = ?").get(id) as { data: string } | null;
        return row ? (JSON.parse(row.data) as Session) : null;
    });
}

/** All sessions, newest first. */
export function listSessions(): Result<Session[], DbError> {
    return tryQuery("listSessions", (conn) => {
        const rows = conn.query("SELECT data FROM sessions ORDER BY id DESC").all() as { data: string }[];
        return rows.map((r) => JSON.parse(r.data) as Session);
    });
}

/** A session's messages, oldest first, each with its parts assembled in order. */
export function listSessionMessages(sessionId: string): Result<StoredMessage[], DbError> {
    return tryQuery("listSessionMessages", (conn) => {
        const msgRows = conn.query("SELECT id, data FROM messages WHERE session_id = ? ORDER BY id ASC").all(sessionId) as {
            id: string;
            data: string;
        }[];

        const partRows = conn.query("SELECT message_id, data FROM parts WHERE session_id = ? ORDER BY id ASC").all(sessionId) as {
            message_id: string;
            data: string;
        }[];

        const partsByMsg = new Map<string, Part[]>();
        for (const r of partRows) {
            const arr = partsByMsg.get(r.message_id) ?? [];
            arr.push(JSON.parse(r.data) as Part);
            partsByMsg.set(r.message_id, arr);
        }

        return msgRows.map((r) => ({
            info: JSON.parse(r.data),
            parts: partsByMsg.get(r.id) ?? [],
        }));
    });
}

/**
 * The newest `limit` messages of a session, oldest→newest, each with its parts assembled in order.
 * The UI window query: it bounds mounted layout cost (a `<scrollbox>` clips painting but not Yoga
 * layout, so cost scales with mounted count). The full-history {@link listSessionMessages} stays the
 * source for the model context the engine builds — only the view is capped.
 */
export function listRecentSessionMessages(sessionId: string, limit: number): Result<StoredMessage[], DbError> {
    return tryQuery("listRecentSessionMessages", (conn) => {
        // Newest-first + LIMIT picks the recent window in SQL (not a JS slice of the whole history);
        // reverse back to the oldest→newest order the stream renders in.
        const msgRows = (
            conn.query("SELECT id, data FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?").all(sessionId, limit) as {
                id: string;
                data: string;
            }[]
        ).reverse();

        if (msgRows.length === 0) return [];

        // Scope the parts fetch to the kept messages so a long history doesn't load every part just to
        // drop most of them. Placeholders are `?` (values bound via `.all`), so the id list is not interpolated.
        const ids = msgRows.map((r) => r.id);
        const placeholders = ids.map(() => "?").join(", ");
        const partRows = conn.query(`SELECT message_id, data FROM parts WHERE message_id IN (${placeholders}) ORDER BY id ASC`).all(...ids) as {
            message_id: string;
            data: string;
        }[];

        const partsByMsg = new Map<string, Part[]>();
        for (const r of partRows) {
            const arr = partsByMsg.get(r.message_id) ?? [];
            arr.push(JSON.parse(r.data) as Part);
            partsByMsg.set(r.message_id, arr);
        }

        return msgRows.map((r) => ({
            info: JSON.parse(r.data),
            parts: partsByMsg.get(r.id) ?? [],
        }));
    });
}

/** A session's chat belongs to one analysis; this lists every session under `analysisId`. The link lives in the `analysis_id` column (queried/joined), not the Session JSON. */
export function listSessionsByAnalysis(analysisId: string): Result<Session[], DbError> {
    return tryQuery("listSessionsByAnalysis", (conn) => {
        const rows = conn.query("SELECT data FROM sessions WHERE analysis_id = ?").all(analysisId) as { data: string }[];
        return rows.map((r) => JSON.parse(r.data) as Session);
    });
}

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
