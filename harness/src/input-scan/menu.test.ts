import { describe, expect, it } from "bun:test";

import { detectSets } from "./detect-sets.js";
import { MAX_MENU_SETS, buildCorrespondences, buildSetMenu, renderSetMenu } from "./menu.js";
import type { HeaderReadout, ScannedFile } from "./types.js";

function file(path: string, format: string, extensions: string[] = [], wrapper?: string): ScannedFile {
    return { path, size: 100, extensions, format, ...(wrapper ? { wrapper } : {}) };
}

const id = (n: number) => `S${String(n).padStart(3, "0")}`;

/** Two sets sharing an identifier, a companion gap, a leftover, and one quarantined file. */
function tree(): ScannedFile[] {
    const files: ScannedFile[] = [];
    for (let i = 1; i <= 6; i++) {
        for (const origin of ["somatic", "germline"]) {
            files.push(file(`data/inputs/calls/${id(i)}.${origin}.vcf.gz`, "vcf", ["vcf", "gz"], "bgzip"));
            if (i < 6) files.push(file(`data/inputs/calls/${id(i)}.${origin}.vcf.gz.tbi`, "tabix-index", ["vcf", "gz", "tbi"]));
        }
        if (i <= 5) files.push(file(`data/inputs/align/${id(i)}.bam`, "bam", ["bam"]));
    }
    files.push(file("data/inputs/meta/samplesheet.csv", "csv", ["csv"]));
    files.push(file("data/inputs/.DS_Store", "unknown"));
    return files;
}

describe("the rendered menu", () => {
    const detected = detectSets(tree());
    const menu = buildSetMenu(detected);
    const text = renderSetMenu(menu, "data/inputs");

    it("leads with the census and says the grouping is the reader's", () => {
        expect(text).toContain(`${detected.keptFileCount} files kept of ${detected.fileCount} scanned`);
        expect(text).toContain("not a grouping of the dataset");
        expect(text).toContain("no other id is addressable");
    });

    it("names each set by its addressable id, with its origin, template, and counts", () => {
        const set = menu.sets[0]!;
        expect(text).toContain(`- ${set.id} — ${set.memberCount} members, ${set.fileCount} files`);
        expect(text).toContain(`template: ${set.pathTemplate}`);
    });

    it("reports every slot's class, cardinality, and bounded value sample", () => {
        const set = menu.sets.find((candidate) => candidate.slots.length >= 2)!;
        for (const slot of set.slots) {
            expect(text).toContain(`slot ${slot.id}`);
            expect(text).toContain(`${slot.distinctValues} distinct`);
            expect(text).toContain(slot.sampleValues[0]!);
        }
    });

    it("names the members missing an expected companion rather than averaging the gap away", () => {
        expect(text).toContain("companions .tbi");
        expect(text).toContain("incomplete");
        expect(text).toContain(`data/inputs/calls/${id(6)}.somatic.vcf.gz missing .tbi`);
    });

    it("reports the quarantine with its reasons, so a wrongly excluded file is discoverable", () => {
        expect(text).toContain("Quarantined before structure was observed: 1 files — os-junk (1)");
        expect(text).toContain("data/inputs/.DS_Store");
    });

    it("aggregates the files no set speaks for and says how to claim them", () => {
        expect(text).toContain("Files no set speaks for");
        expect(text).toContain("data/inputs/meta/samplesheet.csv");
        expect(text).toContain("`group` operation");
    });

    it("reports slot overlap as measurement with its gaps, never as a shared dimension", () => {
        const overlap = menu.correspondences.find((entry) => entry.sets[0] !== entry.sets[1])!;
        expect(overlap.shared).toBe(5);
        expect(overlap.onlyInFirst + overlap.onlyInSecond).toBeGreaterThan(0);
        expect(text).toContain("NOT an assertion that they share a dimension");
        expect(text).toContain(`${overlap.slots[0]} vs ${overlap.slots[1]}`);
        expect(text).toContain("only in");
    });

    it("attaches a header readout to the set its member was read from", () => {
        const target = menu.sets[0]!.members[0]!.path;
        const headers = new Map<string, HeaderReadout>([[target, { path: target, fields: { columns: 12, delimiter: "," } }]]);
        expect(renderSetMenu(buildSetMenu(detected, headers), "data/inputs")).toContain(`readout (${target}): columns=12, delimiter=,`);
    });
});

describe("menu bounds", () => {
    const base = detectSets(tree());

    it("lists at most the bound and folds the tail into a counted line", () => {
        const overflowing = {
            ...base,
            sets: Array.from({ length: MAX_MENU_SETS + 5 }, (_, i) => ({ ...base.sets[0]!, id: `set-${i + 1}` })),
        };

        const menu = buildSetMenu(overflowing);
        expect(menu.sets).toHaveLength(MAX_MENU_SETS);
        expect(menu.unlisted.sets).toBe(5);
        expect(menu.unlisted.members).toBe(base.sets[0]!.memberCount * 5);

        const text = renderSetMenu(menu, "data/inputs");
        expect(text).toContain("… 5 more sets not listed");
        expect(text).toContain("unaddressable");
    });

    it("nudges toward a split when a set is what nothing else explained", () => {
        const catchAll = { ...base, sets: [{ ...base.sets[0]!, origin: "catch-all" as const }] };
        expect(renderSetMenu(buildSetMenu(catchAll), "data/inputs")).toContain("Consider a split before you use or merge it");
    });

    it("reports no correspondence between sets whose values do not overlap", () => {
        const files = [
            ...Array.from({ length: 4 }, (_, i) => file(`data/inputs/a/A${i}.csv`, "csv", ["csv"])),
            ...Array.from({ length: 4 }, (_, i) => file(`data/inputs/b/B${i + 90}.tsv`, "tsv", ["tsv"])),
        ];
        const detected = detectSets(files);
        expect(buildCorrespondences(detected, detected.sets)).toEqual([]);
    });
});
