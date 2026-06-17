import { type Result } from "neverthrow";
import type { DbError } from "./errors.ts";
import type { Session, Part, StoredMessage } from "../types/session.ts";
import type { Anchor } from "../types/anchor.ts";
import type { Project } from "../types/project.ts";
import { asStr256 } from "../lib/types.ts";
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
    name: string;
    description: string | null;
    tags: string;
    created_at: number;
    updated_at: number;
};

function projectFromRow(r: ProjectRow): Project {
    return {
        id: r.id,
        // Trusted source: the name was validated through `str256` before it was ever stored.
        name: asStr256(r.name),
        description: r.description,
        // tags are stored comma-joined; they hold no commas (comma-split on input), so the round-trip is lossless.
        tags: r.tags ? r.tags.split(",").filter(Boolean) : [],
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

const PROJECT_COLS = "id, name, description, tags, created_at, updated_at";

/** Every project, newest first. */
export function listProjects(): Result<Project[], DbError> {
    return tryQuery("listProjects", (conn) => {
        const rows = conn.query(`SELECT ${PROJECT_COLS} FROM projects ORDER BY created_at DESC`).all() as ProjectRow[];
        return rows.map(projectFromRow);
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
