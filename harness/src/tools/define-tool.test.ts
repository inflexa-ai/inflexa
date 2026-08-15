import { describe, expect, it } from "bun:test";
import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "./define-tool.js";
import { createRegistry } from "./registry.js";

describe("defineTool", () => {
    it("emits a valid AI SDK input schema from a flat-object Zod schema", () => {
        const tool = defineTool({
            id: "search-thing",
            description: "Search for a thing.",
            inputSchema: z.object({
                query: z.string().describe("The search query"),
                limit: z.number().default(10),
            }),
            describeCall: (input) => input.query,
            execute: async (input) => ok({ found: input.query }),
        });

        expect(tool.id).toBe("search-thing");
        expect(tool.jsonSchema.type).toBe("object");
        const props = tool.jsonSchema.properties as Record<string, unknown>;
        expect(props.query).toBeDefined();
        expect(props.limit).toBeDefined();
        // z.toJSONSchema's draft marker is stripped before handing the schema
        // to AI SDK tool construction.
        expect(tool.jsonSchema.$schema).toBeUndefined();
    });

    it("defaults tools to step execution mode", () => {
        const tool = defineTool({
            id: "default-step",
            description: "Defaults to a durable step.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => ok({ done: true }),
        });

        expect(tool.executionMode).toBe("step");
    });

    it("preserves explicit workflow and inline execution modes", () => {
        const workflow = defineTool({
            id: "workflow-tool",
            description: "Uses workflow context.",
            executionMode: "workflow",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => ok({ done: true }),
        });
        const inline = defineTool({
            id: "inline-tool",
            description: "Pure deterministic helper.",
            executionMode: "inline",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => ok({ done: true }),
        });

        expect(workflow.executionMode).toBe("workflow");
        expect(inline.executionMode).toBe("inline");
    });

    it("throws at construction for a discriminated-union schema", () => {
        const unionSchema = z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("a"), a: z.string() }),
            z.object({ kind: z.literal("b"), b: z.number() }),
        ]);

        expect(() =>
            defineTool({
                id: "union-tool",
                description: "A tool with a union input.",
                inputSchema: unionSchema,
                describeCall: "none",
                execute: async () => ok({}),
            }),
        ).toThrow(/union-tool.*type.*object/s);
    });

    describe("describeCall", () => {
        it("carries a declared hook onto the packaged tool", () => {
            const tool = defineTool({
                id: "described",
                description: "Reads a file.",
                inputSchema: z.object({ path: z.string() }),
                describeCall: (input) => input.path,
                execute: async () => ok({}),
            });

            expect(tool.describeCall?.({ path: "output/summary.md" })).toBe("output/summary.md");
        });

        it("packages no hook for a definition that declines with the sentinel", () => {
            const tool = defineTool({
                id: "undescribed",
                description: "Declines the hook.",
                inputSchema: z.object({ path: z.string() }),
                describeCall: "none",
                execute: async () => ok({}),
            });

            expect(tool.describeCall).toBeUndefined();
            expect("describeCall" in tool).toBe(false);
        });

        it("keeps the sentinel off the packaged tool and off its serialized form", () => {
            const tool = defineTool({
                id: "declined",
                description: "Declines the hook.",
                inputSchema: z.object({ path: z.string() }),
                describeCall: "none",
                execute: async () => ok({}),
            });

            expect(Object.values(tool)).not.toContain("none");
            expect(JSON.stringify(tool.jsonSchema)).not.toContain("none");
            expect(JSON.stringify(createRegistry([tool]).definitions())).not.toContain("none");
        });

        it("never reaches the model — the emitted AI SDK definition is unchanged", () => {
            const schema = z.object({ path: z.string() });
            const withHook = defineTool({
                id: "same-tool",
                description: "Reads a file.",
                inputSchema: schema,
                describeCall: (input) => input.path,
                execute: async () => ok({}),
            });
            const withoutHook = defineTool({
                id: "same-tool",
                description: "Reads a file.",
                inputSchema: schema,
                describeCall: "none",
                execute: async () => ok({}),
            });

            const described = createRegistry([withHook]).definitions();
            const plain = createRegistry([withoutHook]).definitions();

            expect(withHook.jsonSchema).toEqual(withoutHook.jsonSchema);
            expect(JSON.stringify(described)).toBe(JSON.stringify(plain));
            expect(JSON.stringify(described)).not.toContain("describeCall");
        });

        it("types the hook against the tool's own input", () => {
            // The guard this capability rests on: the hook and the schema are
            // checked against each other.
            //
            // CAUTION: the directive below documents the contract, and no gate
            // enforces it. `tsconfig.json` excludes `src/**/*.test.ts`, thus the
            // build typecheck never reads this file. ESLint builds its program
            // from `tsconfig.eslint.json`, but it reports its own rules only and
            // never a type error. Thus a regression here stays green.
            const tool = defineTool({
                id: "typed-hook",
                description: "Declares only `path`.",
                inputSchema: z.object({ path: z.string() }),
                // @ts-expect-error -- `query` is absent from this tool's inputSchema.
                describeCall: (input) => input.query,
                execute: async () => ok({}),
            });

            expect(tool.id).toBe("typed-hook");
        });

        it("requires the decision — an omitted describeCall does not typecheck", () => {
            // The point of the required decision: a tool cannot ship undescribed
            // by omission. Read the CAUTION above — no gate enforces this
            // directive either, thus it documents the contract rather than
            // guards it.
            // @ts-expect-error -- the definition declares neither a hook nor "none".
            const tool = defineTool({
                id: "undecided",
                description: "Declares no describeCall at all.",
                inputSchema: z.object({ path: z.string() }),
                execute: async () => ok({}),
            });

            expect(tool.id).toBe("undecided");
        });
    });

    describe("describeResult", () => {
        it("carries a declared hook onto the packaged tool", () => {
            const tool = defineTool({
                id: "described-result",
                description: "Renders a page.",
                inputSchema: z.object({ path: z.string() }),
                describeCall: (input) => input.path,
                describeResult: (input, result) => `${input.path} -> ${result.page}`,
                execute: async () => ok({ page: "index.html" }),
            });

            expect(tool.describeResult?.({ path: "draft" }, { page: "index.html" })).toBe("draft -> index.html");
        });

        it("packages no hook for a definition that declares none", () => {
            const tool = defineTool({
                id: "call-only",
                description: "Describes its call alone.",
                inputSchema: z.object({ path: z.string() }),
                describeCall: (input) => input.path,
                execute: async () => ok({}),
            });

            expect(tool.describeResult).toBeUndefined();
            expect("describeResult" in tool).toBe(false);
        });

        // An empty-input tool cannot distinguish its calls, and it can still name what each one
        // produced. Thus the two decisions are independent.
        it("packages a result hook beside a declined call hook", () => {
            const tool = defineTool({
                id: "result-only",
                description: "Takes no field, and names its outcome.",
                inputSchema: z.object({}),
                describeCall: "none",
                describeResult: (_input, result) => result.outcome,
                execute: async () => ok({ outcome: "rendered" }),
            });

            expect("describeCall" in tool).toBe(false);
            expect(tool.describeResult?.({}, { outcome: "rendered" })).toBe("rendered");
        });

        it("never reaches the model — the emitted AI SDK definition is unchanged", () => {
            const schema = z.object({ path: z.string() });
            const withHook = defineTool({
                id: "same-tool",
                description: "Renders a page.",
                inputSchema: schema,
                describeCall: "none",
                describeResult: (_input, result) => result.page,
                execute: async () => ok({ page: "index.html" }),
            });
            const withoutHook = defineTool({
                id: "same-tool",
                description: "Renders a page.",
                inputSchema: schema,
                describeCall: "none",
                execute: async () => ok({ page: "index.html" }),
            });

            expect(withHook.jsonSchema).toEqual(withoutHook.jsonSchema);
            expect(JSON.stringify(createRegistry([withHook]).definitions())).toBe(JSON.stringify(createRegistry([withoutHook]).definitions()));
            expect(JSON.stringify(createRegistry([withHook]).definitions())).not.toContain("describeResult");
        });

        it("types the hook against the tool's own output", () => {
            // Read the CAUTION on the call hook above: the directive documents the
            // contract, and no gate enforces it.
            const tool = defineTool({
                id: "typed-result-hook",
                description: "Produces only `page`.",
                inputSchema: z.object({ path: z.string() }),
                describeCall: "none",
                // @ts-expect-error -- `versionId` is absent from this tool's output.
                describeResult: (_input, result) => result.versionId,
                execute: async () => ok({ page: "index.html" }),
            });

            expect(tool.id).toBe("typed-result-hook");
        });
    });
});
