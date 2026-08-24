import { describe, expect, it } from "bun:test";

import { quarantine, quarantineReason } from "./quarantine.js";
import type { ScannedFile } from "./types.js";

function file(path: string, size = 1024): ScannedFile {
    return { path, size, extensions: [], format: "unknown" };
}

describe("quarantineReason", () => {
    it("names the rule a path trips", () => {
        expect(quarantineReason("data/inputs/.DS_Store")).toBe("os-junk");
        expect(quarantineReason("data/inputs/__MACOSX/panel.csv")).toBe("os-junk");
        expect(quarantineReason("data/inputs/panel.csv.crdownload")).toBe("partial-download");
        expect(quarantineReason("data/inputs/panel.csv.part")).toBe("partial-download");
        expect(quarantineReason("data/inputs/panel.csv.tmp-3f6a1c92-4b0d-4e7f-9a21-8c5d0e1b7a34")).toBe("atomic-write-temp");
        expect(quarantineReason("data/inputs/panel.csv.tmp-8c5d0e1b")).toBe("atomic-write-temp");
        expect(quarantineReason("data/inputs/notes.txt~")).toBe("editor-temp");
    });

    it("leaves a data file alone", () => {
        expect(quarantineReason("data/inputs/panel.csv")).toBeUndefined();
        expect(quarantineReason("data/inputs/temperature_series.tsv")).toBeUndefined();
    });
});

describe("quarantine", () => {
    it("keeps the completed file and excludes its partial-download twin", () => {
        const complete = file("data/inputs/assay_001.tsv");
        const partial = file("data/inputs/assay_001.tsv.tmp-8c5d0e1b7a34");

        const { kept, summary } = quarantine([complete, partial]);

        expect(kept.map((f) => f.path)).toEqual([complete.path]);
        expect(summary.count).toBe(1);
        expect(summary.reasons).toEqual([{ reason: "atomic-write-temp", count: 1 }]);
    });

    it("reports what it excluded rather than hiding it", () => {
        const files = [
            file("data/inputs/.DS_Store", 8),
            file("data/inputs/notes.txt~", 16),
            file("data/inputs/assay_002.tsv.part", 32),
            file("data/inputs/assay_002.tsv", 64),
        ];

        const { kept, summary } = quarantine(files);

        expect(kept).toHaveLength(1);
        expect(summary.count).toBe(3);
        expect(summary.totalBytes).toBe(56);
        expect(summary.reasons.map((r) => r.reason).sort()).toEqual(["editor-temp", "os-junk", "partial-download"]);
        expect(summary.sample).toContain("data/inputs/.DS_Store");
    });

    it("bounds the sample it reports", () => {
        const files = Array.from({ length: 60 }, (_, i) => file(`data/inputs/scratch_${i}.tsv.part`));

        const { summary } = quarantine(files);

        expect(summary.count).toBe(60);
        expect(summary.sample.length).toBeLessThanOrEqual(12);
    });
});
