/**
 * A snapshot carries the fields of its era and there is no version field to consult, so
 * the only thing that keeps consumers from drifting is that they all read a row the same
 * way. These pin that reading, for both eras.
 */

import { describe, expect, it } from "bun:test";

import type { DataProfileResult } from "../contracts/data-profile.js";
import { profileCaveats, profileDatasetFileCount, profileDimensions, profileFileRecords, profileGroups } from "./data-profile-view.js";

const BASE = { summary: "A synthetic dataset.", profiledAt: "2026-08-24T00:00:00.000Z" };

const LEGACY: DataProfileResult = {
    ...BASE,
    files: [{ path: "data/inputs/meta/sheet.csv", description: "Specimen annotations." }],
    kinds: [
        {
            name: "per-subject calls",
            memberRepresents: "one subject's calls",
            description: "Small-variant calls.",
            count: 40,
            pathPattern: "data/inputs/vcf/*.vcf.gz",
            format: "VCF",
        },
    ],
    axes: [{ label: "subject", cardinality: 40, exampleValues: ["S001", "S002"] }],
    coverage: { matched: 80, unmatched: 2, total: 82 },
    qualityAssessment: { concerns: ["batch is confounded with arm"] },
};

const RESOLVED: DataProfileResult = {
    ...BASE,
    caveats: ["one subject has no alignment"],
    groups: [
        {
            id: "per-subject-calls",
            name: "per-subject calls",
            memberRepresents: "one subject's calls",
            description: "Small-variant calls.",
            role: "data",
            category: "variant-calls",
            count: 40,
            fileCount: 80,
            totalBytes: 8000,
            displayPattern: "data/inputs/vcf/<id>.vcf.gz",
            formats: [{ format: "VCF", count: 40 }],
            memberAnnotations: [{ path: "data/inputs/vcf/S001.vcf.gz", note: "Only member carrying a contig header." }],
            slots: [{ id: "set-1.slot-1", location: "name", index: 0, tokenClass: "digits-fixed", distinctValues: 40, sampleValues: ["001"] }],
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
                { kind: "slot", groupIds: ["per-subject-calls"], slotId: "set-1.slot-1", tokenClass: "digits-fixed", cardinality: 40, sampleValues: ["001"] },
                { kind: "document", path: "data/inputs/README.md", citation: "Forty-two subjects were enrolled.", statesCardinality: 42 },
            ],
            reconciliations: [{ note: "The document counts enrolled subjects; the files count profiled ones.", delta: 2 }],
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

describe("reading a snapshot of either era", () => {
    it("serves a resolved row's groups and a legacy row's kinds through one shape", () => {
        expect(profileGroups(RESOLVED).map((group) => group.name)).toEqual(["per-subject calls", "unclassified"]);
        expect(profileGroups(RESOLVED)[0]!.pattern).toBe("data/inputs/vcf/<id>.vcf.gz");
        expect(profileGroups(RESOLVED)[1]!.unclassified).toBe(true);

        const legacy = profileGroups(LEGACY);
        expect(legacy).toHaveLength(1);
        expect(legacy[0]!.pattern).toBe("data/inputs/vcf/*.vcf.gz");
        expect(legacy[0]!.memberRepresents).toBe("one subject's calls");
    });

    it("carries every observed cardinality side by side rather than picking one", () => {
        expect(profileDimensions(RESOLVED)[0]!.cardinalities).toEqual([40, 42]);
        expect(profileDimensions(LEGACY)[0]!.cardinalities).toEqual([40]);
        expect(profileDimensions(LEGACY)[0]!.exampleValues).toEqual(["S001", "S002"]);
    });

    it("serves annotated members as the individually described files on a resolved row", () => {
        expect(profileFileRecords(RESOLVED)).toEqual([
            { path: "data/inputs/vcf/S001.vcf.gz", description: "Only member carrying a contig header.", format: "VCF" },
        ]);
        expect(profileFileRecords(LEGACY)).toEqual(LEGACY.files!);
    });

    it("prefers the census over the older coverage figure, and admits when a row can say neither", () => {
        expect(profileDatasetFileCount(RESOLVED)).toBe(82);
        expect(profileDatasetFileCount(LEGACY)).toBe(82);
        expect(profileDatasetFileCount({ ...BASE, files: [] })).toBeNull();
    });

    it("reads a legacy row's concerns as caveats", () => {
        expect(profileCaveats(RESOLVED)).toEqual(["one subject has no alignment"]);
        expect(profileCaveats(LEGACY)).toEqual(["batch is confounded with arm"]);
        expect(profileCaveats({ ...BASE })).toEqual([]);
    });

    it("renders a row of either era without consulting a version field", () => {
        expect(Object.keys(RESOLVED)).not.toContain("version");
        expect(Object.keys(LEGACY)).not.toContain("version");
        // A pre-structure row is neither rejected nor given a structure it never had.
        expect(profileGroups({ ...BASE })).toEqual([]);
        expect(profileDimensions({ ...BASE })).toEqual([]);
    });
});
