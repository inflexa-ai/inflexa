/**
 * Phase-3 fan-out item schemas. Each schema describes one work item (one
 * modulator, one trial, one class drug) and its coverage-tagged payload.
 * The harness DBOS implementation lives in
 * `../../fanout/index.ts` — these schemas are the shared type contract.
 */

export { ModulatorItemSchema, PerModulatorFaersItemSchema } from "./faers-for-one-modulator-step.js";
export type { ModulatorItem, PerModulatorFaersItem } from "./faers-for-one-modulator-step.js";

export { TrialItemSchema, PerTrialAEsItemSchema } from "./aes-for-one-trial-step.js";
export type { TrialItem, PerTrialAEsItem } from "./aes-for-one-trial-step.js";

export { PolypharmInputItemSchema, PerModulatorPolypharmItemSchema } from "./polypharm-for-one-modulator-step.js";
export type { PolypharmInputItem, PerModulatorPolypharmItem } from "./polypharm-for-one-modulator-step.js";

export { ClassDrugItemSchema, PerClassDrugAEsItemSchema } from "./aes-for-one-class-drug-step.js";
export type { ClassDrugItem, PerClassDrugAEsItem } from "./aes-for-one-class-drug-step.js";
