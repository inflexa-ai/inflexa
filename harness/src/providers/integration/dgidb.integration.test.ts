/**
 * Live DGIdb contract check.
 *
 * DGIdb answers one GraphQL POST, and the client validates the envelope with
 * zod. One real request proves that the live payload still passes that schema.
 *
 * Gated on `CORTEX_LIVE_API_TESTS`. Without the gate the block runs on each
 * clean checkout, and the suite then depends on the network.
 */

import { describe, expect, test } from "bun:test";

import { searchDgidb } from "../../tools/lib/dgidb-client.js";

const LIVE = process.env.CORTEX_LIVE_API_TESTS;

describe.skipIf(!LIVE)("live DGIdb", () => {
    test("the interaction schema accepts the live payload for EGFR", async () => {
        const results = await searchDgidb(["EGFR"], "gene", { limit: 5 });

        expect(results.length).toBe(1);
        const result = results[0]!;
        expect(result.input).toBe("EGFR");
        expect(result.found).toBe(true);
        expect(result.interactions.length).toBeGreaterThan(0);

        const interaction = result.interactions[0]!;
        expect(interaction.geneName).toBe("EGFR");
        expect(typeof interaction.drugName).toBe("string");
        expect(interaction.sourceCount).toBeGreaterThan(0);
        expect(Array.isArray(interaction.sources)).toBe(true);
        expect(Array.isArray(interaction.interactionTypes)).toBe(true);
    }, 60_000);
});
