/**
 * Live GWAS Catalog contract check.
 *
 * The study path names the `associationByStudy` projection, thus one request
 * carries the association rows and the nested study record. That proves the
 * live payload still passes the shipped zod schema.
 *
 * Gated on `CORTEX_LIVE_API_TESTS`. Without the gate the block runs on each
 * clean checkout, and the suite then depends on the network.
 */

import { describe, expect, test } from "bun:test";

import { searchGwasCatalog } from "../../tools/lib/gwas-catalog-client.js";

const LIVE = process.env.CORTEX_LIVE_API_TESTS;

/** A canonical study accession that the fixture corpus captures too. */
const STUDY_ACCESSION = "GCST000392";

describe.skipIf(!LIVE)("live GWAS Catalog", () => {
    test("the association schema accepts the live payload for a canonical study", async () => {
        const result = await searchGwasCatalog(STUDY_ACCESSION, "study", { limit: 5, pValueThreshold: 1 });

        expect(result.associations.length).toBeGreaterThan(0);
        const association = result.associations[0]!;
        expect(typeof association.pValue).toBe("number");
        expect(association.studyAccession).toBe(STUDY_ACCESSION);
        expect(association).toHaveProperty("rsId");
        expect(association).toHaveProperty("trait");
        expect(Array.isArray(association.mappedGenes)).toBe(true);
    }, 60_000);
});
