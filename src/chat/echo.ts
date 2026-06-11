import { type Result, ok, err } from "neverthrow";
import { bus } from "../bus.ts";
import { createMessage, createPart, updatePart } from "../db/primary_mutation.ts";
import type { DbError } from "../db/errors.ts";
import type { TextPart } from "../types.ts";

export interface ChatOptions {
    sessionId: string;
    userText: string;
    abort?: AbortSignal;
}

export async function chat(opts: ChatOptions): Promise<Result<void, DbError>> {
    const { sessionId, userText, abort } = opts;

    bus.publish({ type: "session.status", sessionId, status: "busy" });

    const setup = createMessage(sessionId, "user")
        .andThen((userMsg) =>
            createPart(sessionId, userMsg.id, userText).map((userPart) => {
                bus.publish({ type: "message.created", message: userMsg });
                bus.publish({ type: "part.updated", part: userPart });
            }),
        )
        .andThen(() => createMessage(sessionId, "assistant"))
        .andThen((assistantMsg) => {
            bus.publish({ type: "message.created", message: assistantMsg });
            return createPart(sessionId, assistantMsg.id, "").map((assistantPart) => ({ assistantMsg, assistantPart }));
        })
        .match(
            (val) => ({ ok: true as const, ...val }),
            (error) => ({ ok: false as const, error }),
        );

    if (!setup.ok) {
        bus.publish({ type: "session.status", sessionId, status: "error" });
        return err(setup.error);
    }

    const { assistantMsg, assistantPart } = setup;

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
    return updatePart(assistantPart).match(
        () => {
            bus.publish({ type: "part.updated", part: assistantPart });
            bus.publish({ type: "session.status", sessionId, status: "idle" });
            return ok<void, DbError>(undefined);
        },
        (error) => {
            bus.publish({ type: "session.status", sessionId, status: "error" });
            return err<void, DbError>(error);
        },
    );
}
