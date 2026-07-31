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
            execute: async () => ok({ done: true }),
        });
        const inline = defineTool({
            id: "inline-tool",
            description: "Pure deterministic helper.",
            executionMode: "inline",
            inputSchema: z.object({}),
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

        it("constructs without a hook, and carries no key for one", () => {
            const tool = defineTool({
                id: "undescribed",
                description: "Declares no hook.",
                inputSchema: z.object({ path: z.string() }),
                execute: async () => ok({}),
            });

            expect(tool.describeCall).toBeUndefined();
            expect("describeCall" in tool).toBe(false);
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
            // checked against each other. Test files are outside the build
            // tsconfig, so this directive is verified by the lint program
            // (`tsc -p tsconfig.eslint.json --noEmit`), which includes all of src/.
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
    });
});
