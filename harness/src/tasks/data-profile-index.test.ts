import { describe, expect, it } from "bun:test";

import { buildManifest } from "../input-scan/scan.js";
import type { ScannedFile } from "../input-scan/types.js";
import type { DataProfileKind } from "../state/data-profile.js";
import { buildProfileIndexEntries } from "./data-profile-index.js";

const pad = (n: number) => String(n).padStart(4, "0");

function file(path: string, format: string): ScannedFile {
    const base = path.slice(path.lastIndexOf("/") + 1);
    const dot = base.indexOf(".");
    return { path, size: 2048, extensions: dot <= 0 ? [] : base.slice(dot + 1).split("."), format };
}

/** 3513 files, four shapes, 1171 subjects. */
function motivatingScan() {
    const files: ScannedFile[] = [
        ...Array.from({ length: 1171 }, (_, i) => file(`data/inputs/vcf/PATIENT_${pad(i + 1)}.vcf.gz`, "vcf")),
        ...Array.from({ length: 1171 }, (_, i) => file(`data/inputs/tbi/PATIENT_${pad(i + 1)}.vcf.gz.tbi`, "tabix-index")),
        ...Array.from({ length: 1168 }, (_, i) => file(`data/inputs/bam/PATIENT_${pad(i + 1)}.bam`, "bam")),
        ...Array.from({ length: 3 }, (_, i) => file(`data/inputs/meta/sheet_${i + 1}.csv`, "csv")),
    ];
    return buildManifest("data/inputs", files, false);
}

const kinds: DataProfileKind[] = [
    {
        name: "per-patient variant calls",
        memberRepresents: "one patient's somatic variant calls",
        description: "HaplotypeCaller VCFs, one per patient.",
        count: 1171,
        pathPattern: "data/inputs/vcf/*.vcf.gz",
        format: "vcf",
        axisLabels: ["patient"],
    },
    {
        name: "variant indexes",
        memberRepresents: "the tabix index of one patient's calls",
        description: "Tabix indexes accompanying the VCFs.",
        count: 1171,
        pathPattern: "data/inputs/tbi/*.tbi",
        format: "tabix-index",
        axisLabels: ["patient"],
    },
    {
        name: "alignments",
        memberRepresents: "one patient's aligned reads",
        description: "Per-patient BAMs.",
        count: 1168,
        pathPattern: "data/inputs/bam/*.bam",
        format: "bam",
        axisLabels: ["patient"],
    },
    {
        name: "sample sheets",
        memberRepresents: "one cohort's clinical annotation table",
        description: "Clinical metadata.",
        count: 3,
        pathPattern: "data/inputs/meta/*.csv",
        format: "csv",
    },
];

describe("buildProfileIndexEntries", () => {
    it("indexes one entry per kind and one per entity, none per file", () => {
        const entries = buildProfileIndexEntries({
            analysisId: "a1",
            kinds,
            axes: [{ label: "patient", cardinality: 1171 }],
            scan: motivatingScan(),
        });

        const kindEntries = entries.filter((e) => e.metadata.type === "input-kind");
        const entityEntries = entries.filter((e) => e.metadata.type === "input");

        expect(kindEntries).toHaveLength(4);
        expect(entityEntries).toHaveLength(1171);
        expect(entries).toHaveLength(1175);
        // 3513 files went in; not one of them has an entry of its own.
        expect(entries.some((e) => e.id.includes(".vcf.gz"))).toBe(false);
    });

    it("batches into round trips that scale with kinds and entities, not files", () => {
        const entries = buildProfileIndexEntries({
            analysisId: "a1",
            kinds,
            axes: [{ label: "patient", cardinality: 1171 }],
            scan: motivatingScan(),
        });
        const batches = Math.ceil(entries.length / 256);
        expect(batches).toBe(5);
        // The loop this replaced issued one embed + one upsert per staged file.
        expect(batches).toBeLessThan(3513);
    });

    it("keeps type:'input' meaning what it meant, so existing filtered searches still match", () => {
        const entries = buildProfileIndexEntries({
            analysisId: "a1",
            kinds,
            axes: [{ label: "patient", cardinality: 1171 }],
            scan: motivatingScan(),
        });
        const entity = entries.find((e) => e.metadata.type === "input")!;
        expect(entity.metadata.axis).toBe("patient");
        expect(entity.text).toContain("patient");
        expect(entity.text).toContain("one patient's somatic variant calls");
    });

    it("templates every entry deterministically — the same inputs give the same entries", () => {
        const args = { analysisId: "a1", kinds, axes: [{ label: "patient", cardinality: 1171 }], scan: motivatingScan() };
        expect(buildProfileIndexEntries(args)).toEqual(buildProfileIndexEntries(args));
    });

    it("falls back to the notable files when a profile submitted no kinds", () => {
        const entries = buildProfileIndexEntries({
            analysisId: "a1",
            kinds: [],
            files: [{ path: "data/inputs/meta/sheet_1.csv", description: "Clinical annotations.", dataType: "clinical-metadata" }],
        });
        expect(entries).toHaveLength(1);
        expect(entries[0]!.metadata.type).toBe("input");
        expect(entries[0]!.id).toBe("/a1/data/inputs/meta/sheet_1.csv");
    });
});
