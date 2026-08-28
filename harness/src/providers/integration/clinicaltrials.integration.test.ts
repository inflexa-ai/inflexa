/**
 * Live ClinicalTrials.gov contract check.
 *
 * The v2 search takes `countTotal=true`, thus `totalFound` is the count of the
 * whole query. One real request proves that the live payload still passes the
 * shipped zod schema.
 *
 * Gated on `CORTEX_LIVE_API_TESTS`. Without the gate the block runs on each
 * clean checkout, and the suite then depends on the network.
 */

import { describe, expect, test } from "bun:test";

import { searchTrials } from "../../tools/lib/clinical-trials-client.js";

const LIVE = process.env.CORTEX_LIVE_API_TESTS;

describe.skipIf(!LIVE)("live ClinicalTrials.gov", () => {
    test("the study schema accepts the live payload for imatinib", async () => {
        const result = await searchTrials("imatinib", { limit: 5 });

        expect(result.trials.length).toBeGreaterThan(0);
        expect(result.totalFound).toBeGreaterThanOrEqual(result.trials.length);

        const trial = result.trials[0]!;
        expect(trial.nctId).toMatch(/^NCT\d{8}$/);
        expect(trial.title.length).toBeGreaterThan(0);
        expect(trial.status.length).toBeGreaterThan(0);
        expect(Array.isArray(trial.conditions)).toBe(true);
        expect(Array.isArray(trial.interventionDetails)).toBe(true);
    }, 60_000);
});
