import type { Result } from "neverthrow";
import { newId, tryMutation } from "./util.ts";
import type { DbError } from "./errors.ts";
import type { Session, Message, Part, TextPart } from "../types/session.ts";
import type { Anchor } from "../types/anchor.ts";

export function createSession(title?: string): Result<Session, DbError> {
    const session: Session = {
        id: newId(),
        title: title ?? "New session",
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    return tryMutation("createSession", (conn) => {
        conn.query("INSERT INTO sessions (id, data) VALUES (?, ?)").run(session.id, JSON.stringify(session));
        return session;
    });
}

export function updateSession(session: Session): Result<void, DbError> {
    session.updatedAt = Date.now();
    return tryMutation("updateSession", (conn) => {
        conn.query("UPDATE sessions SET data = ? WHERE id = ?").run(JSON.stringify(session), session.id);
    });
}

export function createMessage(sessionId: string, role: "user" | "assistant"): Result<Message, DbError> {
    const msg: Message = {
        id: newId(),
        sessionId,
        role,
        createdAt: Date.now(),
    };

    return tryMutation("createMessage", (conn) => {
        conn.query("INSERT INTO messages (id, session_id, data) VALUES (?, ?, ?)").run(msg.id, msg.sessionId, JSON.stringify(msg));
        return msg;
    });
}

export function createPart(sessionId: string, messageId: string, text: string): Result<TextPart, DbError> {
    const part: TextPart = {
        id: newId(),
        sessionId,
        messageId,
        type: "text",
        text,
        createdAt: Date.now(),
    };
    return tryMutation("createPart", (conn) => {
        conn.query("INSERT INTO parts (id, session_id, message_id, data) VALUES (?, ?, ?, ?)").run(
            part.id,
            part.sessionId,
            part.messageId,
            JSON.stringify(part),
        );
        return part;
    });
}

export function updatePart(part: Part): Result<void, DbError> {
    return tryMutation("updatePart", (conn) => {
        conn.query("UPDATE parts SET data = ? WHERE id = ?").run(JSON.stringify(part), part.id);
    });
}

// Anchors. The caller supplies the row: an anchor's id is the marker UUID minted in
// the anchor module (crypto.randomUUID), not a ULID, so insert takes a full Anchor.
export function insertAnchor(anchor: Anchor): Result<Anchor, DbError> {
    return tryMutation("insertAnchor", (conn) => {
        conn.query("INSERT INTO anchors (id, cached_path, marker_written, created_at, updated_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)").run(
            anchor.id,
            anchor.cachedPath,
            anchor.markerWritten ? 1 : 0,
            anchor.createdAt,
            anchor.updatedAt,
            anchor.lastSeen,
        );
        return anchor;
    });
}

// cachedPath is a real data edit, so it bumps updated_at. lastSeen stays a separate heartbeat.
export function updateAnchorCachedPath(id: string, cachedPath: string): Result<void, DbError> {
    return tryMutation("updateAnchorCachedPath", (conn) => {
        conn.query("UPDATE anchors SET cached_path = ?, updated_at = ? WHERE id = ?").run(cachedPath, Date.now(), id);
    });
}

// A sighting heartbeat only — deliberately does NOT touch updated_at (the data-edit timestamp).
export function touchAnchor(id: string): Result<void, DbError> {
    return tryMutation("touchAnchor", (conn) => {
        conn.query("UPDATE anchors SET last_seen = ? WHERE id = ?").run(Date.now(), id);
    });
}
