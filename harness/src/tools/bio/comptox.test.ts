import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createComptoxTool } from "./comptox.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Route a stubbed fetch by URL substring; unmatched URLs 404. */
function stubFetch(routes: Array<[string, () => Response]>): void {
    globalThis.fetch = (async (url: string | URL) => {
        const u = String(url);
        for (const [needle, make] of routes) {
            if (u.includes(needle)) return make();
        }
        return new Response("unrouted", { status: 404 });
    }) as typeof fetch;
}

const comptox = createComptoxTool({ apiKey: "test-key" });
const DTXSID = "DTXSID7020182"; // used directly — resolveDtxsid skips the search endpoint

describe("comptox tool — dataset 'toxcast'", () => {
    it("returns the resolved chemical plus assay results with full-panel counts", async () => {
        stubFetch([
            ["/bioactivity/data/summary/", () => json([{ aeid: 10, aenm: "ER_agonist" }])],
            [
                "/bioactivity/data/search/",
                () =>
                    json([
                        { aeid: 10, hitc: 1, modl: "gnls", mc5Param: { ac50: 2.5 } },
                        { aeid: 11, hitc: 0, modl: "cnst", mc5Param: { ac50: 40 } },
                    ]),
            ],
        ]);

        const { ctx } = makeToolContext();
        const result = (await comptox.execute({ dataset: "toxcast", query: DTXSID, activeOnly: false }, ctx))._unsafeUnwrap();

        expect(result.found).toBe(true);
        if (result.found && "chemical" in result) {
            expect(result.chemical.dtxsid).toBe(DTXSID);
            expect(result.chemical.totalAssays).toBe(2);
            expect(result.chemical.activeAssays).toBe(1);
            expect(result.chemical.activeHitRate).toBe(0.5);
            expect(result.chemical.results).toHaveLength(2);
            // sorted by AC50 ascending
            expect(result.chemical.results[0]!.ac50).toBe(2.5);
            expect(result.chemical.results[0]!.assayEndpoint).toBe("ER_agonist");
        }
    });

    it("filters to active hits by default", async () => {
        stubFetch([
            ["/bioactivity/data/summary/", () => json([])],
            [
                "/bioactivity/data/search/",
                () =>
                    json([
                        { aeid: 10, hitc: 1, mc5Param: { ac50: 2.5 } },
                        { aeid: 11, hitc: 0, mc5Param: { ac50: 40 } },
                    ]),
            ],
        ]);

        const { ctx } = makeToolContext();
        const result = (await comptox.execute({ dataset: "toxcast", query: DTXSID }, ctx))._unsafeUnwrap();

        if (result.found && "chemical" in result) {
            expect(result.chemical.totalAssays).toBe(2);
            expect(result.chemical.results).toHaveLength(1);
            expect(result.chemical.results[0]!.hitCall).toBe(1);
        }
    });

    it("throws when the bioactivity endpoint 5xxs", async () => {
        stubFetch([
            ["/bioactivity/data/summary/", () => json([])],
            ["/bioactivity/data/search/", () => new Response("boom", { status: 500 })],
        ]);

        const { ctx } = makeToolContext();
        await expect(comptox.execute({ dataset: "toxcast", query: DTXSID }, ctx)).rejects.toThrow();
    });
});

describe("comptox tool — dataset 'hazard'", () => {
    it("returns toxval/genetox/cancer for dataType all, capping toxval by limit but not cancer", async () => {
        stubFetch([
            [
                "/hazard/toxval/",
                () =>
                    json([
                        { toxvalType: "NOAEL", toxvalNumeric: "5" },
                        { toxvalType: "LOAEL", toxvalNumeric: 10 },
                    ]),
            ],
            ["/hazard/genetox/summary/", () => json([{ assayType: "Ames", overallResult: "negative" }])],
            [
                "/hazard/cancer-summary/",
                () =>
                    json([
                        { source: "IARC", classification: "Group 2B" },
                        { source: "NTP", cancerClassification: "R" },
                    ]),
            ],
        ]);

        const { ctx } = makeToolContext();
        const result = (await comptox.execute({ dataset: "hazard", query: DTXSID, limit: 1 }, ctx))._unsafeUnwrap();

        expect(result.found).toBe(true);
        if (result.found && "toxval" in result) {
            expect(result.toxval).toHaveLength(1); // capped
            expect(result.toxval![0]!.toxvalNumeric).toBe(5);
            expect(result.genetox).toHaveLength(1);
            expect(result.cancer).toHaveLength(2); // NOT capped
            expect(result.cancer![1]!.classification).toBe("R"); // cancerClassification fallback
        }
    });

    it("fetches only toxval when dataType is 'toxval'", async () => {
        stubFetch([["/hazard/toxval/", () => json([{ toxvalType: "LD50", toxvalNumeric: 2000 }])]]);

        const { ctx } = makeToolContext();
        const result = (await comptox.execute({ dataset: "hazard", query: DTXSID, dataType: "toxval" }, ctx))._unsafeUnwrap();

        if (result.found && "toxval" in result) {
            expect(result.toxval).toHaveLength(1);
            expect(result.genetox).toBeUndefined();
            expect(result.cancer).toBeUndefined();
        }
    });
});

describe("comptox tool — dataset 'chemical'", () => {
    it("returns identity detail plus property summaries by default", async () => {
        stubFetch([
            ["/chemical/detail/", () => json({ dtxsid: DTXSID, casrn: "80-05-7", preferredName: "Bisphenol A", pubchemCid: 6623 })],
            ["/chemical/property/summary/", () => json([{ propName: "logP", unit: "", experimentalMedian: 3.32 }])],
        ]);

        const { ctx } = makeToolContext();
        const result = (await comptox.execute({ dataset: "chemical", query: DTXSID }, ctx))._unsafeUnwrap();

        if (result.found && "detail" in result) {
            expect(result.detail.casrn).toBe("80-05-7");
            expect(result.detail.pubchemCid).toBe(6623);
            expect(result.properties).toHaveLength(1);
            expect(result.properties![0]!.propName).toBe("logP");
        }
    });

    it("skips the property call when includeProperties is false", async () => {
        stubFetch([["/chemical/detail/", () => json({ dtxsid: DTXSID, preferredName: "Bisphenol A" })]]);

        const { ctx } = makeToolContext();
        const result = (await comptox.execute({ dataset: "chemical", query: DTXSID, includeProperties: false }, ctx))._unsafeUnwrap();

        if (result.found && "detail" in result) {
            expect(result.detail.preferredName).toBe("Bisphenol A");
            expect(result.properties).toBeUndefined();
        }
    });

    it("throws when the detail endpoint 5xxs", async () => {
        stubFetch([["/chemical/detail/", () => new Response("boom", { status: 500 })]]);

        const { ctx } = makeToolContext();
        await expect(comptox.execute({ dataset: "chemical", query: DTXSID }, ctx)).rejects.toThrow();
    });
});

describe("comptox tool — dataset 'exposure'", () => {
    it("maps SEEM production volume and per-pathway probabilities (incl. the API misspelling)", async () => {
        stubFetch([
            [
                "/exposure/seem/general/",
                () => json({ dtxsid: DTXSID, productionVolume: 1000, units: "kg/yr", probabilityDietary: 0.9, probabilityPesticde: 0.1 }),
            ],
            ["/exposure/httk/", () => json([{ parameter: "Clint", predicted: 12 }])],
            ["/exposure/functional-use/", () => json([{ functioncategory: "plasticizer" }])],
            ["/exposure/product-data/", () => json([{ productname: "epoxy resin" }])],
        ]);

        const { ctx } = makeToolContext();
        const result = (await comptox.execute({ dataset: "exposure", query: DTXSID }, ctx))._unsafeUnwrap();

        if (result.found && "seem" in result) {
            expect(result.seem!.productionVolume).toBe(1000);
            expect(result.seem!.probabilityDietary).toBe(0.9);
            expect(result.seem!.probabilityPesticide).toBe(0.1); // read from the misspelled wire field
            expect(result.httk).toHaveLength(1);
            expect(result.functionalUse![0]!.functionCategory).toBe("plasticizer");
            expect(result.productData![0]!.productName).toBe("epoxy resin");
        }
    });

    it("fetches only seem when dataType is 'seem'", async () => {
        stubFetch([["/exposure/seem/general/", () => json({ dtxsid: DTXSID, productionVolume: 5 })]]);

        const { ctx } = makeToolContext();
        const result = (await comptox.execute({ dataset: "exposure", query: DTXSID, dataType: "seem" }, ctx))._unsafeUnwrap();

        if (result.found && "seem" in result) {
            expect(result.seem!.productionVolume).toBe(5);
            expect(result.httk).toBeUndefined();
            expect(result.functionalUse).toBeUndefined();
        }
    });
});

describe("comptox tool — chemical resolution", () => {
    it("resolves a name via the exact-match search endpoint", async () => {
        stubFetch([
            ["/chemical/search/equal/", () => json([{ dtxsid: DTXSID, preferredName: "Bisphenol A", casrn: "80-05-7" }])],
            ["/bioactivity/data/summary/", () => json([])],
            ["/bioactivity/data/search/", () => json([{ aeid: 1, hitc: 1, mc5Param: { ac50: 3 } }])],
        ]);

        const { ctx } = makeToolContext();
        const result = (await comptox.execute({ dataset: "toxcast", query: "bisphenol A", activeOnly: false }, ctx))._unsafeUnwrap();

        if (result.found && "chemical" in result) {
            expect(result.chemical.dtxsid).toBe(DTXSID);
            expect(result.chemical.preferredName).toBe("Bisphenol A");
            expect(result.chemical.casrn).toBe("80-05-7");
        }
    });

    it("returns found:false when the query resolves to no chemical", async () => {
        stubFetch([["/chemical/search/equal/", () => json([])]]);

        const { ctx } = makeToolContext();
        const result = (await comptox.execute({ dataset: "hazard", query: "not-a-real-chemical" }, ctx))._unsafeUnwrap();

        expect(result.found).toBe(false);
        if (!result.found) expect(result.query).toBe("not-a-real-chemical");
    });
});

describe("comptox tool — missing EPA key", () => {
    it("throws terminally when the key is empty", async () => {
        const keyless = createComptoxTool({ apiKey: "" });
        const { ctx } = makeToolContext();
        await expect(keyless.execute({ dataset: "chemical", query: DTXSID }, ctx)).rejects.toThrow(/EPA_CCTE_API_KEY/);
    });
});

describe("comptox tool — refine guards", () => {
    it("rejects a hazard dataType under dataset 'exposure'", () => {
        const parsed = comptox.inputSchema.safeParse({ dataset: "exposure", query: DTXSID, dataType: "toxval" });
        expect(parsed.success).toBe(false);
        expect(JSON.stringify(parsed.error?.issues)).toContain("dataType must be 'seem'");
    });

    it("rejects an exposure dataType under dataset 'hazard'", () => {
        const parsed = comptox.inputSchema.safeParse({ dataset: "hazard", query: DTXSID, dataType: "seem" });
        expect(parsed.success).toBe(false);
        expect(JSON.stringify(parsed.error?.issues)).toContain("dataType must be 'toxval'");
    });

    it("rejects dataType on dataset 'toxcast' (owns no sections)", () => {
        const parsed = comptox.inputSchema.safeParse({ dataset: "toxcast", query: DTXSID, dataType: "toxval" });
        expect(parsed.success).toBe(false);
        expect(JSON.stringify(parsed.error?.issues)).toContain("dataType applies only to dataset 'hazard'");
    });

    it("rejects limit above 100 for dataset 'hazard'", () => {
        const parsed = comptox.inputSchema.safeParse({ dataset: "hazard", query: DTXSID, limit: 200 });
        expect(parsed.success).toBe(false);
        expect(JSON.stringify(parsed.error?.issues)).toContain("limit is capped at 100");
    });

    it("accepts limit up to 200 for dataset 'toxcast'", () => {
        const parsed = comptox.inputSchema.safeParse({ dataset: "toxcast", query: DTXSID, limit: 200 });
        expect(parsed.success).toBe(true);
    });

    it("accepts a bare well-formed call (dataType omitted defaults to all)", () => {
        const parsed = comptox.inputSchema.safeParse({ dataset: "hazard", query: DTXSID });
        expect(parsed.success).toBe(true);
    });
});
