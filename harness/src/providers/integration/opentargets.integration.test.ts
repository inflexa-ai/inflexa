/**
 * Live Open Targets contract check.
 *
 * The client sends one GraphQL POST and validates the data envelope with zod.
 * One real request proves that the live payload still passes that schema.
 *
 * Gated on `CORTEX_LIVE_API_TESTS`. Without the gate the block runs on each
 * clean checkout, and the suite then depends on the network.
 */

import { describe, expect, test } from "bun:test";

import { searchTargetAssociations } from "../../tools/lib/opentargets-client.js";

const LIVE = process.env.CORTEX_LIVE_API_TESTS;

/** TP53. */
const TP53_ENSEMBL_ID = "ENSG00000141510";

describe.skipIf(!LIVE)("live Open Targets", () => {
    test("the target-association schema accepts the live payload for TP53", async () => {
        const info = await searchTargetAssociations(TP53_ENSEMBL_ID, 5);

        expect(info).not.toBe(null);
        expect(info!.ensemblId).toBe(TP53_ENSEMBL_ID);
        expect(info!.approvedSymbol).toBe("TP53");
        expect(info!.approvedName.length).toBeGreaterThan(0);
        expect(info!.tractability).not.toBe(null);
        expect(info!.associations.length).toBeGreaterThan(0);

        const association = info!.associations[0]!;
        expect(association.diseaseId.length).toBeGreaterThan(0);
        expect(typeof association.score).toBe("number");
    }, 60_000);
});
