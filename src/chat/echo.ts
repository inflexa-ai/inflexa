import { bus } from "../bus.ts";
import { createMessage, createPart, updatePart } from "../db/primary_mutation.ts";
import type { TextPart } from "../types.ts";

export interface ChatOptions {
    sessionId: string;
    userText: string;
    abort?: AbortSignal;
}

export async function chat(opts: ChatOptions): Promise<void> {
    const { sessionId, userText, abort } = opts;

    bus.publish({ type: "session.status", sessionId, status: "busy" });

    const userMsg = createMessage(sessionId, "user");
    const userPart = createPart(sessionId, userMsg.id, userText);
    bus.publish({ type: "message.created", message: userMsg });
    bus.publish({ type: "part.updated", part: userPart });

    const assistantMsg = createMessage(sessionId, "assistant");
    bus.publish({ type: "message.created", message: assistantMsg });

    const assistantPart = createPart(sessionId, assistantMsg.id, "");

    const responseText = `You said: ${userText}`;
    const words = responseText.split(/(\s+)/);

    let accumulated = "";
    for (const word of words) {
        if (abort?.aborted) break;
        accumulated += word;
        bus.publish({
            type: "part.delta",
            sessionId,
            messageId: assistantMsg.id,
            partId: assistantPart.id,
            delta: word,
        });
        await new Promise((r) => setTimeout(r, 30));
    }

    (assistantPart as TextPart).text = accumulated;
    updatePart(assistantPart);
    bus.publish({ type: "part.updated", part: assistantPart });
    bus.publish({ type: "session.status", sessionId, status: "idle" });
}
