import { describe, expect, it } from "bun:test";
import { ok } from "neverthrow";
import { z } from "zod";

import { defineTool, type ToolContext } from "../tools/define-tool.js";
import { canonicalInputKey, guardRepeatedCalls } from "./call-guard.js";

function makeTool(id: string) {
    let served = 0;
    const tool = defineTool({
        id,
        description: `the ${id} tool`,
        inputSchema: z.object({ query: z.string().optional(), limit: z.number().optional() }),
        describeCall: ({ query }) => `query ${query ?? "(none)"}`,
        execute: async () => {
            served += 1;
            return ok({ served });
        },
    });
    return { tool, count: () => served };
}

const ctx = {} as ToolContext;

describe("guardRepeatedCalls", () => {
    it("keys an input by its content, not by the order of its keys", () => {
        expect(canonicalInputKey({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(canonicalInputKey({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }));
        expect(canonicalInputKey({ a: 1 })).not.toBe(canonicalInputKey({ a: 2 }));
    });

    it("serves two identical calls and refuses the third without a call to the tool", async () => {
        const { tool, count } = makeTool("list_available_refs");
        const [guarded] = guardRepeatedCalls([tool]);
        expect((await guarded!.execute({ query: "hallmark" }, ctx)).isOk()).toBe(true);
        expect((await guarded!.execute({ query: "hallmark" }, ctx)).isOk()).toBe(true);
        const third = await guarded!.execute({ query: "hallmark" }, ctx);
        expect(third.isErr()).toBe(true);
        expect(third._unsafeUnwrapErr().error).toContain("exact input 2 times");
        expect(third._unsafeUnwrapErr().retryable).toBe(false);
        expect(count()).toBe(2);
    });

    it("refuses the call past the per-tool budget, whatever the inputs, and reports each refusal", async () => {
        const { tool, count } = makeTool("list_available_packages");
        const refusals: string[] = [];
        const [guarded] = guardRepeatedCalls([tool], {
            policy: { identicalLimit: 2, perToolLimit: 3 },
            onRefusal: (refusal) => refusals.push(`${refusal.tool}:${refusal.kind}:${refusal.calls}`),
        });
        for (const query of ["a", "b", "c"]) expect((await guarded!.execute({ query }, ctx)).isOk()).toBe(true);
        const fourth = await guarded!.execute({ query: "d" }, ctx);
        expect(fourth.isErr()).toBe(true);
        expect(fourth._unsafeUnwrapErr().error).toContain("3 calls of list_available_packages");
        expect(count()).toBe(3);
        expect(refusals).toEqual(["list_available_packages:budget:4"]);
    });

    it("counts each tool on its own and keeps the description hooks of the tool", async () => {
        const a = makeTool("a");
        const b = makeTool("b");
        const guarded = guardRepeatedCalls([a.tool, b.tool], { policy: { identicalLimit: 1, perToolLimit: 12 } });
        expect((await guarded[0]!.execute({ query: "x" }, ctx)).isOk()).toBe(true);
        expect((await guarded[1]!.execute({ query: "x" }, ctx)).isOk()).toBe(true);
        expect((await guarded[0]!.execute({ query: "x" }, ctx)).isErr()).toBe(true);
        expect(guarded[0]!.id).toBe("a");
        expect(guarded[0]!.describeCall?.({ query: "x" })).toBe("query x");
        expect(guarded[0]!.jsonSchema).toEqual(a.tool.jsonSchema);
    });

    it("starts the counters at zero for each wrapped list", async () => {
        const { tool } = makeTool("c");
        const first = guardRepeatedCalls([tool], { policy: { identicalLimit: 1, perToolLimit: 12 } });
        expect((await first[0]!.execute({}, ctx)).isOk()).toBe(true);
        expect((await first[0]!.execute({}, ctx)).isErr()).toBe(true);
        const second = guardRepeatedCalls([tool], { policy: { identicalLimit: 1, perToolLimit: 12 } });
        expect((await second[0]!.execute({}, ctx)).isOk()).toBe(true);
    });
});
