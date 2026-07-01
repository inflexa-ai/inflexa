import { describe, expect, it } from "bun:test";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";

import { countTokens } from "./count-tokens.js";

describe("countTokens", () => {
    it("counts a text block as a stable positive number", () => {
        const content: ContentBlockParam[] = [{ type: "text", text: "the quick brown fox jumps over the lazy dog" }];
        const count = countTokens(content);
        expect(count).toBeGreaterThan(0);
        // Deterministic — the same content always tokenizes to the same count.
        expect(countTokens(content)).toBe(count);
    });

    it("counts a tool_result block as a stable positive number", () => {
        const content: ContentBlockParam[] = [
            {
                type: "tool_result",
                tool_use_id: "toolu_abc",
                content: JSON.stringify({ genes: ["TP53", "EGFR"], hits: 2 }),
            },
        ];
        const count = countTokens(content);
        expect(count).toBeGreaterThan(0);
        expect(countTokens(content)).toBe(count);
    });

    it("counts empty content as 0", () => {
        expect(countTokens([])).toBe(0);
        expect(countTokens("")).toBe(0);
    });

    it("counts a plain string as a positive number", () => {
        expect(countTokens("analyse this dataset")).toBeGreaterThan(0);
    });

    it("sums across multiple blocks", () => {
        const text: ContentBlockParam = { type: "text", text: "hello world" };
        const single = countTokens([text]);
        expect(countTokens([text, text])).toBe(single * 2);
    });
});
