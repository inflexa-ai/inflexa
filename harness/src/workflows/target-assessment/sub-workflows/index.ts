/**
 * Phase-3 fan-out result schemas.
 *
 * The DBOS workflow body owns the fan-out itself (`.foreach` is replaced by
 * inline `Promise.all` over `DBOS.runStep`); this module re-exports each
 * sub-workflow's result schema.
 */

export { PerModulatorFaersResultsSchema } from "./per-modulator-faers.js";
export type { PerModulatorFaersResults } from "./per-modulator-faers.js";

export { PerTrialAEsResultsSchema } from "./per-trial-aes.js";
export type { PerTrialAEsResults } from "./per-trial-aes.js";

export { PerModulatorPolypharmResultsSchema } from "./per-modulator-polypharm.js";
export type { PerModulatorPolypharmResults } from "./per-modulator-polypharm.js";

export { PerClassDrugAEsResultsSchema } from "./per-class-drug-aes.js";
export type { PerClassDrugAEsResults } from "./per-class-drug-aes.js";
