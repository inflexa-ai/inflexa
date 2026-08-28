import { expect } from "bun:test";

import { fixtureCase, runFixtureSuite } from "./__fixtures__/fixture-runner.js";
import { ClinvarSearchResponseSchema, ClinvarSummaryResponseSchema, mapClinvarVariants } from "./clinvar-client.js";

/** The uid order of the esummary fixture, as the esearch of the same query gave it. */
const SUMMARY_IDS = ["4886459", "4885790", "4884744", "4884209", "4884188"];

runFixtureSuite("ClinVar golden fixtures", [
    fixtureCase({
        name: "ClinvarSearchResponseSchema",
        provider: "clinvar",
        fixture: "esearch_BRCA1.json",
        drift: "esearch_BRCA1.drift.json",
        schema: ClinvarSearchResponseSchema,
        assertOutput: (res) => {
            // Each esearch scalar is a string, thus the count reaches the caller
            // only through a numeric read.
            expect(typeof res.esearchresult?.count).toBe("string");
            expect(Number(res.esearchresult?.count)).toBe(85233);
            expect(res.esearchresult?.idlist?.length).toBe(5);
        },
    }),
    fixtureCase({
        name: "ClinvarSearchResponseSchema, the clinsig_vus property",
        provider: "clinvar",
        fixture: "esearch_sigmap_vus_probe.json",
        drift: "esearch_BRCA1.drift.json",
        schema: ClinvarSearchResponseSchema,
        assertOutput: (res) => {
            // `clinsig_vus` is the Entrez property of an uncertain classification.
            // The retired `clinsig_uncertain` gives count 0 and a
            // `phrasesnotfound` record.
            expect(Number(res.esearchresult?.count)).toBe(19046);
            expect(res.esearchresult?.idlist?.length).toBeGreaterThan(0);
        },
    }),
    fixtureCase({
        name: "ClinvarSummaryResponseSchema",
        provider: "clinvar",
        fixture: "esummary_BRCA1_multi.json",
        drift: "esummary_BRCA1_multi.drift.json",
        schema: ClinvarSummaryResponseSchema,
        assertOutput: (res) => {
            const variants = mapClinvarVariants(SUMMARY_IDS, res);
            expect(variants.length).toBe(5);
            for (const variant of variants) {
                expect(variant.clinicalSignificance).not.toBe("");
                expect(variant.accession).toMatch(/^VCV/);
                // `variant_type` sits on `variation_set`, thus the fallback of a
                // record with no molecular consequence carries data.
                expect(variant.molecularConsequence).not.toBe("");
            }
            // The record of this uid carries an empty `molecular_consequence_list`,
            // and its variant type is the only consequence that the wire holds.
            const copyNumber = variants.find((variant) => variant.variationId === "4884744");
            expect(copyNumber?.molecularConsequence).toBe("copy number loss");
        },
    }),
]);
