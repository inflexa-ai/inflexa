import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { genePreclinicalProfileTool } from "./gene-preclinical-profile.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

/** Route a stubbed fetch by URL substring. */
function stubFetch(routes: Array<[string, () => Response]>): void {
    globalThis.fetch = (async (url: string | URL) => {
        const u = String(url);
        for (const [needle, make] of routes) {
            if (u.includes(needle)) return make();
        }
        return new Response("unrouted", { status: 404 });
    }) as typeof fetch;
}

const geneDocs = (docs: unknown[]) => json({ response: { docs } });

const IMPC_ROUTES: Array<[string, () => Response]> = [
    ["/gene/select", () => geneDocs([{ marker_symbol: "Brca1", mgi_accession_id: "MGI:104537" }])],
    [
        "/genotype-phenotype/select",
        () =>
            json({
                response: {
                    numFound: 2,
                    docs: [
                        {
                            mp_term_id: "MP:0001392",
                            mp_term_name: "abnormal locomotor behavior",
                            p_value: 0.001,
                            top_level_mp_term_name: ["behavior/neurological phenotype"],
                            sex: "male",
                        },
                    ],
                },
            }),
    ],
    ["/statistical-result/select", () => json({ response: { docs: [] } })],
];

describe("genePreclinicalProfile — knockout half", () => {
    it("returns a populated profile for a gene with a mouse knockout", async () => {
        stubFetch(IMPC_ROUTES);

        const { ctx } = makeToolContext();
        const result = (await genePreclinicalProfileTool.execute({ geneSymbol: "BRCA1", include: ["knockout"] }, ctx))._unsafeUnwrap();

        expect(result.knockout!.mouseMarkerSymbol).toBe("Brca1");
        expect(result.knockout!.mgiAccessionId).toBe("MGI:104537");
        expect(result.knockout!.mpTerms.length).toBeGreaterThan(0);
        expect(result.knockout!.mpTerms[0]!.id).toBe("MP:0001392");
        expect(result.knockout!.phenotypesTrimmed).toBe(false);
    });

    it("returns an empty profile when no mouse knockout exists (does not throw)", async () => {
        stubFetch([["/gene/select", () => geneDocs([])]]);

        const { ctx } = makeToolContext();
        const result = (await genePreclinicalProfileTool.execute({ geneSymbol: "NOTAGENE", include: ["knockout"] }, ctx))._unsafeUnwrap();

        expect(result.knockout!.mouseMarkerSymbol).toBeNull();
        expect(result.knockout!.mgiAccessionId).toBeNull();
        expect(result.knockout!.viability).toBeNull();
        expect(result.knockout!.mpTerms).toEqual([]);
        expect(result.knockout!.phenotypeCount).toBe(0);
    });

    it("trims phenotype terms to phenotypeLimit while reporting the true count", async () => {
        stubFetch([
            ["/gene/select", () => geneDocs([{ marker_symbol: "Brca1", mgi_accession_id: "MGI:104537" }])],
            [
                "/genotype-phenotype/select",
                () =>
                    json({
                        response: {
                            numFound: 5,
                            docs: Array.from({ length: 5 }, (_, i) => ({
                                mp_term_id: `MP:000000${i}`,
                                mp_term_name: `phenotype ${i}`,
                                p_value: 0.001 * (i + 1),
                                top_level_mp_term_name: ["behavior/neurological phenotype"],
                                sex: "male",
                            })),
                        },
                    }),
            ],
            ["/statistical-result/select", () => json({ response: { docs: [] } })],
        ]);

        const { ctx } = makeToolContext();
        const result = (await genePreclinicalProfileTool.execute({ geneSymbol: "BRCA1", include: ["knockout"], phenotypeLimit: 2 }, ctx))._unsafeUnwrap();

        expect(result.knockout!.mpTerms).toHaveLength(2);
        expect(result.knockout!.phenotypeCount).toBe(5);
        expect(result.knockout!.phenotypesTrimmed).toBe(true);
        // Best p-value first survives the trim.
        expect(result.knockout!.mpTerms[0]!.id).toBe("MP:0000000");
    });

    it("throws on an upstream 5xx failure", async () => {
        stubFetch([["/gene/select", () => new Response("upstream down", { status: 500 })]]);

        const { ctx } = makeToolContext();
        await expect(genePreclinicalProfileTool.execute({ geneSymbol: "BRCA1", include: ["knockout"] }, ctx)).rejects.toThrow();
    });
});

describe("genePreclinicalProfile — both halves", () => {
    it("fetches expression and knockout together by default", async () => {
        const seen: string[] = [];
        globalThis.fetch = (async (url: string | URL) => {
            const u = String(url);
            seen.push(u);
            if (u.includes("ensembl")) return json({ id: "ENSG00000012048" });
            if (u.includes("bgee")) return json({ data: { calls: [] } });
            for (const [needle, make] of IMPC_ROUTES) {
                if (u.includes(needle)) return make();
            }
            return new Response("unrouted", { status: 404 });
        }) as typeof fetch;

        const { ctx } = makeToolContext();
        const result = (await genePreclinicalProfileTool.execute({ geneSymbol: "BRCA1" }, ctx))._unsafeUnwrap();

        expect(result.expression).toBeDefined();
        expect(result.knockout).toBeDefined();
        expect(seen.some((u) => u.includes("bgee"))).toBe(true);
        expect(seen.some((u) => u.includes("/gene/select"))).toBe(true);
    });
});
