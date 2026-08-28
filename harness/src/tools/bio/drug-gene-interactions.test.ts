import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createDrugGeneInteractionsTool } from "./drug-gene-interactions.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(response: (url: string) => Response): void {
    globalThis.fetch = (async (input: unknown) => response(String(input))) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const tool = createDrugGeneInteractionsTool({ drugbankApiKey: "test-key" });
const toolNoDrugbankKey = createDrugGeneInteractionsTool({ drugbankApiKey: "" });

function outcome(perSource: { source: string; status: string; detail?: string }[], source: string) {
    return perSource.find((s) => s.source === source);
}

// The wire shape of DGIdb. GraphQL answers a nullable field with an explicit
// null, thus every second row carries `directionality: null`, as the live
// payloads do.
function dgidbGeneNode(name: string, interactionCount: number) {
    return {
        data: {
            genes: {
                nodes: [
                    {
                        name,
                        interactions: Array.from({ length: interactionCount }, (_, i) => ({
                            interactionScore: interactionCount - i,
                            interactionTypes: [{ type: "inhibitor", directionality: i % 2 === 0 ? "INHIBITORY" : null }],
                            drug: { name: `DRUG${i}`, conceptId: `chembl:CHEMBL${i}` },
                            interactionAttributes: [{ name: "Assay", value: "x".repeat(500) }],
                            publications: [{ pmid: 1 }, { pmid: 2 }, { pmid: 3 }, { pmid: 4 }, { pmid: 5 }, { pmid: 6 }, { pmid: 7 }],
                            sources: Array.from({ length: interactionCount - i }, (_, s) => ({ sourceDbName: `DB${s}` })),
                        })),
                    },
                ],
            },
        },
    };
}

describe("drugGeneInteractions — DGIdb corpus", () => {
    it("defaults to DGIdb alone, since it aggregates the others", async () => {
        const seen: string[] = [];
        stubFetch((url) => {
            seen.push(url);
            return json(dgidbGeneNode("EGFR", 2));
        });

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "EGFR", direction: "gene_to_drugs" }, ctx))._unsafeUnwrap();

        expect(result.perSource.map((s) => s.source)).toEqual(["dgidb"]);
        expect(seen.every((u) => u.includes("dgidb"))).toBe(true);
        expect(result.drugbank).toBeUndefined();
        expect(result.pharmgkb).toBeUndefined();
    });

    it("maps interactions, sorts by source count, and reports the pre-trim total", async () => {
        stubFetch(() => json(dgidbGeneNode("EGFR", 5)));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "EGFR", direction: "gene_to_drugs", limit: 2 }, ctx))._unsafeUnwrap();

        const entry = result.dgidb![0]!;
        expect(entry.found).toBe(true);
        expect(entry.totalInteractions).toBe(5);
        expect(entry.interactions).toHaveLength(2);
        expect(entry.interactions[0]!.sourceCount).toBeGreaterThan(entry.interactions[1]!.sourceCount);
        expect(entry.interactions[0]!.geneName).toBe("EGFR");
    });

    it("omits verbose attributes by default and caps the pmid list", async () => {
        stubFetch(() => json(dgidbGeneNode("EGFR", 1)));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "EGFR", direction: "gene_to_drugs" }, ctx))._unsafeUnwrap();

        const interaction = result.dgidb![0]!.interactions[0]!;
        expect(interaction.attributes).toBeUndefined();
        expect(interaction.publicationCount).toBe(7);
        expect(interaction.pmids).toHaveLength(5);
    });

    it("includes attributes on request, truncating each value", async () => {
        stubFetch(() => json(dgidbGeneNode("EGFR", 1)));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "EGFR", direction: "gene_to_drugs", includeAttributes: true }, ctx))._unsafeUnwrap();

        const attributes = result.dgidb![0]!.interactions[0]!.attributes!;
        expect(attributes).toHaveLength(1);
        expect(attributes[0]!.value.length).toBe(160);
    });

    it("marks an unmatched identifier found: false rather than dropping it", async () => {
        stubFetch(() => json({ data: { genes: { nodes: [] } } }));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: ["EGFR", "NOTAGENE"], direction: "gene_to_drugs" }, ctx))._unsafeUnwrap();

        expect(result.dgidb).toHaveLength(2);
        expect(result.dgidb!.every((r) => r.found === false)).toBe(true);
    });

    it("applies the minSources filter", async () => {
        stubFetch(() => json(dgidbGeneNode("EGFR", 3)));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "EGFR", direction: "gene_to_drugs", minSources: 3 }, ctx))._unsafeUnwrap();

        expect(result.dgidb![0]!.interactions).toHaveLength(1);
    });

    it("keeps a row whose directionality is null", async () => {
        stubFetch(() => json(dgidbGeneNode("EGFR", 2)));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "EGFR", direction: "gene_to_drugs" }, ctx))._unsafeUnwrap();

        const types = result.dgidb![0]!.interactions.map((i) => i.interactionTypes[0]!);
        expect(types).toHaveLength(2);
        expect(types[0]!.directionality).toBe("INHIBITORY");
        expect(types[1]!.directionality).toBeUndefined();
    });

    it("skips a node whose name is null, and keeps the rest", async () => {
        // `Gene.name` is nullable in the SDL, thus a null-named node must not
        // reject the whole response.
        stubFetch(() => json({ data: { genes: { nodes: [null, { name: null, interactions: [] }, { name: "EGFR", interactions: [] }] } } }));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: ["EGFR", "BRAF"], direction: "gene_to_drugs" }, ctx))._unsafeUnwrap();

        expect(result.dgidb!.map((r) => r.found)).toEqual([true, false]);
    });
});

describe("drugGeneInteractions — DrugBank corpus", () => {
    // The Discovery drug record. The API serves no indication, pharmacology,
    // target list or drug-drug interaction on it.
    const IMATINIB = {
        drugbank_id: "DB00619",
        name: "Imatinib",
        description: "Tyrosine kinase inhibitor. ".repeat(40),
        type: "Small Molecule",
        groups: ["Approved"],
    };

    /** One bond row of `/bonds/targets`, as the Discovery documents show it. */
    function bond(drugbankId: string, name: string) {
        return {
            type: "Target",
            drug: { drugbank_id: drugbankId, name },
            bio_entity: { bio_entity_id: "BE0000001", name: "Tyrosine-protein kinase ABL1", organism: "Humans" },
            known_action: "yes",
            actions: ["inhibitor"],
        };
    }

    it("maps a single record and previews prose by default", async () => {
        stubFetch(() => json(IMATINIB));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "DB00619", direction: "drug_to_genes", sources: ["drugbank"] }, ctx))._unsafeUnwrap();

        const drug = result.drugbank![0]!;
        expect(drug.drugbankId).toBe("DB00619");
        expect(drug.type).toBe("Small Molecule");
        expect(drug.groups).toEqual(["Approved"]);
        expect(drug.proseTruncated).toBe(true);
        expect(drug.description.length).toBe(200);
    });

    it("degrades to 'unavailable' on an error envelope, rather than one blank row", async () => {
        stubFetch(() => json({ error: "Key invalid" }));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "DB00619", direction: "drug_to_genes", sources: ["drugbank"] }, ctx))._unsafeUnwrap();

        expect(result.drugbank).toEqual([]);
        expect(outcome(result.perSource, "drugbank")).toMatchObject({ status: "unavailable" });
        expect(outcome(result.perSource, "drugbank")!.detail).toContain("did not match the expected schema");
    });

    it("returns the full prose on request", async () => {
        stubFetch(() => json(IMATINIB));

        const { ctx } = makeToolContext();
        const result = (
            await tool.execute({ query: "DB00619", direction: "drug_to_genes", sources: ["drugbank"], includeDrugRecord: true }, ctx)
        )._unsafeUnwrap();

        const drug = result.drugbank![0]!;
        expect(drug.proseTruncated).toBe(false);
        // The parse boundary caps each prose field at 500 characters.
        expect(drug.description.length).toBe(500);
    });

    it("reads the drugs of a gene off the target bonds", async () => {
        const seen: string[] = [];
        stubFetch((url) => {
            seen.push(url);
            return json([bond("DB00619", "Imatinib"), bond("DB01254", "Dasatinib"), bond("DB00619", "Imatinib")]);
        });

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "ABL1", direction: "gene_to_drugs", sources: ["drugbank"] }, ctx))._unsafeUnwrap();

        expect(seen[0]).toContain("bonds/targets?q=polypeptides.gene_name%3AABL1");
        // One drug binds a target through more than one bond, thus the rows repeat.
        expect(result.drugbank!.map((d) => d.drugbankId)).toEqual(["DB00619", "DB01254"]);
    });

    it("degrades to 'unavailable' when the key is absent, without an HTTP call", async () => {
        let called = false;
        stubFetch(() => {
            called = true;
            return json(IMATINIB);
        });

        const { ctx } = makeToolContext();
        const result = (await toolNoDrugbankKey.execute({ query: "imatinib", direction: "drug_to_genes", sources: ["drugbank"] }, ctx))._unsafeUnwrap();

        expect(called).toBe(false);
        expect(outcome(result.perSource, "drugbank")).toMatchObject({ status: "unavailable" });
        expect(outcome(result.perSource, "drugbank")!.detail).toContain("DRUGBANK_API_KEY");
    });

    it("says which identifier it read when handed a batch it cannot honour", async () => {
        stubFetch((url) => (url.includes("dgidb") ? json(dgidbGeneNode("EGFR", 1)) : json([bond("DB00619", "Imatinib")])));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: ["EGFR", "ALK"], direction: "gene_to_drugs", sources: ["dgidb", "drugbank"] }, ctx))._unsafeUnwrap();

        expect(outcome(result.perSource, "drugbank")!.detail).toContain("read only 'EGFR'");
        expect(outcome(result.perSource, "dgidb")!.detail).toBeUndefined();
    });
});

describe("drugGeneInteractions — PharmGKB corpus", () => {
    it("maps annotations to gene / drug / levelOfEvidence", async () => {
        stubFetch(() =>
            json({
                data: [
                    {
                        location: { genes: [{ symbol: "CYP2D6" }] },
                        relatedChemicals: [{ name: "tamoxifen" }],
                        levelOfEvidence: { term: "1A" },
                    },
                ],
            }),
        );

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "CYP2D6", direction: "gene_to_drugs", sources: ["pharmgkb"] }, ctx))._unsafeUnwrap();

        expect(result.pharmgkb).toEqual([{ gene: "CYP2D6", drug: "tamoxifen", levelOfEvidence: "1A" }]);
    });
});

describe("drugGeneInteractions — fan-out", () => {
    it("does not let one failing corpus fail the call", async () => {
        stubFetch((url) => {
            if (url.includes("dgidb")) return new Response("upstream down", { status: 500 });
            return json({ data: [{ location: { genes: [{ symbol: "CYP2D6" }] }, levelOfEvidence: { term: "1A" } }] });
        });

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "CYP2D6", direction: "gene_to_drugs", sources: ["dgidb", "pharmgkb"] }, ctx))._unsafeUnwrap();

        expect(outcome(result.perSource, "dgidb")).toMatchObject({ status: "unavailable" });
        expect(outcome(result.perSource, "pharmgkb")).toMatchObject({ status: "ok", returned: 1 });
    });

    it("rejects an over-long batch at the schema boundary", async () => {
        await expect(tool.inputSchema.parseAsync({ query: Array.from({ length: 26 }, (_, i) => `GENE${i}`), direction: "gene_to_drugs" })).rejects.toThrow();
    });
});
