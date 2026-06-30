import { describe, expect, it } from "bun:test";
import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "./define-tool.js";

describe("defineTool", () => {
    it("emits a valid Anthropic input_schema from a flat-object Zod schema", () => {
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
        // z.toJSONSchema's draft marker is stripped — Anthropic input_schema
        // carries only the object schema.
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
                execute: async () => ok({}),
            }),
        ).toThrow(/union-tool.*type.*object/s);
    });
});
