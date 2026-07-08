import { describe, expect, test } from "bun:test";

import { pickDefaultModel } from "./models.ts";

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
