import { type Result } from "neverthrow";
import type { DbError } from "./errors.ts";
import type { Session, Part, StoredMessage } from "../types.ts";
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
