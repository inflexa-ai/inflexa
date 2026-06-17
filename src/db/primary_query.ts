import { type Result } from "neverthrow";
import type { DbError } from "./errors.ts";
import type { Session, Part, StoredMessage } from "../types/session.ts";
import type { Anchor } from "../types/anchor.ts";
import { tryQuery } from "./util.ts";

export function getSession(id: string): Result<Session | null, DbError> {
    return tryQuery("getSession", (conn) => {
        const row = conn.query("SELECT data FROM sessions WHERE id = ?").get(id) as { data: string } | null;
        return row ? (JSON.parse(row.data) as Session) : null;
    });
}

export function listSessions(): Result<Session[], DbError> {
    return tryQuery("listSessions", (conn) => {
        const rows = conn.query("SELECT data FROM sessions ORDER BY id DESC").all() as { data: string }[];
        return rows.map((r) => JSON.parse(r.data) as Session);
    });
}

export function getSessionMessages(sessionId: string): Result<StoredMessage[], DbError> {
    return tryQuery("getSessionMessages", (conn) => {
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

// Anchors are a columnar table (one typed column per field, not a JSON blob) so a
// folder's identity and cached path can be filtered and joined directly in SQL.
type AnchorRow = {
    id: string;
    cached_path: string;
    marker_written: number;
    created_at: number;
    updated_at: number;
    last_seen: number;
};

function anchorFromRow(r: AnchorRow): Anchor {
    return {
        id: r.id,
        cachedPath: r.cached_path,
        markerWritten: r.marker_written === 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        lastSeen: r.last_seen,
    };
}

const ANCHOR_COLS = "id, cached_path, marker_written, created_at, updated_at, last_seen";

export function getAnchor(id: string): Result<Anchor | null, DbError> {
    return tryQuery("getAnchor", (conn) => {
        const row = conn.query(`SELECT ${ANCHOR_COLS} FROM anchors WHERE id = ?`).get(id) as AnchorRow | null;
        return row ? anchorFromRow(row) : null;
    });
}

export function listAnchors(): Result<Anchor[], DbError> {
    return tryQuery("listAnchors", (conn) => {
        const rows = conn.query(`SELECT ${ANCHOR_COLS} FROM anchors`).all() as AnchorRow[];
        return rows.map(anchorFromRow);
    });
}
