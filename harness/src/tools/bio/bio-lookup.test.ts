import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { searchGeneTool } from "./search-gene.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

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
                    identifiers: ["BRCA1"],
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
                    identifiers: ["NOTAGENE"],
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
        await expect(searchGeneTool.execute({ identifiers: ["BRCA1"], species: "homo_sapiens", expand: false }, ctx)).rejects.toThrow();
    });

    it("resolves an Ensembl gene ID to its approved symbol before it reaches Ensembl", async () => {
        const seen: string[] = [];
        globalThis.fetch = (async (input: unknown) => {
            const url = String(input);
            seen.push(url);
            const { hostname, pathname } = new URL(url);
            if (hostname === "rest.genenames.org") {
                return json({
                    response: {
                        docs: [
                            {
                                symbol: "TP53",
                                name: "tumor protein p53",
                                hgnc_id: "HGNC:11998",
                                ensembl_gene_id: "ENSG00000141510",
                                uniprot_ids: ["P04637"],
                            },
                        ],
                    },
                });
            }
            if (hostname === "rest.uniprot.org") {
                return json({ results: [{ primaryAccession: "P04637", genes: [{ geneName: { value: "TP53" } }] }] });
            }
            if (hostname === "www.ebi.ac.uk" && pathname.startsWith("/chembl")) return json({ targets: [] });
            return json({ id: "ENSG00000141510", display_name: "TP53", biotype: "protein_coding" });
        }) as unknown as typeof fetch;

        const { ctx } = makeToolContext();
        const result = (await searchGeneTool.execute({ identifiers: ["ENSG00000141510"], species: "homo_sapiens" }, ctx))._unsafeUnwrap();

        expect(result.resolvedFrom).toEqual([{ input: "ENSG00000141510", symbol: "TP53" }]);
        expect(result.genes[0]!.symbol).toBe("TP53");
        expect(seen.some((u) => u.includes("/lookup/symbol/homo_sapiens/TP53"))).toBe(true);
    });

    it("reports an identifier that anchors on no human gene as notFound, not an error", async () => {
        globalThis.fetch = (async (input: unknown) => {
            const url = String(input);
            if (new URL(url).hostname === "rest.ensembl.org") return json({ id: "", display_name: "" });
            return json({});
        }) as unknown as typeof fetch;

        const { ctx } = makeToolContext();
        const result = (await searchGeneTool.execute({ identifiers: ["CHEMBL99999999"], species: "homo_sapiens" }, ctx))._unsafeUnwrap();

        expect(result.notFound).toEqual(["CHEMBL99999999"]);
        expect(result.genes).toEqual([]);
    });
});
