/**
 * Per-trial AEs — Phase-3 fan-out result schema.
 *
 * The DBOS workflow body drives the `.foreach` fan-out itself; this module
 * is kept for its result schema.
 */

import { z } from "zod";
import { PerTrialAEsItemSchema } from "../steps/fanout/index.js";
import { withCoverage } from "../coverage.js";

export const PerTrialAEsResultsSchema = z.object({
    results: z.array(withCoverage(PerTrialAEsItemSchema)),
});
export type PerTrialAEsResults = z.infer<typeof PerTrialAEsResultsSchema>;
