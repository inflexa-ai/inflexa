import { describe, expect, it } from "bun:test";

import type { DataProfileResult } from "../state/data-profile.js";
import { buildDataProfileOrientation, DATA_PROFILE_ORIENTATION_MAX_CHARS } from "./data-profile-orientation.js";

const RICH: DataProfileResult = {
    summary: "Bulk RNA-seq of rectal mucosal biopsies, 24 samples, UC vs healthy controls.",
    files: [
        {
            path: "data/inputs/f1/counts.csv",
            description: "Raw gene-level count matrix",
            dataType: "count-matrix",
            format: "CSV",
            rows: 20531,
            cols: 24,
        },
        { path: "data/inputs/f2/metadata.csv", description: "Sample metadata", dataType: "clinical-metadata", format: "CSV", rows: 24, cols: 6 },
    ],
    inputFileIds: ["file-aaa", "file-bbb"],
    profiledAt: "2026-06-09T10:00:00.000Z",
    domain: "transcriptomics",
    subtype: "bulk-rna-seq",
    organism: { scientificName: "Homo sapiens", taxonId: "9606", source: "metadata", confidence: "high" },
    tissue: "rectal mucosal biopsy",
    cellType: "bulk tissue",
    condition: "Ulcerative Colitis vs healthy controls",
    experimentalDesign: "Two groups (12 UC, 12 control), paired by sequencing batch.",
    qualityAssessment: {
        concerns: ["batch confounded with group in batch 2", "3 low-depth samples"],
        strengths: ["balanced group sizes"],
    },
};

/** A snapshot written before the record was widened: four fields, bare file pairs. */
const LEGACY: DataProfileResult = {
    summary: "Three RNA-seq count matrices and a sample sheet.",
    files: [
        { path: "data/inputs/f1/counts.csv", description: "Raw count matrix" },
        { path: "data/inputs/f2/metadata.csv", description: "Sample metadata" },
    ],
    inputFileIds: ["file-aaa", "file-bbb"],
    profiledAt: "2026-01-02T03:04:05.000Z",
};

describe("buildDataProfileOrientation", () => {
    it("projects the dataset identity, design, concerns, and file dimensions", () => {
        const text = buildDataProfileOrientation(RICH);

        expect(text).toContain("transcriptomics / bulk-rna-seq");
        expect(text).toContain("Homo sapiens (taxon 9606)");
        expect(text).toContain("tissue: rectal mucosal biopsy");
        expect(text).toContain("cells: bulk tissue");
        expect(text).toContain("condition: Ulcerative Colitis vs healthy controls");
        expect(text).toContain("Two groups (12 UC, 12 control)");
        expect(text).toContain("batch confounded with group in batch 2");
        // Dimensions ride with each file, which is the only place they appear.
        expect(text).toContain("data/inputs/f1/counts.csv — Raw gene-level count matrix (20531 x 24, CSV)");
        expect(text).toContain("Files (2):");
    });

    it("marks a low-confidence organism rather than stating it flatly", () => {
        const guessed: DataProfileResult = {
            ...RICH,
            organism: { scientificName: "Mus musculus", taxonId: "10090", source: "inferred", confidence: "low", notes: "from gene ID patterns" },
        };
        expect(buildDataProfileOrientation(guessed)).toContain("Mus musculus (taxon 10090) [low confidence]");
    });

    it("omits fields the profiler left null or unset instead of printing empties", () => {
        const sparse: DataProfileResult = {
            summary: "Unlabelled counts.",
            files: [{ path: "data/inputs/f1/counts.csv", description: "Counts", format: "CSV" }],
            inputFileIds: ["file-aaa"],
            profiledAt: "2026-06-09T10:00:00.000Z",
            domain: "transcriptomics",
            organism: null,
            tissue: null,
            condition: null,
        };
        const text = buildDataProfileOrientation(sparse);

        expect(text).toContain("Dataset: transcriptomics");
        expect(text).not.toContain("tissue:");
        expect(text).not.toContain("condition:");
        expect(text).not.toContain("null");
        // No dimensions recorded — the format still shows, with no phantom "x".
        expect(text).toContain("data/inputs/f1/counts.csv — Counts (CSV)");
    });

    it("falls back to the summary for a legacy snapshot that has no structured fields", () => {
        const text = buildDataProfileOrientation(LEGACY);

        expect(text).toContain("Three RNA-seq count matrices and a sample sheet.");
        expect(text).toContain("data/inputs/f1/counts.csv — Raw count matrix");
        expect(text.length).toBeLessThanOrEqual(DATA_PROFILE_ORIENTATION_MAX_CHARS);
    });

    it("caps the file list at 8 and states the true total, so the elision is visible", () => {
        const many: DataProfileResult = {
            ...RICH,
            files: Array.from({ length: 30 }, (_, i) => ({
                path: `data/inputs/f${i}/counts.csv`,
                description: `Matrix ${i}`,
                format: "CSV",
                rows: 100,
                cols: 4,
            })),
        };
        const text = buildDataProfileOrientation(many);

        expect(text).toContain("Files (8 of 30):");
        expect(text).toContain("data/inputs/f7/counts.csv");
        expect(text).not.toContain("data/inputs/f8/counts.csv");
    });

    it("caps concerns at 3 and counts the remainder", () => {
        const many: DataProfileResult = {
            ...RICH,
            qualityAssessment: { concerns: ["c1", "c2", "c3", "c4", "c5"], strengths: [] },
        };
        expect(buildDataProfileOrientation(many)).toContain("Concerns: c1; c2; c3 (+2 more)");
    });

    // The bound is the whole point: this text is destined for a context window it does
    // not own, so a pathological profile must not be able to blow the caller's budget.
    it("never exceeds the character bound, however verbose the profile", () => {
        const monstrous: DataProfileResult = {
            summary: "S".repeat(10_000),
            files: Array.from({ length: 200 }, (_, i) => ({
                path: `data/inputs/${"deep/".repeat(20)}f${i}.csv`,
                description: "D".repeat(2_000),
                dataType: "count-matrix",
                format: "F".repeat(200),
                rows: 1,
                cols: 1,
                warnings: Array.from({ length: 50 }, () => "W".repeat(500)),
            })),
            inputFileIds: [],
            profiledAt: "2026-06-09T10:00:00.000Z",
            domain: "D".repeat(3_000),
            subtype: "S".repeat(3_000),
            organism: { scientificName: "O".repeat(3_000), taxonId: "9".repeat(500), source: "inferred", confidence: "low" },
            tissue: "T".repeat(3_000),
            cellType: "C".repeat(3_000),
            condition: "X".repeat(3_000),
            experimentalDesign: "E".repeat(10_000),
            qualityAssessment: { concerns: Array.from({ length: 100 }, () => "Q".repeat(1_000)), strengths: [] },
        };

        expect(buildDataProfileOrientation(monstrous).length).toBeLessThanOrEqual(DATA_PROFILE_ORIENTATION_MAX_CHARS);
    });

    it("honours a caller-supplied bound", () => {
        expect(buildDataProfileOrientation(RICH, 80).length).toBeLessThanOrEqual(80);
        expect(buildDataProfileOrientation(RICH, 0)).toBe("");
    });

    it("stays well under the bound for an ordinary profile", () => {
        expect(buildDataProfileOrientation(RICH).length).toBeLessThanOrEqual(DATA_PROFILE_ORIENTATION_MAX_CHARS);
        // A real profile should not be flirting with the cap — if it is, the projection
        // has stopped being an orientation and become a dump.
        expect(buildDataProfileOrientation(RICH).length).toBeLessThan(800);
    });
});
