import { describe, expect, it } from "bun:test";

import type { DataProfileResult } from "../state/data-profile.js";
import { buildDataProfileOrientation, DATA_PROFILE_ORIENTATION_MAX_CHARS } from "./data-profile-orientation.js";

/** The analysis every rendered path is rooted with. */
const ANALYSIS_ID = "an-1";

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
    },
};

/** A snapshot written before the record was widened: four fields, bare file pairs. */
const LEGACY: DataProfileResult = {
    summary: "Three RNA-seq count matrices and a sample sheet.",
    files: [
        { path: "data/inputs/f1/counts.csv", description: "Raw count matrix" },
        { path: "data/inputs/f2/metadata.csv", description: "Sample metadata" },
    ],
    profiledAt: "2026-01-02T03:04:05.000Z",
};

describe("buildDataProfileOrientation", () => {
    it("projects the dataset identity, design, concerns, and file dimensions", () => {
        const text = buildDataProfileOrientation(RICH, ANALYSIS_ID);

        expect(text).toContain("transcriptomics / bulk-rna-seq");
        expect(text).toContain("Homo sapiens (taxon 9606)");
        expect(text).toContain("tissue: rectal mucosal biopsy");
        expect(text).toContain("cells: bulk tissue");
        expect(text).toContain("condition: Ulcerative Colitis vs healthy controls");
        expect(text).toContain("Two groups (12 UC, 12 control)");
        expect(text).toContain("batch confounded with group in batch 2");
        // Dimensions ride with each file, which is the only place they appear.
        expect(text).toContain("/an-1/data/inputs/f1/counts.csv — Raw gene-level count matrix (20531 x 24, CSV)");
        expect(text).toContain("Files (2):");
    });

    it("marks a low-confidence organism rather than stating it flatly", () => {
        const guessed: DataProfileResult = {
            ...RICH,
            organism: { scientificName: "Mus musculus", taxonId: "10090", source: "inferred", confidence: "low", notes: "from gene ID patterns" },
        };
        expect(buildDataProfileOrientation(guessed, ANALYSIS_ID)).toContain("Mus musculus (taxon 10090) [low confidence]");
    });

    it("omits fields the profiler left null or unset instead of printing empties", () => {
        const sparse: DataProfileResult = {
            summary: "Unlabelled counts.",
            files: [{ path: "data/inputs/f1/counts.csv", description: "Counts", format: "CSV" }],
            profiledAt: "2026-06-09T10:00:00.000Z",
            domain: "transcriptomics",
            organism: null,
            tissue: null,
            condition: null,
        };
        const text = buildDataProfileOrientation(sparse, ANALYSIS_ID);

        expect(text).toContain("Dataset: transcriptomics");
        expect(text).not.toContain("tissue:");
        expect(text).not.toContain("condition:");
        expect(text).not.toContain("null");
        // No dimensions recorded — the format still shows, with no phantom "x".
        expect(text).toContain("data/inputs/f1/counts.csv — Counts (CSV)");
    });

    it("falls back to the summary for a legacy snapshot that has no structured fields", () => {
        const text = buildDataProfileOrientation(LEGACY, ANALYSIS_ID);

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
        const text = buildDataProfileOrientation(many, ANALYSIS_ID);

        expect(text).toContain("Files (8 of 30):");
        expect(text).toContain("data/inputs/f7/counts.csv");
        expect(text).not.toContain("data/inputs/f8/counts.csv");
    });

    it("caps caveats at 3 and counts the remainder", () => {
        const many: DataProfileResult = {
            ...RICH,
            qualityAssessment: { concerns: ["c1", "c2", "c3", "c4", "c5"] },
        };
        expect(buildDataProfileOrientation(many, ANALYSIS_ID)).toContain("Caveats: c1; c2; c3 (+2 more)");
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
            profiledAt: "2026-06-09T10:00:00.000Z",
            domain: "D".repeat(3_000),
            subtype: "S".repeat(3_000),
            organism: { scientificName: "O".repeat(3_000), taxonId: "9".repeat(500), source: "inferred", confidence: "low" },
            tissue: "T".repeat(3_000),
            cellType: "C".repeat(3_000),
            condition: "X".repeat(3_000),
            experimentalDesign: "E".repeat(10_000),
            qualityAssessment: { concerns: Array.from({ length: 100 }, () => "Q".repeat(1_000)) },
        };

        expect(buildDataProfileOrientation(monstrous, ANALYSIS_ID).length).toBeLessThanOrEqual(DATA_PROFILE_ORIENTATION_MAX_CHARS);
    });

    it("honours a caller-supplied bound", () => {
        expect(buildDataProfileOrientation(RICH, ANALYSIS_ID, 80).length).toBeLessThanOrEqual(80);
        expect(buildDataProfileOrientation(RICH, ANALYSIS_ID, 0)).toBe("");
    });

    it("stays well under the bound for an ordinary profile", () => {
        expect(buildDataProfileOrientation(RICH, ANALYSIS_ID).length).toBeLessThanOrEqual(DATA_PROFILE_ORIENTATION_MAX_CHARS);
        // A real profile should not be flirting with the cap — if it is, the projection
        // has stopped being an orientation and become a dump.
        expect(buildDataProfileOrientation(RICH, ANALYSIS_ID).length).toBeLessThan(800);
    });
});

describe("a snapshot of the kinds era", () => {
    const STRUCTURED: DataProfileResult = {
        ...RICH,
        files: [{ path: "data/inputs/meta/samplesheet.csv", description: "Clinical annotations for all 120 subjects", format: "CSV" }],
        kinds: [
            {
                name: "per-patient variant calls",
                memberRepresents: "one patient's somatic variant calls",
                description: "HaplotypeCaller VCFs.",
                count: 120,
                pathPattern: "data/inputs/vcf/*.vcf.gz",
                format: "VCF",
                axisLabels: ["patient"],
            },
            {
                name: "variant indexes",
                memberRepresents: "the tabix index of one patient's calls",
                description: "Tabix indexes.",
                count: 200,
                pathPattern: "data/inputs/tbi/*.tbi",
                format: "TBI",
                axisLabels: ["patient"],
            },
        ],
        axes: [{ label: "patient", cardinality: 120 }],
        coverage: { matched: 319, unmatched: 1, total: 320 },
        inputSignature: { count: 320, digest: "abc" },
    };

    it("renders its kinds as groups, before the notable files", () => {
        const text = buildDataProfileOrientation(STRUCTURED, ANALYSIS_ID);
        expect(text).toContain("Groups (2):");
        expect(text).toContain("per-patient variant calls (120x, VCF) — one patient's somatic variant calls");
        expect(text).toContain("Dimensions (1):");
        expect(text).toContain("- patient: 120");
        expect(text.indexOf("Groups (")).toBeLessThan(text.indexOf("Notable files"));
    });

    it("censuses what its era recorded, naming the coverage shortfall rather than a quarantine it never had", () => {
        const text = buildDataProfileOrientation(STRUCTURED, ANALYSIS_ID);
        expect(text).toContain("Census: 320 files in 2 groups · 1 matching no kind");
        expect(text).not.toContain("quarantined");
    });

    it("stays within the character budget on a structured profile", () => {
        expect(buildDataProfileOrientation(STRUCTURED, ANALYSIS_ID).length).toBeLessThanOrEqual(DATA_PROFILE_ORIENTATION_MAX_CHARS);
    });

    it("falls back to the file list for a snapshot written before any structure existed", () => {
        const text = buildDataProfileOrientation(RICH, ANALYSIS_ID);
        expect(text).not.toContain("Groups (");
        expect(text).toContain("Files (2):");
    });
});

describe("a snapshot resolved into groups", () => {
    const RESOLVED: DataProfileResult = {
        ...RICH,
        files: undefined,
        caveats: ["batch is confounded with arm"],
        groups: [
            {
                id: "per-subject-calls",
                name: "per-subject calls",
                memberRepresents: "one subject's small-variant calls",
                description: "Small-variant calls, one file per subject.",
                role: "data",
                category: "variant-calls",
                count: 40,
                fileCount: 80,
                totalBytes: 4096,
                displayPattern: "data/inputs/vcf/<id>.vcf.gz",
                formats: [{ format: "VCF", count: 40 }],
                memberAnnotations: [{ path: "data/inputs/vcf/S001.vcf.gz", note: "Only member with a contig header." }],
            },
            {
                id: "unclassified",
                name: "unclassified",
                memberRepresents: "one file no operation claimed",
                description: "Swept residue.",
                role: "data",
                category: "other",
                categoryLabel: "unclassified",
                count: 2,
                fileCount: 2,
                totalBytes: 20,
                displayPattern: "data/inputs",
                formats: [{ format: "txt", count: 2 }],
                unclassified: true,
            },
        ],
        dimensions: [
            {
                label: "subject",
                category: "subject",
                scope: "biological",
                observations: [
                    {
                        kind: "slot",
                        groupIds: ["per-subject-calls"],
                        slotId: "set-1.slot-1",
                        tokenClass: "digits-fixed",
                        cardinality: 40,
                        sampleValues: ["001"],
                    },
                ],
            },
        ],
        partition: {
            scannedFiles: 83,
            keptFiles: 82,
            keptMembers: 42,
            groups: 2,
            unclassifiedMembers: 2,
            unclassifiedFiles: 2,
            quarantine: { count: 1, totalBytes: 5, reasons: [{ reason: "os-junk", count: 1 }], sample: ["data/inputs/.DS_Store"] },
        },
    };

    it("renders the census, the resolved groups, and the dimensions", () => {
        const text = buildDataProfileOrientation(RESOLVED, ANALYSIS_ID);
        expect(text).toContain("Census: 82 files in 2 groups · 2 unclassified · 1 quarantined");
        expect(text).toContain("Groups (2):");
        expect(text).toContain("- per-subject calls (40x, VCF, variant-calls) — one subject's small-variant calls");
        expect(text).toContain("- unclassified (2x, txt, unclassified) — one file no operation claimed");
        expect(text).toContain("Dimensions (1):");
        expect(text).toContain("- subject: 40 · e.g. 001");
    });

    it("puts the census in the header, above every structured section", () => {
        const lines = buildDataProfileOrientation(RESOLVED, ANALYSIS_ID).split("\n");
        expect(lines[0]).toStartWith("Dataset: ");
        expect(lines[1]).toStartWith("Census: ");
    });

    it("orders identity, census, groups, dimensions, notable files, design, then caveats", () => {
        const text = buildDataProfileOrientation(RESOLVED, ANALYSIS_ID);
        const order = ["Dataset: ", "Census: ", "Groups (", "Dimensions (", "Notable files (", "Design: ", "Caveats: "].map((marker) => text.indexOf(marker));
        expect(order.every((index) => index >= 0)).toBe(true);
        expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it("serves an annotated member as a notable file, and the agent's caveats under their own name", () => {
        const text = buildDataProfileOrientation(RESOLVED, ANALYSIS_ID);
        expect(text).toContain("Notable files (1):");
        expect(text).toContain("Only member with a contig header.");
        expect(text).toContain("Caveats: batch is confounded with arm");
    });

    it("stays within the character budget", () => {
        expect(buildDataProfileOrientation(RESOLVED, ANALYSIS_ID).length).toBeLessThanOrEqual(DATA_PROFILE_ORIENTATION_MAX_CHARS);
    });

    it("keeps the census whatever the clamp removes", () => {
        for (const budget of [200, 300, 500, 900]) {
            const text = buildDataProfileOrientation(RESOLVED, ANALYSIS_ID, budget);
            expect(text.length).toBeLessThanOrEqual(budget);
            expect(text).toContain("Census: 82 files in 2 groups");
        }
    });

    it("renders the structure in full before prose expands, whatever the profile's caveats cost", () => {
        const verbose: DataProfileResult = {
            ...RESOLVED,
            caveats: Array.from({ length: 20 }, (_, i) => `${i}: ${"P".repeat(400)}`),
            experimentalDesign: "D".repeat(2_000),
        };
        const text = buildDataProfileOrientation(verbose, ANALYSIS_ID);

        expect(text).toContain("Census: 82 files in 2 groups");
        expect(text).toContain("- per-subject calls (40x, VCF, variant-calls)");
        expect(text).toContain("- unclassified (2x, txt, unclassified)");
        expect(text).toContain("- subject: 40 · e.g. 001");
        // Two caps hold the prose down: per item, and as a share of the whole rendering.
        const caveats = text.split("\n").find((line) => line.startsWith("Caveats: "))!;
        expect(caveats).toContain("(+17 more)");
        expect(caveats.length).toBeLessThanOrEqual(Math.floor(DATA_PROFILE_ORIENTATION_MAX_CHARS * 0.25));
        expect(text.split("\n").find((line) => line.startsWith("Design: "))!.length).toBe(208);
    });
});

/** One slotted group, so a profile of any group count is a repetition of the same shape. */
function measurementGroup(index: number, annotations = 0) {
    return {
        id: `measurement-group-${index}`,
        name: `measurement group ${index}`,
        memberRepresents: `one subject's paired measurement files for batch ${index}, including the companion index and the checksum sidecar`,
        description: `Batch ${index} measurements.`,
        role: "data",
        category: "other",
        categoryLabel: "measurements",
        count: 10,
        fileCount: 20,
        totalBytes: 1024,
        displayPattern: `data/inputs/b${index}/<arm>/<id>.csv`,
        formats: [{ format: "CSV", count: 10 }],
        slots: [
            {
                id: `set-${index}.slot-0`,
                location: "directory" as const,
                index: 0,
                tokenClass: "token",
                distinctValues: 2,
                sampleValues: ["control", "treated"],
            },
            { id: `set-${index}.slot-1`, location: "name" as const, index: 1, tokenClass: "digits-fixed", distinctValues: 10, sampleValues: ["001", "002"] },
        ],
        memberAnnotations: Array.from({ length: annotations }, (_, i) => ({
            path: `data/inputs/b${index}/control/${i}.csv`,
            note: `Batch ${index} member ${i} carries a duplicated header row.`,
        })),
    };
}

function measurementProfile(groups: number, annotationsPerGroup = 0): DataProfileResult {
    return {
        ...RICH,
        files: undefined,
        experimentalDesign: "Eight arms, each with paired baseline and endpoint draws, randomised within site and sequenced across three batches. ".repeat(4),
        caveats: Array.from({ length: 5 }, (_, i) => `caveat ${i}: ${"c".repeat(300)}`),
        groups: Array.from({ length: groups }, (_, i) => measurementGroup(i, i < 3 ? annotationsPerGroup : 0)),
        dimensions: [
            {
                label: "subject",
                category: "subject",
                scope: "biological",
                nestsUnder: { dimension: "site", evidence: "one directory per site" },
                observations: [
                    {
                        kind: "slot",
                        groupIds: ["measurement-group-0"],
                        slotId: "set-0.slot-1",
                        tokenClass: "digits-fixed",
                        cardinality: 80,
                        sampleValues: ["001"],
                    },
                ],
            },
        ],
        partition: {
            scannedFiles: groups * 20,
            keptFiles: groups * 20,
            keptMembers: groups * 10,
            groups,
            unclassifiedMembers: 0,
            unclassifiedFiles: 0,
            quarantine: { count: 0, totalBytes: 0, reasons: [], sample: [] },
        },
    };
}

describe("a profile whose structure is the point", () => {
    it("renders all sixteen groups with their slots, and clamps only the prose", () => {
        const text = buildDataProfileOrientation(measurementProfile(16), ANALYSIS_ID);
        const lines = text.split("\n");

        expect(text.length).toBeLessThanOrEqual(DATA_PROFILE_ORIENTATION_MAX_CHARS);
        expect(text).toContain("Groups (16):");
        expect(lines.filter((line) => line.startsWith("- measurement group ")).length).toBe(16);
        expect(lines.filter((line) => line.startsWith("  slots: ")).length).toBe(16);
        expect(text).toContain(
            "- measurement group 7 (10x, CSV, measurements) — one subject's paired measurement files for batch 7, including the companion index and the…",
        );
        expect(text).toContain("  slots: dir0 token ×2 (control, treated) · name1 digits-fixed ×10");
        expect(text).toContain("- subject: 80 · nests under site · e.g. 001");
        expect(text).not.toContain("… trimmed to fit");
    });

    it("ends the design note with an ellipsis rather than a severed word", () => {
        const design = buildDataProfileOrientation(measurementProfile(16), ANALYSIS_ID)
            .split("\n")
            .find((line) => line.startsWith("Design: "))!;

        expect(design.startsWith("Design: Eight arms, each with paired baseline and endpoint draws")).toBe(true);
        expect(design.endsWith("…")).toBe(true);
        expect(design.length).toBe(208);
    });

    it("counts the groups it could not fit rather than trailing off", () => {
        const text = buildDataProfileOrientation(measurementProfile(44), ANALYSIS_ID);
        const rendered = text.split("\n").filter((line) => line.startsWith("- measurement group ")).length;

        expect(text.length).toBeLessThanOrEqual(DATA_PROFILE_ORIENTATION_MAX_CHARS);
        expect(text).toContain("Groups (44):");
        expect(rendered).toBeGreaterThan(16);
        expect(rendered).toBeLessThan(44);
        expect(text).toContain(`…and ${44 - rendered} more groups`);
        expect(text.endsWith("\n… trimmed to fit")).toBe(true);
    });

    it("serves the annotated members as notable files, capped and counted", () => {
        const text = buildDataProfileOrientation(measurementProfile(16, 10), ANALYSIS_ID);

        expect(text).toContain("Notable files (8 of 30):");
        expect(text).toContain("- /an-1/data/inputs/b0/control/0.csv — Batch 0 member 0 carries a duplicated header row.");
        expect(text.split("\n").filter((line) => line.startsWith("- /an-1/")).length).toBe(8);
    });

    it("drops the notable files before the groups when the budget is short, and says so", () => {
        const text = buildDataProfileOrientation(measurementProfile(16, 10), ANALYSIS_ID, 1200);

        expect(text.length).toBeLessThanOrEqual(1200);
        expect(text).toContain("- measurement group 0 (10x, CSV, measurements)");
        expect(text).not.toContain("Notable files");
        expect(text.endsWith("\n… trimmed to fit")).toBe(true);
    });

    it("keeps the census at every budget, and never overruns one", () => {
        for (const budget of [300, 900, 2400, DATA_PROFILE_ORIENTATION_MAX_CHARS]) {
            const text = buildDataProfileOrientation(measurementProfile(44), ANALYSIS_ID, budget);
            expect(text.length).toBeLessThanOrEqual(budget);
            expect(text).toContain("Census: 880 files in 44 groups");
        }
    });
});

describe("the frame of a rendered path", () => {
    it("roots every file path, so none reads as relative to the agent's working directory", () => {
        const text = buildDataProfileOrientation(RICH, ANALYSIS_ID);
        for (const line of text.split("\n").filter((l) => l.startsWith("- data") || l.startsWith("- /"))) {
            expect(line).toStartWith(`- /${ANALYSIS_ID}/`);
        }
    });

    it("roots a stored path that already carries the root exactly once", () => {
        const rooted: DataProfileResult = {
            ...RICH,
            files: [{ path: `/${ANALYSIS_ID}/data/inputs/f1/counts.csv`, description: "Raw count matrix" }],
        };
        const text = buildDataProfileOrientation(rooted, ANALYSIS_ID);
        expect(text).toContain(`/${ANALYSIS_ID}/data/inputs/f1/counts.csv`);
        expect(text).not.toContain(`/${ANALYSIS_ID}/${ANALYSIS_ID}`);
    });
});
