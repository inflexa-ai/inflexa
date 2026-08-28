/**
 * Live ClinPGx contract check.
 *
 * ClinPGx succeeds PharmGKB, and it serves the same clinical-annotation
 * envelope from `api.clinpgx.org`. One real request proves that the live
 * payload still passes the shipped zod schema.
 *
 * Gated on `CORTEX_LIVE_API_TESTS`. Without the gate the block runs on each
 * clean checkout, and the suite then depends on the network.
 */

import { describe, expect, test } from "bun:test";

import { searchPharmgkb } from "../../tools/lib/pharmgkb-client.js";

const LIVE = process.env.CORTEX_LIVE_API_TESTS;

describe.skipIf(!LIVE)("live ClinPGx", () => {
    test("the clinical-annotation schema accepts the live payload for CYP2C19", async () => {
        const result = await searchPharmgkb("CYP2C19", "gene", 5);

        expect(result.totalFound).toBeGreaterThan(0);
        expect(result.annotations.length).toBeGreaterThan(0);

        const annotation = result.annotations[0]!;
        expect(annotation.gene).toContain("CYP2C19");
        expect(typeof annotation.drug).toBe("string");
        expect(annotation.levelOfEvidence.length).toBeGreaterThan(0);
    }, 60_000);
});
