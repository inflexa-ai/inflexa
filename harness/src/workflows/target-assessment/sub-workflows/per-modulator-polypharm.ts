/**
 * Per-modulator polypharmacology — Phase-3 fan-out result schema.
 *
 * The DBOS workflow body drives the `.foreach` fan-out itself; this module
 * is kept for its result schema.
 */

import { z } from "zod";
import { PerModulatorPolypharmItemSchema } from "../steps/fanout/index.js";
import { withCoverage } from "../coverage.js";

export const PerModulatorPolypharmResultsSchema = z.object({
    results: z.array(withCoverage(PerModulatorPolypharmItemSchema)),
});
export type PerModulatorPolypharmResults = z.infer<typeof PerModulatorPolypharmResultsSchema>;
