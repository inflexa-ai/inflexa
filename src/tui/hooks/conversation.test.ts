import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { applyBusEvent, errorMsg, messages, resetHotState, streamPartId, streamText } from "./conversation.ts";
import { chatStatus } from "./status.ts";
import type { Message, TextPart } from "../../types/session.ts";

// The conversation state is a module singleton (one chat screen at a time), so reset it between
// cases. resetHotState() clears messages/stream/error and returns status to idle.
const SID = "s1";

function message(id: string, role: "user" | "assistant", sessionId = SID): Message {
    return { id, sessionId, role, createdAt: 0 };
}

function textPart(id: string, messageId: string, text: string, sessionId = SID): TextPart {
    return { id, sessionId, messageId, type: "text", text, createdAt: 0 };
}

beforeEach(() => {
    resetHotState();
});

afterEach(() => {
    resetHotState();
});

describe("applyBusEvent", () => {
    test("message.created appends a message for the active session", () => {
        applyBusEvent({ type: "message.created", message: message("m1", "user") }, SID);
        expect(messages.length).toBe(1);
        expect(messages[0]?.id).toBe("m1");
        expect(messages[0]?.role).toBe("user");
    });

    test("ignores an event addressed to a different session", () => {
        applyBusEvent({ type: "message.created", message: message("m1", "user", "other-session") }, SID);
        expect(messages.length).toBe(0);
    });

    test("part.updated upserts a part into its message (push, then replace by id)", () => {
        applyBusEvent({ type: "message.created", message: message("m1", "assistant") }, SID);
        applyBusEvent({ type: "part.updated", part: textPart("p1", "m1", "hello") }, SID);
        expect(messages[0]?.parts.length).toBe(1);

        applyBusEvent({ type: "part.updated", part: textPart("p1", "m1", "hello world") }, SID);
        expect(messages[0]?.parts.length).toBe(1); // replaced, not duplicated
        const part = messages[0]?.parts[0];
        expect(part?.type).toBe("text");
        if (part?.type === "text") expect(part.text).toBe("hello world");
    });

    test("part.delta accumulates into the stream buffer; a new partId resets it", () => {
        applyBusEvent({ type: "part.delta", sessionId: SID, messageId: "m1", partId: "p1", delta: "foo" }, SID);
        expect(streamPartId()).toBe("p1");
        expect(streamText()).toBe("foo");

        applyBusEvent({ type: "part.delta", sessionId: SID, messageId: "m1", partId: "p1", delta: "bar" }, SID);
        expect(streamText()).toBe("foobar");

        applyBusEvent({ type: "part.delta", sessionId: SID, messageId: "m1", partId: "p2", delta: "baz" }, SID);
        expect(streamPartId()).toBe("p2");
        expect(streamText()).toBe("baz"); // reset for the new part, not appended
    });

    test("session.status idle flushes the accumulated stream into the store part and clears the buffer", () => {
        applyBusEvent({ type: "message.created", message: message("m1", "assistant") }, SID);
        applyBusEvent({ type: "part.updated", part: textPart("p1", "m1", "") }, SID); // empty placeholder
        applyBusEvent({ type: "part.delta", sessionId: SID, messageId: "m1", partId: "p1", delta: "streamed" }, SID);
        applyBusEvent({ type: "session.status", sessionId: SID, status: "idle" }, SID);

        const part = messages[0]?.parts[0];
        expect(part?.type).toBe("text");
        if (part?.type === "text") expect(part.text).toBe("streamed");
        expect(streamPartId()).toBeNull();
        expect(streamText()).toBe("");
        expect(chatStatus()).toBe("idle");
    });

    test("session.error sets the error banner and the error status", () => {
        applyBusEvent({ type: "session.error", sessionId: SID, error: "boom" }, SID);
        expect(errorMsg()).toBe("boom");
        expect(chatStatus()).toBe("error");
    });
});
