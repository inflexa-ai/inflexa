import { bus } from "../bus.ts";
import * as store from "../db/store.ts";
import type { Message, TextPart } from "../types.ts";

export interface ChatOptions {
    sessionId: string;
    userText: string;
    abort?: AbortSignal;
}

export async function chat(opts: ChatOptions): Promise<void> {
    const { sessionId, userText, abort } = opts;

    bus.publish({ type: "session.status", sessionId, status: "busy" });

    const userMsg: Message = {
        id: store.newId(),
        sessionId,
        role: "user",
        createdAt: Date.now(),
    };
    store.createMessage(userMsg);

    const userPart: TextPart = {
        id: store.newId(),
        sessionId,
        messageId: userMsg.id,
        type: "text",
        text: userText,
        createdAt: Date.now(),
    };
    store.upsertPart(userPart);
    bus.publish({ type: "message.created", message: userMsg });
    bus.publish({ type: "part.updated", part: userPart });

    const assistantMsg: Message = {
        id: store.newId(),
        sessionId,
        role: "assistant",
        createdAt: Date.now(),
    };
    store.createMessage(assistantMsg);
    bus.publish({ type: "message.created", message: assistantMsg });

    const responseText = `You said: ${userText}`;
    const words = responseText.split(/(\s+)/);
    const partId = store.newId();

    let accumulated = "";
    for (const word of words) {
        if (abort?.aborted) break;
        accumulated += word;
        bus.publish({
            type: "part.delta",
            sessionId,
            messageId: assistantMsg.id,
            partId,
            delta: word,
        });
        await new Promise((r) => setTimeout(r, 30));
    }

    const assistantPart: TextPart = {
        id: partId,
        sessionId,
        messageId: assistantMsg.id,
        type: "text",
        text: accumulated,
        createdAt: Date.now(),
    };
    store.upsertPart(assistantPart);
    bus.publish({ type: "part.updated", part: assistantPart });
    bus.publish({ type: "session.status", sessionId, status: "idle" });
}
