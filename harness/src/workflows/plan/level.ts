/**
 * Per-step topological level for UI layout.
 *
 * Re-export of `computeTopologicalLevels` from the scheduler module under the
 * name `computeStepLevels` — the react-client `DagStepState.level` contract.
 * Level 0 = no deps; level N = max(level(deps)) + 1. Layout-only — does NOT
 * gate execution. Two steps at the same level may run / complete in any order.
 *
 * Pre-condition: `validatePlanDag` has been called. Behaviour is undefined on
 * an invalid DAG; the cycle / missing-dep cases are surfaced by validation.
 */

export { computeTopologicalLevels as computeStepLevels, type PlanStep } from "../execute-analysis-scheduler.js";
