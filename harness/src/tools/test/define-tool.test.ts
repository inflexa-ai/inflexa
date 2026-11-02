// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the refusal that names the tool, then its type, then the expected object type, in that order
const UNION_TOOL_REFUSAL = /union-tool.*type.*object/s;

import { describe, expect, it } from "bun:test";
import { ok } from "neverthrow";
import { z } from "zod";

import { parseUnknownRecord } from "../../lib/unknown-containers.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import { defineTool, readToolCallRecord, withToolCallRecord } from "../define-tool.js";
import { createRegistry } from "../registry.js";

describe("defineTool", () => {
    it("emits a valid AI SDK input schema from a flat-object Zod schema", () => {
        const tool = defineTool({
            id: "search-thing",
            description: "Search for a thing.",
            inputSchema: z.object({
                query: z.string().describe("The search query"),
                limit: z.number().default(10),
            }),
            view: "none",
            describeCall: (input) => input.query,
            execute: (input) => Promise.resolve(ok({ found: input.query })),
        });

        expect(tool.id).toBe("search-thing");
        expect(tool.jsonSchema.type).toBe("object");
        const props = parseUnknownRecord(tool.jsonSchema.properties);
        if (props === undefined) throw new Error("expected the properties record");
        expect(props.query).toBeDefined();
        expect(props.limit).toBeDefined();
        // z.toJSONSchema's draft marker is stripped before handing the schema
        // to AI SDK tool construction.
        expect(tool.jsonSchema.$schema).toBeUndefined();
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
                view: "none",
                describeCall: "none",
                execute: () => Promise.resolve(ok({})),
            }),
        ).toThrow(UNION_TOOL_REFUSAL);
    });

    describe("outputSchema", () => {
        it("emits the JSON Schema of the ok value", () => {
            const tool = defineTool({
                id: "typed",
                description: "Gives a count.",
                inputSchema: z.object({}),
                outputSchema: z.object({ count: z.number(), names: z.array(z.string()) }),
                view: "none",
                describeCall: "none",
                execute: () => Promise.resolve(ok({ count: 1, names: ["a"], extra: true })),
            });

            expect(tool.outputJsonSchema).toMatchObject({ type: "object", required: ["count", "names"] });
            expect(tool.outputJsonSchema?.$schema).toBeUndefined();
        });

        it("refuses at compile time an ok value that lacks a field of the schema", () => {
            const definition = {
                id: "short",
                description: "Gives a count.",
                inputSchema: z.object({}),
                outputSchema: z.object({ count: z.number(), names: z.array(z.string()) }),
                describeCall: "none" as const,
                execute: () => Promise.resolve(ok({ count: 1 })),
            };
            // @ts-expect-error -- the ok value has no `names`, which the schema promises to a script.
            const tool = defineTool(definition);
            expect(tool.id).toBe("short");
        });

        it("packages no result schema for a tool that declares none", () => {
            const tool = defineTool({
                id: "untyped",
                description: "Gives a value.",
                inputSchema: z.object({}),
                view: "none",
                describeCall: "none",
                execute: () => Promise.resolve(ok(1)),
            });

            expect(tool.outputJsonSchema).toBeUndefined();
        });
    });

    describe("describeCall", () => {
        it("carries a declared hook onto the packaged tool", () => {
            const tool = defineTool({
                id: "described",
                description: "Reads a file.",
                inputSchema: z.object({ path: z.string() }),
                view: "none",
                describeCall: (input) => input.path,
                execute: () => Promise.resolve(ok({})),
            });

            expect(tool.describeCall?.({ path: "output/summary.md" })).toBe("output/summary.md");
        });

        it("packages no hook for a definition that declines with the sentinel", () => {
            const tool = defineTool({
                id: "undescribed",
                description: "Declines the hook.",
                inputSchema: z.object({ path: z.string() }),
                view: "none",
                describeCall: "none",
                execute: () => Promise.resolve(ok({})),
            });

            expect(typeof tool.describeCall).toBe("undefined");
            expect("describeCall" in tool).toBe(false);
        });

        it("keeps the sentinel off the packaged tool and off its serialized form", () => {
            const tool = defineTool({
                id: "declined",
                description: "Declines the hook.",
                inputSchema: z.object({ path: z.string() }),
                view: "none",
                describeCall: "none",
                execute: () => Promise.resolve(ok({})),
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
                view: "none",
                describeCall: (input) => input.path,
                execute: () => Promise.resolve(ok({})),
            });
            const withoutHook = defineTool({
                id: "same-tool",
                description: "Reads a file.",
                inputSchema: schema,
                view: "none",
                describeCall: "none",
                execute: () => Promise.resolve(ok({})),
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
            // CAUTION: the directive below documents the contract, and a gate
            // now enforces it: `bun run typecheck` (`tsc -p tsconfig.json
            // --noEmit`) reads this file, so if the hook ever stops being
            // typed against its input, the suppressed error vanishes and the
            // unused directive fails the run with TS2578.
            const tool = defineTool({
                id: "typed-hook",
                description: "Declares only `path`.",
                inputSchema: z.object({ path: z.string() }),
                view: "none",
                // @ts-expect-error -- `query` is absent from this tool's inputSchema.
                describeCall: (input: { path: string; query: string }) => input.query,
                execute: () => Promise.resolve(ok({})),
            });

            expect(tool.id).toBe("typed-hook");
        });

        it("requires the decision — an omitted describeCall does not typecheck", () => {
            // The point of the required decision: a tool cannot ship undescribed
            // by omission. The gate of the CAUTION above holds here too: an
            // unused `@ts-expect-error` fails `bun run typecheck` with TS2578.
            // @ts-expect-error -- the definition declares neither a hook nor "none".
            const tool = defineTool({
                id: "undecided",
                description: "Declares no describeCall at all.",
                inputSchema: z.object({ path: z.string() }),
                execute: () => Promise.resolve(ok({})),
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
                view: "none",
                describeCall: (input) => input.path,
                describeResult: (input, result) => `${input.path} -> ${result.page}`,
                execute: () => Promise.resolve(ok({ page: "index.html" })),
            });

            expect(tool.describeResult?.({ path: "draft" }, { page: "index.html" })).toBe("draft -> index.html");
        });

        it("packages no hook for a definition that declares none", () => {
            const tool = defineTool({
                id: "call-only",
                description: "Describes its call alone.",
                inputSchema: z.object({ path: z.string() }),
                view: "none",
                describeCall: (input) => input.path,
                execute: () => Promise.resolve(ok({})),
            });

            expect(typeof tool.describeResult).toBe("undefined");
            expect("describeResult" in tool).toBe(false);
        });

        // An empty-input tool cannot distinguish its calls, and it can still name what each one
        // produced. Thus the two decisions are independent.
        it("packages a result hook beside a declined call hook", () => {
            const tool = defineTool({
                id: "result-only",
                description: "Takes no field, and names its outcome.",
                inputSchema: z.object({}),
                view: "none",
                describeCall: "none",
                describeResult: (_input, result) => result.outcome,
                execute: () => Promise.resolve(ok({ outcome: "rendered" })),
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
                view: "none",
                describeCall: "none",
                describeResult: (_input, result) => result.page,
                execute: () => Promise.resolve(ok({ page: "index.html" })),
            });
            const withoutHook = defineTool({
                id: "same-tool",
                description: "Renders a page.",
                inputSchema: schema,
                view: "none",
                describeCall: "none",
                execute: () => Promise.resolve(ok({ page: "index.html" })),
            });

            expect(withHook.jsonSchema).toEqual(withoutHook.jsonSchema);
            expect(JSON.stringify(createRegistry([withHook]).definitions())).toBe(JSON.stringify(createRegistry([withoutHook]).definitions()));
            expect(JSON.stringify(createRegistry([withHook]).definitions())).not.toContain("describeResult");
        });

        it("types the hook against the tool's own output", () => {
            // Read the CAUTION on the call hook above: the directive documents
            // the contract, and the same gate enforces it. `bun run typecheck`
            // reads this file, so if the hook stops being typed against its
            // output, the unused directive fails the run with TS2578.
            const tool = defineTool({
                id: "typed-result-hook",
                description: "Produces only `page`.",
                inputSchema: z.object({ path: z.string() }),
                view: "none",
                describeCall: "none",
                // @ts-expect-error -- `versionId` is absent from this tool's output.
                describeResult: (_input, result) => String(result.versionId),
                execute: () => Promise.resolve(ok({ page: "index.html" })),
            });

            expect(tool.id).toBe("typed-result-hook");
        });
    });

    describe("foldCallRecord", () => {
        it("carries a declared hook onto the packaged tool, and the hook gets the record that execute attached", async () => {
            const folded: unknown[] = [];
            const tool = defineTool({
                id: "recording-tool",
                description: "Records one id.",
                inputSchema: z.object({ id: z.string() }),
                view: "none",
                describeCall: (input) => input.id,
                execute: (input) => Promise.resolve(ok(withToolCallRecord({ recorded: true }, { id: input.id }))),
                foldCallRecord: (record) => {
                    folded.push(record.id);
                },
            });

            const value = (await tool.execute({ id: "a1" }, makeToolContext().ctx))._unsafeUnwrap();
            tool.foldCallRecord?.(readToolCallRecord(value));

            expect(folded).toEqual(["a1"]);
        });

        it("packages no hook for a definition that declares none", () => {
            const tool = defineTool({
                id: "plain-tool",
                description: "Records nothing.",
                inputSchema: z.object({}),
                view: "none",
                describeCall: "none",
                execute: () => Promise.resolve(ok({ done: true })),
            });

            expect("foldCallRecord" in tool).toBe(false);
        });

        it("keeps the record off the JSON text of the value, and reads no record from a value with none", () => {
            const value = withToolCallRecord({ recorded: true }, { id: "a1" });

            expect(JSON.stringify(value)).toBe(JSON.stringify({ recorded: true }));
            expect(readToolCallRecord(value)).toEqual({ id: "a1" });
            expect(readToolCallRecord({ recorded: true })).toBeUndefined();
            expect(readToolCallRecord("text")).toBeUndefined();
        });
    });

    describe("view", () => {
        it("packages a view and drops the none sentinel", () => {
            const view = { input: (input: { path: string }) => input.path, error: true } as const;
            const shown = defineTool({
                id: "shown",
                description: "Shows its input.",
                inputSchema: z.object({ path: z.string() }),
                describeCall: "none",
                view,
                execute: () => Promise.resolve(ok({ done: true })),
            });
            const hidden = defineTool({
                id: "hidden",
                description: "Shows nothing.",
                inputSchema: z.object({}),
                describeCall: "none",
                view: "none",
                execute: () => Promise.resolve(ok({ done: true })),
            });

            expect(shown.view).toBe(view);
            expect("view" in hidden).toBe(false);
        });

        it("refuses a definition with no view decision at the typecheck", () => {
            const make = () =>
                // @ts-expect-error -- the view decision is required, as the describeCall decision is.
                defineTool({
                    id: "undecided",
                    description: "Declares no view.",
                    inputSchema: z.object({}),
                    describeCall: "none",
                    execute: () => Promise.resolve(ok({ done: true })),
                });

            expect(typeof make).toBe("function");
        });
    });
});
