/**
 * Live ChEMBL contract check.
 *
 * The shipped client validates each molecule record with zod. This test makes
 * one real request and proves that the live payload still passes that schema.
 *
 * Gated on `CORTEX_LIVE_API_TESTS`. Without the gate the block runs on each
 * clean checkout, and the suite then depends on the network.
 */

import { describe, expect, test } from "bun:test";

import { searchCompounds } from "../../tools/lib/chembl-client.js";

const LIVE = process.env.CORTEX_LIVE_API_TESTS;

describe.skipIf(!LIVE)("live ChEMBL", () => {
    test("the compound search schema accepts the live payload for imatinib", async () => {
        const compounds = await searchCompounds("imatinib", "compound", 5);

        expect(compounds.length).toBeGreaterThan(0);
        const first = compounds[0]!;
        expect(first.chemblId).toMatch(/^CHEMBL\d+$/);
        expect(first).toHaveProperty("preferredCompoundName");
        expect(first).toHaveProperty("canonicalSmiles");
        expect(first).toHaveProperty("molecularWeight");
        expect(first).toHaveProperty("molecularFormula");
    }, 60_000);
});
