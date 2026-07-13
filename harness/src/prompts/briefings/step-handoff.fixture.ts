/**
 * Colocated input fixtures for the step-handoff briefing snapshot tests — one
 * upstream step's `StepHandoffInput`, as the child workflow body would build it
 * after loading the persisted summary and walking the step's artifact tree.
 *
 * Deterministic (fixed ids, summary text, and sandbox-canonical paths), so the
 * briefing renders identically on every run. All artifact paths are
 * sandbox-canonical (`/{analysisId}/…`) and `output/summary.md` is excluded —
 * the summary is the briefing body, not a listed artifact.
 */

import type { StepHandoffInput } from "./step-handoff.js";

/**
 * The upstream `normalize` step (`s2`) with a realistic interpretation summary
 * and 4 artifacts. Matches the spec's caption example
 * (`step s2 "normalize" · 4 artifacts`).
 */
export const stepHandoffFixture: StepHandoffInput = {
    stepId: "s2",
    name: "normalize",
    summaryMarkdown: [
        "## Normalization",
        "",
        "Applied median-of-ratios size-factor normalization to the raw count matrix",
        "(24,183 genes × 18 samples). Removed 1,204 genes below the minimum-count",
        "threshold, leaving 22,979 for downstream testing. Sample `S14` was flagged as",
        "a library-size outlier (2.3× median depth) but retained.",
        "",
        "**Key outputs:** the normalized AnnData (`normalized.h5ad`) and a per-sample QC",
        "table are the inputs the differential-expression step should consume.",
    ].join("\n"),
    artifactPaths: [
        "/analysis_ad01/runs/run_7c2e/s2/output/normalized.h5ad",
        "/analysis_ad01/runs/run_7c2e/s2/output/qc_metrics.csv",
        "/analysis_ad01/runs/run_7c2e/s2/figures/library_size.png",
        "/analysis_ad01/runs/run_7c2e/s2/scripts/normalize.py",
    ],
};

/** A single-artifact upstream step — exercises caption pluralization (`1 artifact`). */
export const stepHandoffSingleArtifactFixture: StepHandoffInput = {
    stepId: "s1",
    name: "qc",
    summaryMarkdown: "## QC\n\nAll 18 samples passed quality control; no samples excluded.",
    artifactPaths: ["/analysis_ad01/runs/run_7c2e/s1/output/qc-verdict.md"],
};
