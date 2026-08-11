import { describe, expect, it } from "bun:test";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { ToolResultPart } from "ai";

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

    it("counts a nested file part of a tool result as near-zero, not by its byte length", () => {
        const json = JSON.stringify({ outcome: "captured", consoleErrors: [] });
        const base64 = "A".repeat(200_000);
        const withPicture: ToolResultPart[] = [
            {
                type: "tool-result",
                toolCallId: "call_1",
                toolName: "examine_page",
                output: {
                    type: "content",
                    value: [
                        { type: "text", text: json },
                        { type: "file", mediaType: "image/png", data: { type: "data", data: base64 } },
                    ],
                },
            },
        ];
        const noPicture: ToolResultPart[] = [
            {
                type: "tool-result",
                toolCallId: "call_1",
                toolName: "examine_page",
                output: { type: "content", value: [{ type: "text", text: json }] },
            },
        ];
        // The picture rides the wire as an attachment, thus the count of the two
        // results is equal and it stays far below the length of the base64 text.
        expect(countTokens(withPicture)).toBe(countTokens(noPicture));
        expect(countTokens(withPicture)).toBeLessThan(100);
    });

    it("counts the text parts of a tool result with content output", () => {
        const content: ToolResultPart[] = [
            {
                type: "tool-result",
                toolCallId: "call_2",
                toolName: "examine_page",
                output: { type: "content", value: [{ type: "text", text: "the quick brown fox jumps over the lazy dog" }] },
            },
        ];
        expect(countTokens(content)).toBeGreaterThan(5);
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
