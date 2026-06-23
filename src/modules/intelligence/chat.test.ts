import { describe, expect, test } from "bun:test";

import { pickDefaultModel, toModelMessages } from "./chat.ts";
import type { Message, Part, StoredMessage, TextPart } from "../../types/session.ts";

function textPart(text: string): TextPart {
    return { id: "p", sessionId: "s", messageId: "m", type: "text", text, createdAt: 0 };
}

function message(role: Message["role"], parts: Part[]): StoredMessage {
    return { info: { id: "m", sessionId: "s", role, createdAt: 0 }, parts };
}

describe("toModelMessages", () => {
    test("maps text parts to role + content, joining multiple parts of a message", () => {
        const out = toModelMessages([message("user", [textPart("foo"), textPart("bar")])]);
        expect(out).toEqual([{ role: "user", content: "foobar" }]);
    });

    test("preserves the message role", () => {
        expect(toModelMessages([message("assistant", [textPart("hi")])])).toEqual([{ role: "assistant", content: "hi" }]);
    });

    test("drops a message whose text content is empty (e.g. an interrupted placeholder)", () => {
        const out = toModelMessages([message("user", [textPart("kept")]), message("assistant", [textPart("")])]);
        expect(out).toEqual([{ role: "user", content: "kept" }]);
    });

    test("ignores non-text parts when building content", () => {
        const thinking: Part = { id: "t", sessionId: "s", messageId: "m", type: "thinking", text: "hidden reasoning", createdAt: 0 };
        const out = toModelMessages([message("assistant", [thinking, textPart("visible")])]);
        expect(out).toEqual([{ role: "assistant", content: "visible" }]);
    });
});

describe("pickDefaultModel", () => {
    test("prefers claude over other families regardless of list order", () => {
        expect(pickDefaultModel(["gpt-4o", "claude-sonnet", "gemini-pro"])).toBe("claude-sonnet");
    });

    test("falls through the preference order: gpt before gemini before qwen", () => {
        expect(pickDefaultModel(["gemini-pro", "gpt-4o"])).toBe("gpt-4o");
        expect(pickDefaultModel(["qwen-72b", "gemini-pro"])).toBe("gemini-pro");
    });

    test("matches case-insensitively and by substring", () => {
        expect(pickDefaultModel(["My-Claude-3.5"])).toBe("My-Claude-3.5");
    });

    test("falls back to the first id when no preferred family is present", () => {
        expect(pickDefaultModel(["llama-3", "mistral-7b"])).toBe("llama-3");
    });
});
