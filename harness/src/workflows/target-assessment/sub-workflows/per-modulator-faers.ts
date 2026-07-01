/**
 * Per-modulator FAERS — Phase-3 fan-out result schema.
 *
 * The DBOS workflow body drives the `.foreach` fan-out itself; this module
 * is kept for its result schema.
 */

import { z } from "zod";
import { PerModulatorFaersItemSchema } from "../steps/fanout/index.js";
import { withCoverage } from "../coverage.js";

export const PerModulatorFaersResultsSchema = z.object({
    results: z.array(withCoverage(PerModulatorFaersItemSchema)),
});
export type PerModulatorFaersResults = z.infer<typeof PerModulatorFaersResultsSchema>;
