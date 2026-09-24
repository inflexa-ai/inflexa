import { describe, expect, it } from "bun:test";
import { errAsync, okAsync } from "neverthrow";

import type { KeptToolOutput, ToolOutputStore } from "../loop/tool-output.js";
import { makeToolContext } from "./__fixtures__/tool-context.js";
import { createReadToolOutputTool } from "./read-tool-output.js";

const REF = "to_3f9a2c41b8d605e7a1c0";

/** A store with one kept text of analysis-001, the analysis of the test session. */
function storeWith(content: string, analysisId = "analysis-001"): ToolOutputStore {
    const kept: KeptToolOutput = { analysisId, ref: REF, toolName: "read_file", toolCallId: "toolu_01", content, totalLength: content.length };
    return {
        put: () => okAsync(undefined),
        get: (id, ref) => okAsync(id === kept.analysisId && ref === kept.ref ? kept : null),
    };
}

/** A text with no character that JSON escapes, in which each offset names its own character. */
function digits(length: number): string {
    return Array.from({ length }, (_, i) => String(i % 10)).join("");
}

async function read(store: ToolOutputStore, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tool = createReadToolOutputTool(store);
    const parsed = tool.inputSchema.parse(input);
    return (await tool.execute(parsed, makeToolContext().ctx))._unsafeUnwrap() as Record<string, unknown>;
}

describe("createReadToolOutputTool", () => {
    it("runs in the step mode, and names the reference or the search of a call", () => {
        const tool = createReadToolOutputTool(storeWith("x"));
        expect(tool.id).toBe("read_tool_output");
        expect(tool.executionMode).toBe("step");
        expect(tool.describeCall?.({ ref: REF })).toBe(REF);
        expect(tool.describeCall?.({ ref: REF, pattern: "Traceback" })).toBe(`Traceback in ${REF}`);
    });

    it("gives a page of 8,192 characters from the offset 4,096, with its end and the kept length", async () => {
        const text = digits(100_000);

        const result = await read(storeWith(text), { ref: REF, offset: 4_096, limit: 8_192 });

        expect(result).toEqual({ status: "ok", ref: REF, offset: 4_096, end: 12_288, keptLength: 100_000, more: true, text: text.slice(4_096, 12_288) });
    });

    it("gives 8,192 characters from the start when the call gives no offset and no limit", async () => {
        const text = digits(100_000);

        const result = await read(storeWith(text), { ref: REF });

        expect(result).toMatchObject({ status: "ok", offset: 0, end: 8_192, more: true });
        expect(result.text).toBe(text.slice(0, 8_192));
    });

    it("gives each match of a pattern with its offset and the text around it", async () => {
        const text = `${"x".repeat(70_000)}Traceback (most recent call last)${"y".repeat(29_967)}`;

        const result = await read(storeWith(text), { ref: REF, pattern: "Traceback" });

        expect(result).toMatchObject({ status: "matches", pattern: "Traceback", offset: 0, end: 100_000, keptLength: 100_000, more: false });
        expect(result.matches).toEqual([{ offset: 70_000, text: text.slice(70_000 - 150, 70_000 + 250) }]);
    });

    it("stops a pattern of zero length, and gives at most 20 matches with the next offset", async () => {
        const result = await read(storeWith("b".repeat(1_000)), { ref: REF, pattern: "a*" });

        expect(result).toMatchObject({ status: "matches", end: 20, more: true });
        expect((result.matches as unknown[]).length).toBe(20);
    });

    it("gives no_matches for a pattern that the window does not hold", async () => {
        const result = await read(storeWith(digits(1_000)), { ref: REF, pattern: "Traceback", offset: 10, limit: 100 });

        expect(result).toEqual({ status: "no_matches", ref: REF, pattern: "Traceback", offset: 10, end: 110 });
    });

    it("gives not_found for an unknown reference and for a reference of a different analysis", async () => {
        expect(await read(storeWith("text"), { ref: "to_00000000000000000000" })).toEqual({ status: "not_found", ref: "to_00000000000000000000" });
        expect(await read(storeWith("text", "analysis-other"), { ref: REF })).toEqual({ status: "not_found", ref: REF });
    });

    it("gives out_of_range for an offset past the end, and invalid_pattern for a pattern that does not compile", async () => {
        expect(await read(storeWith("text"), { ref: REF, offset: 4 })).toEqual({ status: "out_of_range", ref: REF, offset: 4, keptLength: 4 });
        expect(await read(storeWith("text"), { ref: REF, pattern: "(" })).toMatchObject({ status: "invalid_pattern", pattern: "(" });
    });

    it("shortens a page of escaped text until its JSON text fits under the cap of the loop", async () => {
        const result = await read(storeWith('"'.repeat(40_000)), { ref: REF, limit: 16_384 });

        expect(JSON.stringify(result).length).toBeLessThanOrEqual(32_256);
        expect(result.end as number).toBeLessThan(16_384);
        expect(result.more).toBe(true);
        expect((result.text as string).length).toBe(result.end);
    });

    it("keeps a surrogate pair whole at each edge of a window", async () => {
        const text = `ab${"😀"}cd${"😀"}ef`;

        const result = await read(storeWith(text), { ref: REF, offset: 3, limit: 5 });

        expect(result).toMatchObject({ offset: 2, end: 6, text: "😀cd" });
    });

    it("throws when the read of the store fails", async () => {
        const failing: ToolOutputStore = { put: () => okAsync(undefined), get: () => errAsync({ type: "query_failed" }) };
        const tool = createReadToolOutputTool(failing);

        await expect(tool.execute({ ref: REF }, makeToolContext().ctx)).rejects.toThrow();
    });
});
