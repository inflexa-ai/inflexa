import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { getImpcKoProfileTool } from "./get-impc-ko-profile.js";

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

describe("getImpcKoProfile (preclinical family)", () => {
    it("returns a populated profile for a gene with a mouse knockout", async () => {
        stubFetch([
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
        ]);

        const { ctx } = makeToolContext();
        const result = (await getImpcKoProfileTool.execute({ geneSymbol: "BRCA1" }, ctx))._unsafeUnwrap();

        expect(result.mouseMarkerSymbol).toBe("Brca1");
        expect(result.mgiAccessionId).toBe("MGI:104537");
        expect(result.mpTerms.length).toBeGreaterThan(0);
        expect(result.mpTerms[0]!.id).toBe("MP:0001392");
    });

    it("returns an empty profile when no mouse knockout exists (does not throw)", async () => {
        stubFetch([["/gene/select", () => geneDocs([])]]);

        const { ctx } = makeToolContext();
        const result = (await getImpcKoProfileTool.execute({ geneSymbol: "NOTAGENE" }, ctx))._unsafeUnwrap();

        expect(result.mouseMarkerSymbol).toBeNull();
        expect(result.mgiAccessionId).toBeNull();
        expect(result.viability).toBeNull();
        expect(result.mpTerms).toEqual([]);
        expect(result.phenotypeCount).toBe(0);
    });

    it("throws on an upstream 5xx failure", async () => {
        stubFetch([["/gene/select", () => new Response("upstream down", { status: 500 })]]);

        const { ctx } = makeToolContext();
        await expect(getImpcKoProfileTool.execute({ geneSymbol: "BRCA1" }, ctx)).rejects.toThrow();
    });
});
