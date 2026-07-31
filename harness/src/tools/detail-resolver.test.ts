import { describe, expect, it } from "bun:test";
import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool, type Tool } from "./define-tool.js";
import { createDetailResolver } from "./detail-resolver.js";

const describedTool: Tool = defineTool({
    id: "read_file",
    description: "Read a workspace file.",
    inputSchema: z.object({ path: z.string(), headLines: z.number().optional() }),
    describeCall: ({ path, headLines }) => (headLines === undefined ? path : `${path} (first ${headLines} lines)`),
    execute: async () => ok({}),
});

const hooklessTool: Tool = defineTool({
    id: "list_files",
    description: "List files.",
    inputSchema: z.object({ dir: z.string() }),
    execute: async () => ok({}),
});

describe("createDetailResolver", () => {
    const resolve = createDetailResolver([describedTool, hooklessTool]);

    it("resolves a described tool's call", () => {
        expect(resolve("read_file", { path: "output/summary.md" })).toBe("output/summary.md");
        expect(resolve("read_file", { path: "data/x.csv", headLines: 20 })).toBe("data/x.csv (first 20 lines)");
    });

    it("yields undefined for a tool that declares no hook", () => {
        expect(resolve("list_files", { dir: "output" })).toBeUndefined();
    });

    it("yields undefined for a tool name absent from the supplied list", () => {
        expect(resolve("run_inflexa", { argv: ["--help"] })).toBeUndefined();
    });

    it("yields undefined for a persisted input the tool's schema rejects", () => {
        expect(resolve("read_file", { pathname: "output/summary.md" })).toBeUndefined();
        expect(resolve("read_file", undefined)).toBeUndefined();
        expect(resolve("read_file", "output/summary.md")).toBeUndefined();
    });

    it("resolves an embedder-contributed tool the caller supplied", () => {
        const hostTool: Tool = defineTool({
            id: "run_inflexa",
            description: "Run an inflexa command.",
            inputSchema: z.object({ argv: z.array(z.string()) }),
            describeCall: ({ argv }) => argv.join(" "),
            execute: async () => ok({}),
        });

        const withHostTools = createDetailResolver([describedTool, hostTool]);

        expect(withHostTools("run_inflexa", { argv: ["analyze", "--fast"] })).toBe("analyze --fast");
    });

    it("normalizes through the same path the live loop uses", () => {
        const noisy: Tool = defineTool({
            id: "noisy",
            description: "Returns an unnormalized detail.",
            inputSchema: z.object({ text: z.string() }),
            describeCall: ({ text }) => text,
            execute: async () => ok({}),
        });

        expect(createDetailResolver([noisy])("noisy", { text: "one\ntwo" })).toBe("one two");
        expect(createDetailResolver([noisy])("noisy", { text: "y".repeat(400) })).toHaveLength(120);
    });
});
