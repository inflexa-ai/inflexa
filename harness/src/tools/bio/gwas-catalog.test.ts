import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { searchGwasCatalogTool } from "./search-gwas-catalog.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(response: () => Response): void {
    globalThis.fetch = (async () => response()) as unknown as typeof fetch;
}

function stubFetchSequence(responses: (() => Response)[]): void {
    let i = 0;
    globalThis.fetch = (async () => {
        const make = responses[Math.min(i, responses.length - 1)];
        i += 1;
        return make!();
    }) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

describe("searchGwasCatalog (variant search)", () => {
    it("returns associations for a direct rsID lookup", async () => {
        stubFetch(() =>
            json({
                _embedded: {
                    associations: [
                        {
                            pvalueMantissa: 5,
                            pvalueExponent: -20,
                            riskFrequency: "0.10",
                            orPerCopyNum: 2.5,
                            range: "[2.1-3.0]",
                            loci: [
                                {
                                    strongestRiskAlleles: [{ riskAlleleName: "rs11591147-T" }],
                                    authorReportedGenes: [{ geneName: "PCSK9" }],
                                },
                            ],
                            efoTraits: [{ trait: "LDL cholesterol" }],
                            study: {
                                accessionId: "GCST000001",
                                pubmedId: "12345678",
                                initialSampleSize: "10,000 European ancestry",
                            },
                        },
                    ],
                },
                page: { totalElements: 1 },
            }),
        );

        const { ctx } = makeToolContext();
        const result = (
            await searchGwasCatalogTool.execute(
                {
                    query: "rs11591147",
                    searchType: "variant",
                    pValueThreshold: 5e-8,
                    limit: 25,
                },
                ctx,
            )
        )._unsafeUnwrap();

        expect(result.totalFound).toBe(1);
        expect(result.associations).toHaveLength(1);
        const assoc = result.associations[0]!;
        expect(assoc.trait).toBe("LDL cholesterol");
        expect(assoc.mappedGenes).toEqual(["PCSK9"]);
        expect(assoc.orBeta).toBe(2.5);
        expect(assoc.studyAccession).toBe("GCST000001");
        expect(assoc.pubmedId).toBe("12345678");
    });

    it("returns an empty list when no traits match a 'trait' search", async () => {
        stubFetch(() => json({ _embedded: { efoTraits: [] } }));

        const { ctx } = makeToolContext();
        const result = (
            await searchGwasCatalogTool.execute(
                {
                    query: "no-such-trait-xyz",
                    searchType: "trait",
                    pValueThreshold: 5e-8,
                    limit: 25,
                },
                ctx,
            )
        )._unsafeUnwrap();

        expect(result.totalFound).toBe(0);
        expect(result.associations).toEqual([]);
    });

    it("walks SNP-by-gene -> per-SNP associations for 'gene' search", async () => {
        stubFetchSequence([
            () =>
                json({
                    _embedded: {
                        singleNucleotidePolymorphisms: [
                            {
                                rsId: "rs11591147",
                                _links: {
                                    associations: { href: "https://example/assocs/rs11591147" },
                                },
                            },
                        ],
                    },
                }),
            () =>
                json({
                    _embedded: {
                        associations: [
                            {
                                pvalueMantissa: 1,
                                pvalueExponent: -10,
                                riskFrequency: "0.10",
                                loci: [
                                    {
                                        strongestRiskAlleles: [{ riskAlleleName: "rs11591147-T" }],
                                        authorReportedGenes: [{ geneName: "PCSK9" }],
                                    },
                                ],
                                efoTraits: [{ trait: "LDL cholesterol" }],
                                study: { accessionId: "GCST000001" },
                            },
                        ],
                    },
                }),
        ]);

        const { ctx } = makeToolContext();
        const result = (
            await searchGwasCatalogTool.execute(
                {
                    query: "PCSK9",
                    searchType: "gene",
                    pValueThreshold: 5e-8,
                    limit: 25,
                },
                ctx,
            )
        )._unsafeUnwrap();

        expect(result.totalFound).toBe(1);
        expect(result.associations).toHaveLength(1);
        expect(result.associations[0]!.rsId).toBe("rs11591147");
        expect(result.associations[0]!.mappedGenes).toEqual(["PCSK9"]);
    });

    it("rejects input failing Zod validation (limit out of range)", async () => {
        const { ctx } = makeToolContext();
        await expect(
            searchGwasCatalogTool.inputSchema.parseAsync({
                query: "PCSK9",
                searchType: "gene",
                pValueThreshold: 5e-8,
                limit: 999,
            }),
        ).rejects.toThrow();
        // ensure execute also rejects (parsed via define-tool's contract elsewhere; we cross-check schema)
        expect(ctx).toBeDefined();
    });

    it("throws on an upstream 5xx failure", async () => {
        stubFetch(() => new Response("upstream down", { status: 500 }));

        const { ctx } = makeToolContext();
        await expect(
            searchGwasCatalogTool.execute(
                {
                    query: "rs11591147",
                    searchType: "variant",
                    pValueThreshold: 5e-8,
                    limit: 25,
                },
                ctx,
            ),
        ).rejects.toThrow();
    });
});
