import { randomUUIDv7 } from "bun";
import type { Result } from "neverthrow";
import { tryMutation } from "./util.ts";
import type { DbError } from "./errors.ts";
import type { Session, Message, Part, TextPart } from "../types/session.ts";
import type { Anchor } from "../types/anchor.ts";

/** Creates and persists a new session, defaulting the title when omitted. */
export function createSession(title?: string): Result<Session, DbError> {
    const session: Session = {
        id: randomUUIDv7(),
        title: title ?? "New session",
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    return tryMutation("createSession", (conn) => {
        conn.query("INSERT INTO sessions (id, data) VALUES (?, ?)").run(session.id, JSON.stringify(session));
        return session;
    });
}

/** Persists `session`, stamping a fresh `updatedAt` (mutates the argument). */
export function updateSession(session: Session): Result<void, DbError> {
    session.updatedAt = Date.now();
    return tryMutation("updateSession", (conn) => {
        conn.query("UPDATE sessions SET data = ? WHERE id = ?").run(JSON.stringify(session), session.id);
    });
}

/** Creates and persists an empty message turn for `role` in the session. */
export function createMessage(sessionId: string, role: "user" | "assistant"): Result<Message, DbError> {
    const msg: Message = {
        id: randomUUIDv7(),
        sessionId,
        role,
        createdAt: Date.now(),
    };

    return tryMutation("createMessage", (conn) => {
        conn.query("INSERT INTO messages (id, session_id, data) VALUES (?, ?, ?)").run(msg.id, msg.sessionId, JSON.stringify(msg));
        return msg;
    });
}

/** Creates and persists a text part under a message — the unit the assistant streams into. */
export function createPart(sessionId: string, messageId: string, text: string): Result<TextPart, DbError> {
    const part: TextPart = {
        id: randomUUIDv7(),
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

/** Persists a part's current text — called once the stream into it completes. */
export function updatePart(part: Part): Result<void, DbError> {
    return tryMutation("updatePart", (conn) => {
        conn.query("UPDATE parts SET data = ? WHERE id = ?").run(JSON.stringify(part), part.id);
    });
}

/**
 * Inserts a fully-formed anchor row. The caller supplies the id — rather than this
 * minting one like the session helpers — because an anchor's id is its write-once
 * marker id, which may already exist on disk and must be preserved, not regenerated.
 */
export function insertAnchor(anchor: Anchor): Result<Anchor, DbError> {
    return tryMutation("insertAnchor", (conn) => {
        conn.query("INSERT INTO anchors (id, created_at, updated_at, cached_path, marker_written, last_seen) VALUES (?, ?, ?, ?, ?, ?)").run(
            anchor.id,
            anchor.createdAt,
            anchor.updatedAt,
            anchor.cachedPath,
            anchor.markerWritten ? 1 : 0,
            anchor.lastSeen,
        );
        return anchor;
    });
}

/** Re-points an anchor at `cachedPath`. A real data edit, so it bumps `updatedAt`; the `lastSeen` heartbeat stays separate. */
export function updateAnchorCachedPath(id: string, cachedPath: string): Result<void, DbError> {
    return tryMutation("updateAnchorCachedPath", (conn) => {
        conn.query("UPDATE anchors SET cached_path = ?, updated_at = ? WHERE id = ?").run(cachedPath, Date.now(), id);
    });
}

/** Records a sighting heartbeat (`lastSeen`) only — deliberately does NOT touch `updatedAt`, the data-edit timestamp. */
export function touchAnchor(id: string): Result<void, DbError> {
    return tryMutation("touchAnchor", (conn) => {
        conn.query("UPDATE anchors SET last_seen = ? WHERE id = ?").run(Date.now(), id);
    });
}

/** Drops an anchor row by its id. A no-op when no such row exists. */
export function deleteAnchor(id: string): Result<void, DbError> {
    return tryMutation("deleteAnchor", (conn) => {
        conn.query("DELETE FROM anchors WHERE id = ?").run(id);
    });
}
