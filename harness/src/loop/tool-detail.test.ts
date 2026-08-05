import { describe, expect, it } from "bun:test";
import { ok } from "neverthrow";
import { z } from "zod";

import { createNoopLogger } from "../lib/console-logger.js";
import type { LogFields, Logger } from "../lib/logger.js";
import { defineTool, type Tool } from "../tools/define-tool.js";
import { computeDetail, DETAIL_MAX_LENGTH, normalizeDetail } from "./tool-detail.js";

/** A logger that records every `debug` record, for the hook-failure path. */
function recordingLogger(): { logger: Logger; debugs: { msg: string; fields?: LogFields }[] } {
    const debugs: { msg: string; fields?: LogFields }[] = [];
    const base = createNoopLogger();
    const logger: Logger = {
        ...base,
        debug: (msg, fields) => {
            debugs.push(fields === undefined ? { msg } : { msg, fields });
        },
        with: () => logger,
        named: () => logger,
        errorFields: (err) => ({ error: err instanceof Error ? err.message : String(err) }),
    };
    return { logger, debugs };
}

/** A tool over `{ path }` whose hook is whatever the test supplies. */
function toolWithHook(describeCall: (input: { path: string }) => string): Tool {
    return defineTool({
        id: "described",
        description: "A tool that describes its own calls.",
        inputSchema: z.object({ path: z.string() }),
        describeCall,
        execute: async () => ok({}),
    });
}

describe("normalizeDetail", () => {
    it("passes a plain single-line string through unchanged", () => {
        expect(normalizeDetail("output/summary.md")).toBe("output/summary.md");
    });

    it("rejects a non-string", () => {
        expect(normalizeDetail(undefined)).toBeUndefined();
        expect(normalizeDetail(null)).toBeUndefined();
        expect(normalizeDetail(42)).toBeUndefined();
        expect(normalizeDetail({ path: "x" })).toBeUndefined();
    });

    it("rejects an empty string, and one that normalizes to empty", () => {
        expect(normalizeDetail("")).toBeUndefined();
        expect(normalizeDetail("   \n\t  ")).toBeUndefined();
    });

    it("collapses a multi-line value onto one line", () => {
        const detail = normalizeDetail("first line\nsecond line\r\nthird\tline");

        expect(detail).toBe("first line second line third line");
        expect(detail).not.toContain("\n");
    });

    it("strips control characters", () => {
        const esc = String.fromCharCode(27);
        const bell = String.fromCharCode(7);
        const detail = normalizeDetail(`clear${esc}[31mred${bell} text`);

        expect(detail).toBe("clear[31mred text");
        expect(detail).not.toContain(esc);
        expect(detail).not.toContain(bell);
    });

    it("redacts a secret the harness sanitizer matches", () => {
        const detail = normalizeDetail("run with sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA");

        expect(detail).toContain("[REDACTED: Anthropic API Key]");
        expect(detail).not.toContain("sk-ant-api03");
    });

    // The mark is what tells a reader that the line is short of what the hook returned. It costs
    // one of the capped code points, so the marked result still obeys the bound.
    it("caps an over-long value and marks the cut", () => {
        const detail = normalizeDetail("x".repeat(5000))!;

        expect(detail.endsWith("…")).toBe(true);
        expect(Array.from(detail).length).toBeLessThanOrEqual(DETAIL_MAX_LENGTH);
        expect(detail).toHaveLength(DETAIL_MAX_LENGTH);
    });

    it("leaves a value within the cap unmarked", () => {
        const fits = "x".repeat(DETAIL_MAX_LENGTH);

        expect(normalizeDetail("output/summary.md")).not.toContain("…");
        expect(normalizeDetail(fits)).toBe(fits);
    });

    // `trimEnd` runs before the append, so a cut that lands on a space gives `word…`, not `word …`.
    it("does not strand a space before the mark", () => {
        // The 119th code point is a space, which is exactly where the cut falls.
        const detail = normalizeDetail(`${"a".repeat(DETAIL_MAX_LENGTH - 2)} ${"b".repeat(50)}`)!;

        expect(detail).not.toContain(" …");
        expect(detail.endsWith("a…")).toBe(true);
    });

    it("redacts before capping, so a secret cannot survive by being cut", () => {
        const secret = "sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBB";
        const detail = normalizeDetail(`${"padding ".repeat(12)}${secret}`);

        expect(detail!.length).toBeLessThanOrEqual(DETAIL_MAX_LENGTH);
        expect(detail).not.toContain("sk-ant-");
    });

    // The cap counts code points, so it can never cut between the halves of a surrogate pair. A
    // UTF-16 slice at a fixed index can, and the lone surrogate it leaves paints as a replacement
    // character — the cap would corrupt the tail it was only supposed to shorten.
    it("caps without splitting a surrogate pair", () => {
        // Each emoji is one code point and TWO UTF-16 units, so a unit-indexed cut lands mid-pair.
        const detail = normalizeDetail("🧬".repeat(200))!;

        expect(Array.from(detail)).toHaveLength(DETAIL_MAX_LENGTH);
        expect(detail).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
        expect(detail).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    });
});

describe("computeDetail", () => {
    const log = createNoopLogger();

    it("returns the normalized hook output for a valid input", () => {
        const tool = toolWithHook(({ path }) => path);

        expect(computeDetail(tool, { path: "runs/r1/step-2/output/summary.md" }, log)).toBe("runs/r1/step-2/output/summary.md");
    });

    it("normalizes at the emit site, not in the tool", () => {
        const tool = toolWithHook(({ path }) => `wrote\n${path}`);

        expect(computeDetail(tool, { path: "a.csv" }, log)).toBe("wrote a.csv");
    });

    it("yields undefined for a tool with no hook", () => {
        const tool = defineTool({
            id: "undescribed",
            description: "Declares no hook.",
            inputSchema: z.object({ path: z.string() }),
            describeCall: "none",
            execute: async () => ok({}),
        });

        expect(computeDetail(tool, { path: "a.csv" }, log)).toBeUndefined();
    });

    it("does not call the hook when the input fails validation", () => {
        let called = false;
        const tool = toolWithHook(({ path }) => {
            called = true;
            return path;
        });

        expect(computeDetail(tool, { wrong: "shape" }, log)).toBeUndefined();
        expect(computeDetail(tool, "not an object", log)).toBeUndefined();
        expect(called).toBe(false);
    });

    it("swallows a throwing hook and records it at debug", () => {
        const { logger, debugs } = recordingLogger();
        const tool = toolWithHook(() => {
            throw new Error("hook is broken");
        });

        expect(computeDetail(tool, { path: "a.csv" }, logger)).toBeUndefined();
        expect(debugs).toHaveLength(1);
        expect(debugs[0]!.fields).toMatchObject({ tool: "described", error: "hook is broken" });
    });

    it("ignores a hook that returns a non-string or an empty string", () => {
        const nonString = toolWithHook(() => undefined as unknown as string);
        const empty = toolWithHook(() => "");

        expect(computeDetail(nonString, { path: "a.csv" }, log)).toBeUndefined();
        expect(computeDetail(empty, { path: "a.csv" }, log)).toBeUndefined();
    });

    // `safeParse` RETURNS an error for a rejected value but THROWS for a schema it cannot run
    // synchronously. An embedder contributes its own tools, so such a schema is reachable — and
    // an unguarded parse would carry that throw out of the loop and kill the turn, which is the
    // one thing a description is never allowed to do.
    it("survives a schema whose validation throws, not just a hook that throws", () => {
        const { logger, debugs } = recordingLogger();
        const asyncRefined = defineTool({
            id: "async_refined",
            description: "A tool whose schema carries an async refinement.",
            inputSchema: z.object({ path: z.string() }).refine(async ({ path }) => path.length > 0, "unreachable"),
            describeCall: ({ path }) => path,
            execute: async () => ok({}),
        });

        expect(computeDetail(asyncRefined, { path: "a.csv" }, logger)).toBeUndefined();
        expect(debugs[0]!.fields).toMatchObject({ tool: "async_refined" });
    });

    it("survives a schema whose own refinement throws", () => {
        const { logger, debugs } = recordingLogger();
        const throwingRefinement = defineTool({
            id: "throwing_refinement",
            description: "A tool whose schema throws while validating.",
            inputSchema: z.object({ path: z.string() }).superRefine(() => {
                throw new Error("refinement is broken");
            }),
            describeCall: ({ path }) => path,
            execute: async () => ok({}),
        });

        expect(computeDetail(throwingRefinement, { path: "a.csv" }, logger)).toBeUndefined();
        expect(debugs[0]!.fields).toMatchObject({ tool: "throwing_refinement", error: "refinement is broken" });
    });
});
