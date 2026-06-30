/**
 * Synthesis diagnostics row builder.
 *
 * Each Phase-5 synthesis step accumulates a single
 * `SynthesisDiagnosticRow` describing its attempt history (model id,
 * attempts, retry critique, output length, probe verdict, final
 * coverage). Phase-5 persist collects the four rows and stamps them
 * into `dossier.analytics.synthesis_diagnostics`.
 *
 * Diagnostics persist even when synthesis fails — that is the point.
 * A reader who sees `executive_recommendation.coverage = queried_no_data`
 * with `error.kind = synthesis-too-shallow` can open the diagnostics
 * row to see exactly which probe rejected the output and why.
 */

import type { SynthesisDiagnosticRow } from "@inflexa-ai/harness/contracts/target-dossier.js";
import type { ProbeResult } from "../../synthesis-probes.js";

export type StepId = SynthesisDiagnosticRow["step_id"];

export interface BuildDiagnosticsRowInput {
    stepId: StepId;
    modelId: string;
    attemptCount: 1 | 2;
    retryCritique: string | null;
    finalProbe: ProbeResult;
    finalCoverage: "available" | "queried_no_data";
    errorKind?: "synthesis-too-shallow" | "synthesis-unavailable" | "voice-violation" | null;
    errorMessage?: string | null;
}

export function buildDiagnosticsRow(input: BuildDiagnosticsRowInput): SynthesisDiagnosticRow {
    return {
        step_id: input.stepId,
        model_id: input.modelId,
        attempt_count: input.attemptCount,
        retry_critique: input.retryCritique,
        output_chars: input.finalProbe.output_chars,
        probe_verdict: input.finalProbe.verdict,
        final_coverage: input.finalCoverage,
        error_kind: input.errorKind ?? null,
        error_message: input.errorMessage ?? null,
    };
}

/**
 * Build a "skipped" diagnostics row for the case where the step never
 * even attempted an LLM call (e.g., upstream coverage was not_loaded
 * and the step short-circuited).
 */
export function buildSkippedDiagnosticsRow(stepId: StepId, modelId: string, reason: string): SynthesisDiagnosticRow {
    return {
        step_id: stepId,
        model_id: modelId,
        attempt_count: 1,
        retry_critique: null,
        output_chars: 0,
        probe_verdict: "skipped",
        final_coverage: "queried_no_data",
        error_kind: null,
        error_message: reason,
    };
}
