import { describe, expect, it } from "bun:test";
import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "./define-tool.js";
import { createRegistry } from "./registry.js";

const alpha = defineTool({
    id: "alpha",
    description: "The alpha tool.",
    inputSchema: z.object({ x: z.string() }),
    execute: async (input) => ok({ echoed: input.x }),
});

const beta = defineTool({
    id: "beta",
    description: "The beta tool.",
    inputSchema: z.object({ y: z.number() }),
    execute: async (input) => ok({ doubled: input.y * 2 }),
});

describe("createRegistry", () => {
    it("dispatches by name via get()", () => {
        const registry = createRegistry([alpha, beta]);
        expect(registry.get("alpha")).toBe(alpha);
        expect(registry.get("beta")).toBe(beta);
        expect(registry.get("missing")).toBeUndefined();
    });

    it("returns one Anthropic definition per tool", () => {
        const registry = createRegistry([alpha, beta]);
        const defs = registry.definitions();
        expect(defs).toHaveLength(2);
        expect(defs.map((d) => d.name)).toEqual(["alpha", "beta"]);
        expect(defs[0]!.input_schema.type).toBe("object");
        expect(defs[0]!.description).toBe("The alpha tool.");
    });

    it("rejects duplicate tool ids", () => {
        expect(() => createRegistry([alpha, alpha])).toThrow(/duplicate tool id/);
    });
});
