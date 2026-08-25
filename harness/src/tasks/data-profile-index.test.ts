/**
 * The index is a projection, so these assert what the projection PRODUCES: which tiers
 * exist, what each entry's id addresses, and what its text is composed from. Nothing here
 * asserts that a function was called.
 */

import { describe, expect, it } from "bun:test";

import type { DataProfileResult } from "../contracts/data-profile.js";
import { buildManifest } from "../input-scan/scan.js";
import type { ScannedFile } from "../input-scan/types.js";
import { buildProfileIndexEntries } from "./data-profile-index.js";

const SUBJECTS = 400;
const ALIGNED = 398;
const SHEETS = 3;

const pad = (n: number) => String(n).padStart(4, "0");

function file(path: string, format: string): ScannedFile {
    const base = path.slice(path.lastIndexOf("/") + 1);
    const dot = base.indexOf(".");
    return { path, size: 2048, extensions: dot <= 0 ? [] : base.slice(dot + 1).split("."), format };
}

/** A synthetic tree: many files, few sets, one wide identifier. */
function scanFixture() {
    const files: ScannedFile[] = [
        ...Array.from({ length: SUBJECTS }, (_, i) => file(`data/inputs/vcf/SUBJ_${pad(i + 1)}.vcf.gz`, "vcf")),
        ...Array.from({ length: SUBJECTS }, (_, i) => file(`data/inputs/tbi/SUBJ_${pad(i + 1)}.vcf.gz.tbi`, "tabix-index")),
        ...Array.from({ length: ALIGNED }, (_, i) => file(`data/inputs/bam/SUBJ_${pad(i + 1)}.bam`, "bam")),
        ...Array.from({ length: SHEETS }, (_, i) => file(`data/inputs/meta/sheet_${i + 1}.csv`, "csv")),
    ];
    return buildManifest("data/inputs", files, false);
}

const TOTAL_FILES = SUBJECTS * 2 + ALIGNED + SHEETS;

/** A snapshot of the groups era: resolved groups, evidenced dimensions, two annotated members. */
const RESOLVED: DataProfileResult = {
    summary: "A synthetic cohort.",
    profiledAt: "2026-08-01T00:00:00.000Z",
    groups: [
        {
            id: "per-subject-calls",
            name: "per-subject variant calls",
            memberRepresents: "one subject's small-variant calls",
            description: "Small-variant calls, one member per subject.",
            role: "data",
            category: "variant-calls",
            count: SUBJECTS,
            fileCount: SUBJECTS * 2,
            totalBytes: 4096,
            displayPattern: "data/inputs/vcf/<id>.vcf.gz",
            formats: [{ format: "vcf", count: SUBJECTS }],
            slots: [{ id: "set-1.slot-1", location: "name", index: 1, tokenClass: "digits-fixed", distinctValues: SUBJECTS, sampleValues: ["0001", "0002"] }],
            memberAnnotations: [{ path: "data/inputs/vcf/SUBJ_0001.vcf.gz", note: "The only member carrying a contig header." }],
        },
        {
            id: "sample-sheets",
            name: "sample sheets",
            memberRepresents: "one cohort's annotation table",
            description: "Specimen annotations.",
            role: "metadata",
            category: "sample-annotation",
            count: SHEETS,
            fileCount: SHEETS,
            totalBytes: 512,
            displayPattern: "data/inputs/meta/sheet_<digits>.csv",
            formats: [{ format: "csv", count: SHEETS }],
            memberAnnotations: [{ path: "data/inputs/meta/sheet_1.csv", note: "Carries the subject-to-arm mapping." }],
        },
        {
            id: "unclassified",
            name: "unclassified",
            memberRepresents: "one file no operation claimed",
            description: "Swept residue.",
            role: "data",
            category: "other",
            categoryLabel: "unclassified",
            count: 1,
            fileCount: 1,
            totalBytes: 10,
            displayPattern: "data/inputs",
            formats: [{ format: "txt", count: 1 }],
            unclassified: true,
        },
    ],
    dimensions: [
        {
            label: "subject",
            category: "subject",
            scope: "biological",
            description: "The individual each member was taken from.",
            observations: [
                {
                    kind: "slot",
                    groupIds: ["per-subject-calls"],
                    slotId: "set-1.slot-1",
                    tokenClass: "digits-fixed",
                    cardinality: SUBJECTS,
                    sampleValues: ["0001", "0002"],
                },
                { kind: "column", path: "data/inputs/meta/sheet_1.csv", column: "subject_id", exampleValues: ["0001"], distinctValues: 402 },
            ],
            reconciliations: [{ note: "The sheet names two subjects no file exists for.", delta: 2 }],
        },
        {
            label: "arm",
            category: "cohort-arm",
            scope: "biological",
            observations: [{ kind: "column", path: "data/inputs/meta/sheet_1.csv", column: "arm", exampleValues: ["treated", "control"], distinctValues: 2 }],
        },
    ],
};

/** A snapshot of the kinds era, indexed the way that era indexed it. */
const LEGACY: DataProfileResult = {
    summary: "A synthetic cohort, profiled under the previous model.",
    profiledAt: "2026-02-01T00:00:00.000Z",
    kinds: [
        {
            name: "per-subject variant calls",
            memberRepresents: "one subject's somatic variant calls",
            description: "Small-variant calls, one file per subject.",
            count: SUBJECTS,
            pathPattern: "data/inputs/vcf/*.vcf.gz",
            format: "vcf",
        },
        {
            name: "sample sheets",
            memberRepresents: "one cohort's annotation table",
            description: "Specimen annotations.",
            count: SHEETS,
            pathPattern: "data/inputs/meta/*.csv",
            format: "csv",
        },
    ],
    axes: [{ label: "subject", cardinality: SUBJECTS, exampleValues: ["0001", "0002"] }],
};

describe("a snapshot of the groups era", () => {
    it("writes three tiers: one per group, one per dimension, one per annotated member", () => {
        const entries = buildProfileIndexEntries({ analysisId: "a1", result: RESOLVED, scan: scanFixture() });

        expect(entries.filter((e) => e.metadata.type === "input-group")).toHaveLength(3);
        expect(entries.filter((e) => e.metadata.type === "input-dimension")).toHaveLength(2);
        expect(entries.filter((e) => e.metadata.type === "input")).toHaveLength(2);
        expect(entries).toHaveLength(7);
    });

    it("writes no entry for a member the agent did not annotate", () => {
        const entries = buildProfileIndexEntries({ analysisId: "a1", result: RESOLVED, scan: scanFixture() });
        expect(entries.some((e) => e.id.includes("SUBJ_0002"))).toBe(false);
        expect(entries.some((e) => e.id.includes("sheet_2.csv"))).toBe(false);
        // The whole point of the tier bound: entries scale with judgement, not with files.
        expect(entries.length).toBeLessThan(TOTAL_FILES);
    });

    it("composes a group entry from its meaning, category, and description, and carries the template and counts in metadata", () => {
        const entry = buildProfileIndexEntries({ analysisId: "a1", result: RESOLVED }).find((e) => e.metadata.group === "per-subject-calls")!;

        expect(entry.id).toBe("/a1/group/per-subject-calls");
        expect(entry.text).toContain("one member is one subject's small-variant calls");
        expect(entry.text).toContain("Small-variant calls, one member per subject.");
        expect(entry.text).toContain("variant-calls");
        expect(entry.metadata).toMatchObject({
            type: "input-group",
            name: "per-subject variant calls",
            role: "data",
            category: "variant-calls",
            pathPattern: "data/inputs/vcf/<id>.vcf.gz",
            count: SUBJECTS,
            fileCount: SUBJECTS * 2,
            slots: [{ id: "set-1.slot-1", location: "name", tokenClass: "digits-fixed", distinctValues: SUBJECTS }],
        });
    });

    it("names the swept residue as a group like any other, so the sweep is searchable", () => {
        const entry = buildProfileIndexEntries({ analysisId: "a1", result: RESOLVED }).find((e) => e.metadata.group === "unclassified")!;
        expect(entry.metadata).toMatchObject({ type: "input-group", unclassified: true, categoryLabel: "unclassified" });
    });

    it("composes a dimension entry from its label, category, and observation summaries", () => {
        const entry = buildProfileIndexEntries({ analysisId: "a1", result: RESOLVED }).find((e) => e.metadata.dimension === "subject")!;

        expect(entry.id).toBe("/a1/dimension/subject");
        expect(entry.text).toContain("subject — subject, a biological dimension");
        expect(entry.text).toContain("slot set-1.slot-1 (digits-fixed, 400 values, e.g. 0001, 0002)");
        expect(entry.text).toContain("column subject_id of data/inputs/meta/sheet_1.csv, 402 values");
        // Disagreeing observations both stand — no canonical cardinality anywhere.
        expect(entry.metadata.cardinalities).toEqual([SUBJECTS, 402]);
        expect(entry.metadata.groups).toEqual(["per-subject-calls"]);
    });

    it("addresses an annotated member by its workspace path and composes its group's meaning into the text", () => {
        const entries = buildProfileIndexEntries({ analysisId: "a1", result: RESOLVED });
        const entry = entries.find((e) => e.metadata.type === "input" && e.metadata.group === "per-subject-calls")!;

        expect(entry.id).toBe("/a1/data/inputs/vcf/SUBJ_0001.vcf.gz");
        expect(entry.text).toContain("The only member carrying a contig header.");
        expect(entry.text).toContain("one member is one subject's small-variant calls");
        expect(entry.metadata).toMatchObject({ type: "input", group: "per-subject-calls", groupName: "per-subject variant calls", format: "vcf" });
    });

    it("templates every entry deterministically — the same record gives the same entries", () => {
        const args = { analysisId: "a1", result: RESOLVED, scan: scanFixture() };
        expect(buildProfileIndexEntries(args)).toEqual(buildProfileIndexEntries(args));
    });

    it("costs round trips that scale with judgement, not with files", () => {
        const entries = buildProfileIndexEntries({ analysisId: "a1", result: RESOLVED, scan: scanFixture() });
        expect(Math.ceil(entries.length / 256)).toBe(1);
    });
});

describe("a snapshot of the kinds era", () => {
    it("keeps the kind and entity tiers it was written with", () => {
        const entries = buildProfileIndexEntries({ analysisId: "a1", result: LEGACY, scan: scanFixture() });

        expect(entries.filter((e) => e.metadata.type === "input-kind")).toHaveLength(2);
        expect(entries.filter((e) => e.metadata.type === "input")).toHaveLength(SUBJECTS);
        expect(entries.filter((e) => e.metadata.type === "input-group")).toHaveLength(0);
        expect(entries.filter((e) => e.metadata.type === "input-dimension")).toHaveLength(0);
    });

    it("labels its entity entries with the axis the profile named", () => {
        const entries = buildProfileIndexEntries({ analysisId: "a1", result: LEGACY, scan: scanFixture() });
        const entity = entries.find((e) => e.metadata.type === "input")!;
        expect(entity.metadata.axis).toBe("subject");
        expect(entity.text).toContain("one subject's somatic variant calls");
    });

    it("falls back to the notable files when a legacy profile carried no structure at all", () => {
        const entries = buildProfileIndexEntries({
            analysisId: "a1",
            result: {
                summary: "Three matrices.",
                profiledAt: "2026-01-01T00:00:00.000Z",
                files: [{ path: "data/inputs/meta/sheet_1.csv", description: "Specimen annotations.", dataType: "sample-annotation" }],
            },
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]!.metadata.type).toBe("input");
        expect(entries[0]!.id).toBe("/a1/data/inputs/meta/sheet_1.csv");
        expect(entries[0]!.metadata.path).toBe("data/inputs/meta/sheet_1.csv");
    });

    it("marks file-addressed entries with a metadata path and pattern entries with none", () => {
        const resolved = buildProfileIndexEntries({ analysisId: "a1", result: RESOLVED });
        for (const entry of resolved) {
            if (entry.metadata.path !== undefined) expect(entry.id).toBe(`/a1/${entry.metadata.path as string}`);
            else expect(entry.metadata.type).not.toBe("input");
        }
        expect(resolved.some((e) => e.metadata.path !== undefined)).toBe(true);

        const legacy = buildProfileIndexEntries({ analysisId: "a1", result: LEGACY, scan: scanFixture() });
        for (const entity of legacy.filter((e) => e.metadata.type === "input")) {
            expect(entity.metadata.entity).toBeDefined();
            expect(entity.metadata.path).toBeUndefined();
        }
    });
});
