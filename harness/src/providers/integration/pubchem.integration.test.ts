/**
 * Live PubChem PUG-REST contract check.
 *
 * The property table arrives with the molecular weight as a string, thus the
 * schema reads it through the wire-number helper. One real request proves that
 * the live payload still passes the schema and maps to a number.
 *
 * Gated on `CORTEX_LIVE_API_TESTS`. Without the gate the block runs on each
 * clean checkout, and the suite then depends on the network.
 */

import { describe, expect, test } from "bun:test";

import { getCompoundPropertiesByCID } from "../../tools/lib/pubchem-client.js";

const LIVE = process.env.CORTEX_LIVE_API_TESTS;

/** Aspirin. The fixture corpus captures the same identifier. */
const ASPIRIN_CID = 2244;

describe.skipIf(!LIVE)("live PubChem", () => {
    test("the property schema accepts the live payload for a canonical CID", async () => {
        const props = await getCompoundPropertiesByCID(ASPIRIN_CID);

        expect(props).not.toBe(null);
        expect(props!.cid).toBe(ASPIRIN_CID);
        expect(typeof props!.molecularWeight).toBe("number");
        expect(props!.inchiKey).toMatch(/^[A-Z]{14}-[A-Z]{10}-[A-Z]$/);
        expect(props!).toHaveProperty("canonicalSmiles");
    }, 60_000);
});
