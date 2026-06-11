import { db } from "./primary.ts";
import { newId } from "./util.ts";
import type { Session, Message, Part, TextPart } from "../types.ts";

export function createSession(title?: string): Session {
    const session: Session = {
        id: newId(),
        title: title ?? "New session",
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    db().prepare("INSERT INTO sessions (id, data) VALUES (?, ?)").run(session.id, JSON.stringify(session));
    return session;
}

export function updateSession(session: Session): void {
    session.updatedAt = Date.now();
    db().prepare("UPDATE sessions SET data = ? WHERE id = ?").run(JSON.stringify(session), session.id);
}

export function createMessage(sessionId: string, role: "user" | "assistant"): Message {
    const msg: Message = {
        id: newId(),
        sessionId,
        role,
        createdAt: Date.now(),
    };
    db().prepare("INSERT INTO messages (id, session_id, data) VALUES (?, ?, ?)").run(msg.id, msg.sessionId, JSON.stringify(msg));
    return msg;
}

export function createPart(sessionId: string, messageId: string, text: string): TextPart {
    const part: TextPart = {
        id: newId(),
        sessionId,
        messageId,
        type: "text",
        text,
        createdAt: Date.now(),
    };
    db().prepare("INSERT INTO parts (id, session_id, message_id, data) VALUES (?, ?, ?, ?)").run(part.id, part.sessionId, part.messageId, JSON.stringify(part));
    return part;
}

export function updatePart(part: Part): void {
    db().prepare("UPDATE parts SET data = ? WHERE id = ?").run(JSON.stringify(part), part.id);
}
