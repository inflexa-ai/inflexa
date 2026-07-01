import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { searchGeneTool } from "./search-gene.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(response: () => Response): void {
    globalThis.fetch = (async () => response()) as unknown as typeof fetch;
}

describe("searchGene (bio-lookup family)", () => {
    it("returns a populated data variant for a found gene", async () => {
        stubFetch(
            () =>
                new Response(
                    JSON.stringify({
                        id: "ENSG00000012048",
                        display_name: "BRCA1",
                        description: "BRCA1 DNA repair associated",
                        biotype: "protein_coding",
                        start: 43044295,
                        end: 43125483,
                        strand: -1,
                        assembly_name: "GRCh38",
                        seq_region_name: "17",
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                ),
        );

        const { ctx } = makeToolContext();
        const result = (
            await searchGeneTool.execute(
                {
                    symbols: ["BRCA1"],
                    species: "homo_sapiens",
                    expand: false,
                },
                ctx,
            )
        )._unsafeUnwrap();

        expect(result.genes).toHaveLength(1);
        expect(result.genes[0]!.id).toBe("ENSG00000012048");
        expect(result.notFound).toEqual([]);
    });

    it("returns the notFound variant for a missing gene (not is_error)", async () => {
        stubFetch(() => new Response("not found", { status: 400 }));

        const { ctx } = makeToolContext();
        const result = (
            await searchGeneTool.execute(
                {
                    symbols: ["NOTAGENE"],
                    species: "homo_sapiens",
                    expand: false,
                },
                ctx,
            )
        )._unsafeUnwrap();

        expect(result.genes).toEqual([]);
        expect(result.notFound).toEqual(["NOTAGENE"]);
    });

    it("throws on an upstream 5xx failure", async () => {
        stubFetch(() => new Response("upstream down", { status: 500 }));

        const { ctx } = makeToolContext();
        await expect(searchGeneTool.execute({ symbols: ["BRCA1"], species: "homo_sapiens", expand: false }, ctx)).rejects.toThrow();
    });
});
