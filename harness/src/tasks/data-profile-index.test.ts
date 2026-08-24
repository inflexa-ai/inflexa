import { describe, expect, it } from "bun:test";

import type { ProfileGroupView } from "../app/data-profile-view.js";
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

const groups: ProfileGroupView[] = [
    {
        id: "per-subject-variant-calls",
        name: "per-subject variant calls",
        memberRepresents: "one subject's somatic variant calls",
        description: "Small-variant calls, one file per subject.",
        count: SUBJECTS,
        pattern: "data/inputs/vcf/<id>.vcf.gz",
        format: "vcf",
    },
    {
        id: "variant-indexes",
        name: "variant indexes",
        memberRepresents: "the tabix index of one subject's calls",
        description: "Indexes accompanying the calls.",
        count: SUBJECTS,
        pattern: "data/inputs/tbi/<id>.vcf.gz.tbi",
        format: "tabix-index",
    },
    {
        id: "alignments",
        name: "alignments",
        memberRepresents: "one subject's aligned reads",
        description: "Per-subject alignments.",
        count: ALIGNED,
        pattern: "data/inputs/bam/<id>.bam",
        format: "bam",
    },
    {
        id: "sample-sheets",
        name: "sample sheets",
        memberRepresents: "one cohort's annotation table",
        description: "Specimen annotations.",
        count: SHEETS,
        pattern: "data/inputs/meta/sheet_<digits>.csv",
        format: "csv",
    },
];

const dimensions = [{ label: "subject", cardinalities: [SUBJECTS], exampleValues: ["0001", "0002"] }];

describe("buildProfileIndexEntries", () => {
    it("indexes one entry per group and one per entity, none per file", () => {
        const entries = buildProfileIndexEntries({ analysisId: "a1", groups, dimensions, scan: scanFixture() });

        const groupEntries = entries.filter((e) => e.metadata.type === "input-kind");
        const entityEntries = entries.filter((e) => e.metadata.type === "input");

        expect(groupEntries).toHaveLength(groups.length);
        expect(entityEntries).toHaveLength(SUBJECTS);
        expect(entries).toHaveLength(groups.length + SUBJECTS);
        // Every file went in; not one of them has an entry of its own.
        expect(entries.some((e) => e.id.includes(".vcf.gz"))).toBe(false);
    });

    it("batches into round trips that scale with groups and entities, not files", () => {
        const entries = buildProfileIndexEntries({ analysisId: "a1", groups, dimensions, scan: scanFixture() });
        const batches = Math.ceil(entries.length / 256);
        expect(batches).toBe(2);
        // The loop this replaced issued one embed + one upsert per staged file.
        expect(batches).toBeLessThan(TOTAL_FILES);
    });

    it("keeps type:'input' meaning what it meant, so existing filtered searches still match", () => {
        const entries = buildProfileIndexEntries({ analysisId: "a1", groups, dimensions, scan: scanFixture() });
        const entity = entries.find((e) => e.metadata.type === "input")!;
        expect(entity.metadata.axis).toBe("subject");
        expect(entity.text).toContain("subject");
        expect(entity.text).toContain("one subject's somatic variant calls");
    });

    it("templates every entry deterministically — the same inputs give the same entries", () => {
        const args = { analysisId: "a1", groups, dimensions, scan: scanFixture() };
        expect(buildProfileIndexEntries(args)).toEqual(buildProfileIndexEntries(args));
    });

    it("falls back to the notable files when a profile resolved no groups", () => {
        const entries = buildProfileIndexEntries({
            analysisId: "a1",
            groups: [],
            files: [{ path: "data/inputs/meta/sheet_1.csv", description: "Specimen annotations.", dataType: "sample-annotation" }],
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]!.metadata.type).toBe("input");
        expect(entries[0]!.id).toBe("/a1/data/inputs/meta/sheet_1.csv");
    });
});
