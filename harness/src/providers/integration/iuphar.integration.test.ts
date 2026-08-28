/**
 * Live IUPHAR Guide to Pharmacology contract check.
 *
 * The target array is validated with zod, and `familyIds` stays required. One
 * real request proves that the live payload still passes that schema.
 *
 * Gated on `CORTEX_LIVE_API_TESTS`. Without the gate the block runs on each
 * clean checkout, and the suite then depends on the network.
 */

import { describe, expect, test } from "bun:test";

import { findTargetByGeneSymbol } from "../../tools/lib/iuphar-client.js";

const LIVE = process.env.CORTEX_LIVE_API_TESTS;

describe.skipIf(!LIVE)("live IUPHAR", () => {
    test("the target schema accepts the live payload for EGFR", async () => {
        const target = await findTargetByGeneSymbol("EGFR");

        expect(target).not.toBe(null);
        expect(typeof target!.targetId).toBe("number");
        expect(target!.name.length).toBeGreaterThan(0);
        expect(Array.isArray(target!.familyIds)).toBe(true);
    }, 60_000);
});
