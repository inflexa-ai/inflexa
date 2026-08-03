import { describe, expect, it } from "bun:test";

import type { CitationInput, CitationResolutionResult, CitationResolver } from "../../citations/types.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createResolveCitationTool } from "./resolve-citation.js";

function resultFor(input: CitationInput): CitationResolutionResult {
    return {
        input,
        normalized: {
            citation: input.citation,
            query: input.citation,
            kind: "doi",
            identifiers: { doi: "10.1000/example" },
            supplied: {},
        },
        sourceOutcomes: [],
        candidates: [],
        comparisons: [],
        conflicts: [],
        verdict: "verified",
        coverage: "complete",
    };
}

describe("resolve_citation tool", () => {
    it("exposes the flat citation input schema and returns the resolver result unchanged", async () => {
        const calls: Array<{ input: CitationInput; signal: AbortSignal | undefined }> = [];
        const resolver: CitationResolver = {
            async resolveOne(input, options) {
                calls.push({ input, signal: options?.signal });
                return resultFor(input);
            },
            async resolveMany(inputs) {
                return inputs.map(resultFor);
            },
        };
        const tool = createResolveCitationTool(resolver);
        const { ctx } = makeToolContext();
        const input = { citation: "doi:10.1000/example", title: "Example", year: 2024 };

        const output = (await tool.execute(input, ctx))._unsafeUnwrap();

        expect(tool.id).toBe("resolve_citation");
        expect(tool.jsonSchema).toMatchObject({
            type: "object",
            properties: {
                citation: { type: "string" },
                title: { type: "string" },
                year: { type: "integer" },
            },
        });
        expect(calls).toEqual([{ input, signal: ctx.signal }]);
        expect(output).toEqual(resultFor(input));
    });
});
