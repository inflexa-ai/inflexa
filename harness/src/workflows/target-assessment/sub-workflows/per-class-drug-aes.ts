/**
 * Per-class-drug AEs — Phase-3 fan-out result schema.
 *
 * The DBOS workflow body drives the `.foreach` fan-out itself; this module
 * is kept for its result schema.
 */

import { z } from "zod";
import { PerClassDrugAEsItemSchema } from "../steps/fanout/index.js";
import { withCoverage } from "../coverage.js";

export const PerClassDrugAEsResultsSchema = z.object({
    results: z.array(withCoverage(PerClassDrugAEsItemSchema)),
});
export type PerClassDrugAEsResults = z.infer<typeof PerClassDrugAEsResultsSchema>;
