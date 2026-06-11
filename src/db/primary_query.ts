import { db } from "./primary.ts";
import type { Session, Part, StoredMessage } from "../types.ts";

export function getSession(id: string): Session | null {
    const row = db().prepare("SELECT data FROM sessions WHERE id = ?").get(id) as { data: string } | null;
    return row ? (JSON.parse(row.data) as Session) : null;
}

export function listSessions(): Session[] {
    const rows = db().prepare("SELECT data FROM sessions ORDER BY id DESC").all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Session);
}

export function getSessionMessages(sessionId: string): StoredMessage[] {
    const msgRows = db().prepare("SELECT id, data FROM messages WHERE session_id = ? ORDER BY id ASC").all(sessionId) as { id: string; data: string }[];

    const partRows = db().prepare("SELECT message_id, data FROM parts WHERE session_id = ? ORDER BY id ASC").all(sessionId) as {
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
}
