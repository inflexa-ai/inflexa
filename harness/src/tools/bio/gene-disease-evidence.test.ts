import { afterEach, describe, expect, it } from "bun:test";

import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createGeneDiseaseEvidenceTool } from "./gene-disease-evidence.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(response: (url: string) => Response): void {
    globalThis.fetch = (async (input: unknown) => response(String(input))) as unknown as typeof fetch;
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
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const GWAS_ASSOCIATION = {
    pvalueMantissa: 5,
    pvalueExponent: -20,
    riskFrequency: "0.10",
    orPerCopyNum: 2.5,
    range: "[2.1-3.0]",
    loci: [{ strongestRiskAlleles: [{ riskAlleleName: "rs11591147-T" }], authorReportedGenes: [{ geneName: "PCSK9" }] }],
    efoTraits: [{ trait: "LDL cholesterol" }],
    study: { accessionId: "GCST000001", pubmedId: "12345678", initialSampleSize: "10,000 European ancestry" },
};

const tool = createGeneDiseaseEvidenceTool({ disgenetApiKey: "test-key", ncbiApiKey: "test-ncbi" });
const toolNoDisgenetKey = createGeneDiseaseEvidenceTool({ disgenetApiKey: "" });

function outcome(perSource: { source: string; status: string }[], source: string) {
    return perSource.find((s) => s.source === source);
}

describe("geneDiseaseEvidence — GWAS Catalog corpus", () => {
    it("maps a direct rsID lookup", async () => {
        stubFetch(() => json({ _embedded: { associations: [GWAS_ASSOCIATION] }, page: { totalElements: 1 } }));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "rs11591147", queryType: "variant", sources: ["gwas"] }, ctx))._unsafeUnwrap();

        expect(result.gwas).toHaveLength(1);
        const assoc = result.gwas![0]!;
        expect(assoc.trait).toBe("LDL cholesterol");
        expect(assoc.mappedGenes).toEqual(["PCSK9"]);
        expect(assoc.orBeta).toBe(2.5);
        expect(assoc.studyAccession).toBe("GCST000001");
        expect(outcome(result.perSource, "gwas")).toMatchObject({ status: "ok", returned: 1, totalFound: 1 });
    });

    it("maps queryType 'disease' onto the GWAS trait path", async () => {
        stubFetchSequence([
            () => json({ _embedded: { efoTraits: [{ _links: { self: { href: "https://example/efoTraits/EFO_0004611" } } }] } }),
            () => json({ _embedded: { associations: [GWAS_ASSOCIATION] }, page: { totalElements: 1 } }),
        ]);

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "LDL cholesterol", queryType: "disease", sources: ["gwas"] }, ctx))._unsafeUnwrap();

        expect(result.gwas).toHaveLength(1);
        expect(result.gwas![0]!.trait).toBe("LDL cholesterol");
    });

    it("walks SNP-by-gene then per-SNP associations for queryType 'gene'", async () => {
        stubFetchSequence([
            () => json({ _embedded: { singleNucleotidePolymorphisms: [{ rsId: "rs11591147", _links: { associations: { href: "https://example/a" } } }] } }),
            () => json({ _embedded: { associations: [{ ...GWAS_ASSOCIATION, pvalueMantissa: 1, pvalueExponent: -10 }] } }),
        ]);

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "PCSK9", queryType: "gene", sources: ["gwas"] }, ctx))._unsafeUnwrap();

        expect(result.gwas).toHaveLength(1);
        expect(result.gwas![0]!.rsId).toBe("rs11591147");
    });

    it("reports no_data rather than an error when nothing matches", async () => {
        stubFetch(() => json({ _embedded: { efoTraits: [] } }));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "no-such-trait-xyz", queryType: "disease", sources: ["gwas"] }, ctx))._unsafeUnwrap();

        expect(result.gwas).toEqual([]);
        expect(outcome(result.perSource, "gwas")).toMatchObject({ status: "no_data", returned: 0 });
    });
});

describe("geneDiseaseEvidence — DisGeNET corpus", () => {
    it("normalizes GDA records to camelCase", async () => {
        stubFetch(() =>
            json([
                {
                    gene_symbol: "PCSK9",
                    gene_name: "proprotein convertase subtilisin/kexin type 9",
                    geneid: 255738,
                    disease_name: "Hypercholesterolemia",
                    diseaseid: "C0020443",
                    disease_type: "disease",
                    score: 0.8,
                    ei: 1,
                    pmid_count: 42,
                    source: "CURATED",
                },
            ]),
        );

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "PCSK9", queryType: "gene", sources: ["disgenet"] }, ctx))._unsafeUnwrap();

        expect(result.disgenet).toHaveLength(1);
        expect(result.disgenet![0]).toMatchObject({ geneSymbol: "PCSK9", diseaseId: "C0020443", score: 0.8, evidenceIndex: 1, nPmids: 42 });
    });

    it("degrades to 'unavailable' when the key is absent, without an HTTP call", async () => {
        let called = false;
        stubFetch(() => {
            called = true;
            return json([]);
        });

        const { ctx } = makeToolContext();
        const result = (await toolNoDisgenetKey.execute({ query: "PCSK9", queryType: "gene", sources: ["disgenet"] }, ctx))._unsafeUnwrap();

        expect(called).toBe(false);
        expect(outcome(result.perSource, "disgenet")).toMatchObject({ status: "unavailable" });
        expect(outcome(result.perSource, "disgenet")!.detail).toContain("DISGENET_API_KEY");
    });

    it("is marked not_applicable for queryType 'variant'", async () => {
        stubFetch(() => json({ _embedded: { associations: [] } }));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "rs11591147", queryType: "variant", sources: ["gwas", "disgenet"] }, ctx))._unsafeUnwrap();

        expect(outcome(result.perSource, "disgenet")).toMatchObject({ status: "not_applicable", returned: 0 });
        expect(result.disgenet).toBeUndefined();
    });
});

describe("geneDiseaseEvidence — ClinVar corpus", () => {
    const esearch = { esearchresult: { idlist: ["12345", "67890"], count: "2" } };
    const esummary = {
        result: {
            uids: ["12345", "67890"],
            "12345": {
                title: "NM_174936.4(PCSK9):c.2004C>A",
                accession: "VCV000012345",
                genes: [{ symbol: "PCSK9" }],
                germline_classification: { description: "Pathogenic", review_status: "criteria provided", trait_set: [{ trait_name: "Hypercholesterolemia" }] },
            },
            "67890": {
                title: "NM_174936.4(PCSK9):c.9999G>T",
                accession: "VCV000067890",
                genes: [{ symbol: "PCSK9" }],
                germline_classification: { description: "not provided", review_status: "no assertion" },
            },
        },
    };

    it("drops uninformative classifications by default", async () => {
        stubFetch((url) => (url.includes("esearch") ? json(esearch) : json(esummary)));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "PCSK9", queryType: "gene", sources: ["clinvar"] }, ctx))._unsafeUnwrap();

        expect(result.clinvar).toHaveLength(1);
        expect(result.clinvar![0]!.clinicalSignificance).toBe("Pathogenic");
        expect(result.clinvar![0]!.conditions).toEqual(["Hypercholesterolemia"]);
        // totalFound is the corpus count, not the post-filter count.
        expect(outcome(result.perSource, "clinvar")).toMatchObject({ status: "ok", returned: 1, totalFound: 2 });
    });

    it("keeps them when informativeOnly is false", async () => {
        stubFetch((url) => (url.includes("esearch") ? json(esearch) : json(esummary)));

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "PCSK9", queryType: "gene", sources: ["clinvar"], informativeOnly: false }, ctx))._unsafeUnwrap();

        expect(result.clinvar).toHaveLength(2);
    });
});

describe("geneDiseaseEvidence — fan-out", () => {
    it("queries all applicable corpora by default", async () => {
        const seen: string[] = [];
        stubFetch((url) => {
            seen.push(url);
            if (url.includes("disgenet")) return json([]);
            if (url.includes("esearch")) return json({ esearchresult: { idlist: [], count: "0" } });
            return json({ _embedded: { singleNucleotidePolymorphisms: [] } });
        });

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "PCSK9", queryType: "gene" }, ctx))._unsafeUnwrap();

        expect(result.perSource.map((s) => s.source).sort()).toEqual(["clinvar", "disgenet", "gwas"]);
        expect(seen.some((u) => u.includes("gwas"))).toBe(true);
        expect(seen.some((u) => u.includes("disgenet"))).toBe(true);
    });

    it("does not let one failing corpus fail the call", async () => {
        stubFetch((url) => {
            if (url.includes("gwas")) return new Response("upstream down", { status: 500 });
            return json([{ gene_symbol: "PCSK9", disease_name: "Hypercholesterolemia", diseaseid: "C0020443", score: 0.8 }]);
        });

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "PCSK9", queryType: "gene", sources: ["gwas", "disgenet"] }, ctx))._unsafeUnwrap();

        expect(outcome(result.perSource, "gwas")).toMatchObject({ status: "unavailable", returned: 0 });
        expect(outcome(result.perSource, "disgenet")).toMatchObject({ status: "ok", returned: 1 });
        expect(result.disgenet).toHaveLength(1);
    });

    it("rejects a limit above the per-source ceiling at the schema boundary", async () => {
        await expect(tool.inputSchema.parseAsync({ query: "PCSK9", queryType: "gene", limit: 999 })).rejects.toThrow();
    });

    it("keeps cbioportal out of the default set — it scans every curated study", async () => {
        stubFetch((url) => {
            if (url.includes("disgenet")) return json([]);
            if (url.includes("esearch")) return json({ esearchresult: { idlist: [], count: "0" } });
            return json({ _embedded: { singleNucleotidePolymorphisms: [] } });
        });

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "PCSK9", queryType: "gene" }, ctx))._unsafeUnwrap();

        expect(result.perSource.map((s) => s.source)).not.toContain("cbioportal");
    });

    it("reads one GWAS study back by its accession, and marks the other corpora not_applicable", async () => {
        const seen: string[] = [];
        stubFetch((url) => {
            seen.push(url);
            return json({ _embedded: { associations: [GWAS_ASSOCIATION] }, page: { totalElements: 1 } });
        });

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "GCST000392", queryType: "gwas_study" }, ctx))._unsafeUnwrap();

        expect(seen[0]).toContain("/studies/GCST000392/associations");
        expect(outcome(result.perSource, "gwas")).toMatchObject({ status: "ok", returned: 1 });
        expect(result.perSource.filter((s) => s.status === "not_applicable")).toHaveLength(0);
        expect(result.disgenet).toBeUndefined();
    });

    it("reads one ClinVar record back by its accession, and reports the corpora that cannot", async () => {
        const seen: string[] = [];
        stubFetch((url) => {
            seen.push(url);
            return json({ esearchresult: { idlist: [], count: "0" } });
        });

        const { ctx } = makeToolContext();
        const result = (await tool.execute({ query: "VCV000012345", queryType: "clinvar_accession", sources: ["clinvar", "gwas"] }, ctx))._unsafeUnwrap();

        expect(seen.every((u) => u.includes("eutils"))).toBe(true);
        expect(outcome(result.perSource, "clinvar")).toMatchObject({ status: "no_data" });
        expect(outcome(result.perSource, "gwas")).toMatchObject({ status: "not_applicable" });
    });
});
