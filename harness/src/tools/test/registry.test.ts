import { describe, expect, it } from "bun:test";
import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool } from "../define-tool.js";
import { createRegistry } from "../registry.js";
import { emittedInputSchema } from "../../lib/test/tool-schemas.js";

const alpha = defineTool({
    id: "alpha",
    description: "The alpha tool.",
    inputSchema: z.object({ x: z.string() }),
    describeCall: "none",
    execute: (input) => Promise.resolve(ok({ echoed: input.x })),
});

const beta = defineTool({
    id: "beta",
    description: "The beta tool.",
    inputSchema: z.object({ y: z.number() }),
    describeCall: "none",
    execute: (input) => Promise.resolve(ok({ doubled: input.y * 2 })),
});

describe("createRegistry", () => {
    it("dispatches by name via get()", () => {
        const registry = createRegistry([alpha, beta]);
        expect(registry.get("alpha")).toBe(alpha);
        expect(registry.get("beta")).toBe(beta);
        expect(registry.get("missing")).toBeUndefined();
    });

    it("returns one AI SDK definition per tool", () => {
        const registry = createRegistry([alpha, beta]);
        const defs = registry.definitions();
        expect(Object.keys(defs)).toEqual(["alpha", "beta"]);
        expect(defs.alpha).toBeDefined();
        expect(defs.alpha.description).toBe("The alpha tool.");
        const schema = defs.alpha.inputSchema;
        const emitted = emittedInputSchema(schema);
        if (!("type" in emitted)) throw new Error("expected a typed JSON schema");
        expect(emitted.type).toBe("object");
    });

    it("rejects duplicate tool ids", () => {
        expect(() => createRegistry([alpha, alpha])).toThrow("duplicate tool id");
    });
});
