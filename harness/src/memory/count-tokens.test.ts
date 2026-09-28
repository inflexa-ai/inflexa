import { describe, expect, it } from "bun:test";
import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import type { ModelMessage, ToolResultPart } from "ai";

import { countTokens, UNKNOWN_IMAGE_TOKENS } from "./count-tokens.js";

/** The base64 text of the header of a PNG of the given size: the header is all that the count reads. */
function pngBase64(width: number, height: number): string {
    const header = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write("IHDR", 12, "ascii");
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    return header.toString("base64");
}

function pictureResult(item: Record<string, unknown>): ToolResultPart[] {
    return [{ type: "tool-result", toolCallId: "call_1", toolName: "examine_page", output: { type: "content", value: [item] } } as ToolResultPart];
}

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

    it("counts a nested picture of unknown size by the fallback, not by its byte length", () => {
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
        expect(countTokens(withPicture)).toBe(countTokens(noPicture) + UNKNOWN_IMAGE_TOKENS);
    });

    it("counts a picture by its pixel area over 750", () => {
        const text = countTokens(pictureResult({ type: "text", text: "" }));
        const nested = pictureResult({ type: "file", mediaType: "image/png", data: { type: "data", data: pngBase64(1280, 800) } });
        const legacy = pictureResult({ type: "image-data", mediaType: "image/png", data: pngBase64(100, 100) });
        const topLevel: ModelMessage = {
            role: "user",
            content: [{ type: "file", mediaType: "image/png", data: { type: "data", data: pngBase64(1000, 1000) } }],
        };

        expect(countTokens(nested) - text).toBe(Math.ceil((1280 * 800) / 750));
        expect(countTokens(legacy) - text).toBe(Math.ceil((100 * 100) / 750));
        expect(countTokens(topLevel.content)).toBe(Math.ceil((1000 * 1000) / 750));
    });

    it("counts a picture that the count cannot read by the fallback, and a file that is no picture as 0", () => {
        const url: ModelMessage = {
            role: "user",
            content: [{ type: "file", mediaType: "image", data: { type: "url", url: new URL("https://example.org/a.png") } }],
        };
        const pdf: ModelMessage = { role: "user", content: [{ type: "file", mediaType: "application/pdf", data: { type: "data", data: "A".repeat(10_000) } }] };

        expect(countTokens(url.content)).toBe(UNKNOWN_IMAGE_TOKENS);
        expect(countTokens(pdf.content)).toBe(0);
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
