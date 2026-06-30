import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createSearchDisgenetTool } from "./search-disgenet.js";

const searchDisgenetTool = createSearchDisgenetTool({ apiKey: "test-key" });
const searchDisgenetToolNoKey = createSearchDisgenetTool({ apiKey: "" });

const realFetch = globalThis.fetch;
const ORIGINAL_KEY = process.env.DISGENET_API_KEY;

beforeEach(() => {
    process.env.DISGENET_API_KEY = "test-key";
});

afterEach(() => {
    globalThis.fetch = realFetch;
    if (ORIGINAL_KEY === undefined) {
        delete process.env.DISGENET_API_KEY;
    } else {
        process.env.DISGENET_API_KEY = ORIGINAL_KEY;
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

describe("searchDisgenet (gene-disease associations)", () => {
    it("maps a populated GDA list for a gene search", async () => {
        stubFetch(() =>
            json([
                {
                    gene_symbol: "TP53",
                    gene_name: "tumor protein p53",
                    geneid: 7157,
                    disease_name: "Li-Fraumeni Syndrome",
                    diseaseid: "C0085390",
                    disease_type: "disease",
                    score: 0.95,
                    ei: 1.0,
                    year_initial: 1990,
                    year_final: 2024,
                    pmid_count: 500,
                    source: "CURATED",
                },
            ]),
        );

        const { ctx } = makeToolContext();
        const result = (
            await searchDisgenetTool.execute(
                {
                    query: "TP53",
                    searchType: "gene",
                    minScore: 0.1,
                    source: "ALL",
                    limit: 25,
                },
                ctx,
            )
        )._unsafeUnwrap();

        expect(result.associations).toHaveLength(1);
        const gda = result.associations[0]!;
        expect(gda.geneSymbol).toBe("TP53");
        expect(gda.geneId).toBe(7157);
        expect(gda.diseaseId).toBe("C0085390");
        expect(gda.score).toBe(0.95);
        expect(gda.nPmids).toBe(500);
    });

    it("returns an empty associations list for an empty upstream payload", async () => {
        stubFetch(() => json([]));

        const { ctx } = makeToolContext();
        const result = (
            await searchDisgenetTool.execute(
                {
                    query: "C9999999",
                    searchType: "disease",
                    minScore: 0.1,
                    source: "ALL",
                    limit: 25,
                },
                ctx,
            )
        )._unsafeUnwrap();

        expect(result.associations).toEqual([]);
    });

    it("rejects input failing Zod validation (minScore > 1)", async () => {
        await expect(
            searchDisgenetTool.inputSchema.parseAsync({
                query: "TP53",
                searchType: "gene",
                minScore: 2,
                source: "ALL",
                limit: 25,
            }),
        ).rejects.toThrow();
    });

    it("throws when DISGENET_API_KEY is unset", async () => {
        const { ctx } = makeToolContext();
        await expect(
            searchDisgenetToolNoKey.execute(
                {
                    query: "TP53",
                    searchType: "gene",
                    minScore: 0.1,
                    source: "ALL",
                    limit: 25,
                },
                ctx,
            ),
        ).rejects.toThrow(/DISGENET_API_KEY/);
    });

    it("throws on upstream 5xx failure", async () => {
        stubFetch(() => new Response("upstream down", { status: 500 }));

        const { ctx } = makeToolContext();
        await expect(
            searchDisgenetTool.execute(
                {
                    query: "TP53",
                    searchType: "gene",
                    minScore: 0.1,
                    source: "ALL",
                    limit: 25,
                },
                ctx,
            ),
        ).rejects.toThrow();
    });
});
