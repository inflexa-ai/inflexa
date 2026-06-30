import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createSearchDrugbankTool } from "./search-drugbank.js";

const searchDrugbankTool = createSearchDrugbankTool({ apiKey: "test-key" });
const searchDrugbankToolNoKey = createSearchDrugbankTool({ apiKey: "" });

const realFetch = globalThis.fetch;
const ORIGINAL_KEY = process.env.DRUGBANK_API_KEY;

beforeEach(() => {
    process.env.DRUGBANK_API_KEY = "test-key";
});

afterEach(() => {
    globalThis.fetch = realFetch;
    if (ORIGINAL_KEY === undefined) {
        delete process.env.DRUGBANK_API_KEY;
    } else {
        process.env.DRUGBANK_API_KEY = ORIGINAL_KEY;
    }
});

function stubFetch(response: () => Response): void {
    globalThis.fetch = (async () => response()) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

describe("searchDrugbank", () => {
    it("maps a single DrugBank record (DB id lookup)", async () => {
        stubFetch(() =>
            json({
                drugbank_id: "DB00619",
                name: "Imatinib",
                description: "Tyrosine kinase inhibitor.",
                type: "small molecule",
                groups: ["approved"],
                categories: [{ category: "Antineoplastic Agents" }],
                indication: "CML, GIST.",
                pharmacodynamics: "Inhibits BCR-ABL.",
                mechanism_of_action: "BCR-ABL inhibitor.",
                toxicity: "Hepatotoxicity possible.",
                half_life: "18 hours",
                targets: [
                    {
                        name: "BCR-ABL",
                        gene_name: "ABL1",
                        actions: ["inhibitor"],
                        known_action: "yes",
                    },
                ],
                drug_interactions: [
                    {
                        drugbank_id: "DB00682",
                        name: "Warfarin",
                        description: "May increase anticoagulant effect.",
                    },
                ],
            }),
        );

        const { ctx } = makeToolContext();
        const result = (await searchDrugbankTool.execute({ query: "DB00619", searchType: "drug", limit: 10 }, ctx))._unsafeUnwrap();

        expect(result.drugs).toHaveLength(1);
        const drug = result.drugs[0]!;
        expect(drug.drugbankId).toBe("DB00619");
        expect(drug.name).toBe("Imatinib");
        expect(drug.targets).toHaveLength(1);
        expect(drug.targets[0]!.geneSymbol).toBe("ABL1");
        expect(drug.interactions[0]!.name).toBe("Warfarin");
    });

    it("maps an array payload from a target-driven lookup", async () => {
        stubFetch(() =>
            json([
                {
                    drugbank_id: "DB00619",
                    name: "Imatinib",
                    targets: [{ name: "BCR-ABL", gene_name: "ABL1", actions: ["inhibitor"] }],
                },
                {
                    drugbank_id: "DB01254",
                    name: "Dasatinib",
                    targets: [{ name: "BCR-ABL", gene_name: "ABL1", actions: ["inhibitor"] }],
                },
            ]),
        );

        const { ctx } = makeToolContext();
        const result = (await searchDrugbankTool.execute({ query: "ABL1", searchType: "target", limit: 10 }, ctx))._unsafeUnwrap();

        expect(result.drugs).toHaveLength(2);
        expect(result.drugs.map((d) => d.drugbankId)).toEqual(["DB00619", "DB01254"]);
    });

    it("rejects input failing Zod validation (limit > 50)", async () => {
        await expect(
            searchDrugbankTool.inputSchema.parseAsync({
                query: "imatinib",
                searchType: "drug",
                limit: 999,
            }),
        ).rejects.toThrow();
    });

    it("throws when DRUGBANK_API_KEY is unset", async () => {
        const { ctx } = makeToolContext();
        await expect(searchDrugbankToolNoKey.execute({ query: "imatinib", searchType: "drug", limit: 10 }, ctx)).rejects.toThrow(/DRUGBANK_API_KEY/);
    });

    it("throws on upstream 5xx failure", async () => {
        stubFetch(() => new Response("upstream down", { status: 500 }));

        const { ctx } = makeToolContext();
        await expect(searchDrugbankTool.execute({ query: "imatinib", searchType: "drug", limit: 10 }, ctx)).rejects.toThrow();
    });
});
