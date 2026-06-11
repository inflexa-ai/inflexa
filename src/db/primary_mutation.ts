import type { Result } from "neverthrow";
import { newId, tryMutation } from "./util.ts";
import type { DbError } from "./errors.ts";
import type { Session, Message, Part, TextPart } from "../types.ts";

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
