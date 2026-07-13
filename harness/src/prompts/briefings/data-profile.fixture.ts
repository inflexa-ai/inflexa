/**
 * Colocated input fixture for the data-profile briefing snapshot test — a
 * representative completed `DataProfileResult`. Deterministic (fixed
 * `profiledAt`), so the briefing renders identically on every run.
 */

import type { DataProfileResult } from "../../state/data-profile.js";

export const dataProfileFixture: DataProfileResult = {
    summary:
        "Bulk RNA-seq dataset: a raw count matrix (12 samples × 18,412 genes) with a " +
        "matching sample sheet and a small variant call set. Two experimental groups " +
        "(treated vs. control), 6 replicates each.",
    files: [
        { path: "data/inputs/f1/counts.csv", description: "Raw gene-level count matrix (genes × samples)." },
        { path: "data/inputs/f2/samples.tsv", description: "Sample sheet: condition, replicate, batch." },
        { path: "data/inputs/f3/variants.vcf", description: "Germline variant calls for the cohort." },
    ],
    inputFileIds: ["file-counts", "file-samples", "file-variants"],
    inputFiles: [
        { fileId: "file-counts", size: 4_194_304, mtimeMs: 1_780_000_000_000 },
        { fileId: "file-samples", size: 2_048, mtimeMs: 1_780_000_001_000 },
        { fileId: "file-variants", size: 1_048_576, mtimeMs: 1_780_000_002_000 },
    ],
    profiledAt: "2026-06-09T10:00:00.000Z",
};
