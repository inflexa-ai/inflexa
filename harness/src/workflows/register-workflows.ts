/**
 * Single registration call site for the analysis-side DBOS workflows.
 *
 * This module is the **one place** that calls `registerExecuteAnalysis` and
 * `registerSandboxStep`, binding the parent + child workflow bodies to the
 * running DBOS engine. Keeping both registrations in one file holds a single
 * invariant: both workflows land under the same `applicationVersion` stamp
 * that `launchDbos` writes onto the engine (`harness/runtime/dbos.ts`).
 * Blue/green drains gate on `dbos.application_versions`, so registering the
 * parent and child together under one stamp guarantees a drain treats them
 * as one cohort.
 *
 * Deps are supplied by the composition root: `registerAnalysisWorkflows`
 * takes a fully-formed deps bundle and passes each half straight through to
 * the per-workflow register functions. This module constructs nothing —
 * it only wires.
 */

import { registerExecuteAnalysis, type ExecuteAnalysisDeps, type ExecuteAnalysisInput, type ExecuteAnalysisResult } from "./execute-analysis.js";
import { registerSandboxStep, type SandboxStepDeps, type SandboxStepInput, type SandboxStepResult } from "./sandbox-step.js";

export interface AnalysisWorkflowDeps {
    readonly executeAnalysis: ExecuteAnalysisDeps;
    readonly sandboxStep: SandboxStepDeps;
}

export interface RegisteredAnalysisWorkflows {
    readonly executeAnalysis: (input: ExecuteAnalysisInput) => Promise<ExecuteAnalysisResult>;
    readonly sandboxStep: (input: SandboxStepInput) => Promise<SandboxStepResult>;
}

/**
 * Register the parent + child workflows with the running DBOS engine.
 *
 * Call this BEFORE `launchDbos`: `DBOS.launch()` runs recovery synchronously and
 * resolves in-flight workflows by their registered name, so a workflow that is
 * not registered at launch cannot be reclaimed. `runtime/assemble.ts` — the
 * declared source of truth for wiring order — registers every workflow before
 * launch for exactly this reason, and the embedded runtime does the same.
 * Idempotency is owned by the SDK — calling twice with the same name is a
 * `DBOS.registerWorkflow` invariant violation, not something this module
 * guards against.
 */
export function registerAnalysisWorkflows(deps: AnalysisWorkflowDeps): RegisteredAnalysisWorkflows {
    return {
        executeAnalysis: registerExecuteAnalysis(deps.executeAnalysis),
        sandboxStep: registerSandboxStep(deps.sandboxStep),
    };
}
