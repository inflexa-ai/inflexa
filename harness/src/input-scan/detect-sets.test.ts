import { describe, expect, it } from "bun:test";

import type { ContentSimilarity } from "./clustering.js";
import { detectSets } from "./detect-sets.js";
import { basenameOf } from "./tokens.js";
import type { ScannedFile } from "./types.js";

function file(path: string, options: { format?: string; size?: number; wrapper?: string } = {}): ScannedFile {
    const base = basenameOf(path);
    const dot = base.indexOf(".");
    const extensions = dot <= 0 ? [] : base.slice(dot + 1).split(".");
    return {
        path,
        size: options.size ?? 1024,
        extensions,
        format: options.format ?? extensions[0] ?? "unknown",
        ...(options.wrapper ? { wrapper: options.wrapper } : {}),
    };
}

function pad(n: number, width = 2): string {
    return String(n).padStart(width, "0");
}

/** One directory per specimen, one directory per subject above it. */
function perSpecimenDelivery(subjects: number): ScannedFile[] {
    const files: ScannedFile[] = [];
    for (let s = 1; s <= subjects; s++) {
        const subject = `SUBJ${pad(s, 3)}`;
        for (const tissue of ["baseline", "followup"]) {
            const specimen = `${subject}-${tissue}`;
            for (const kind of ["somatic", "germline"]) {
                for (const caller of ["alpha", "beta"]) {
                    const stem = `inputs/cohort/${subject}/${specimen}/${specimen}__calls.${kind}.${caller}.vcf.gz`;
                    files.push(file(stem, { format: "vcf", wrapper: "bgzip" }));
                    files.push(file(`${stem}.tbi`, { format: "tabix-index", size: 32 }));
                }
            }
        }
    }
    return files;
}

describe("detectSets", () => {
    it("reports identity that lives in directory segments as one cross-directory set", () => {
        const result = detectSets(perSpecimenDelivery(9));

        expect(result.sets).toHaveLength(1);
        const set = result.sets[0]!;
        expect(set.memberCount).toBe(9 * 2 * 2 * 2);
        expect(set.fileCount).toBe(set.memberCount * 2);
        expect(result.leftovers.memberCount).toBe(0);
        expect(result.coverage).toBe(1);

        const directorySlots = set.slots.filter((slot) => slot.location === "directory");
        expect(directorySlots.length).toBeGreaterThanOrEqual(2);
        expect(directorySlots[0]!.distinctValues).toBe(9);
        expect(directorySlots[1]!.distinctValues).toBe(18);
        expect(set.pathTemplate).toStartWith("inputs/cohort/");
    });

    it("reports the categorical tokens of a suffix chain with their values", () => {
        const set = detectSets(perSpecimenDelivery(9)).sets[0]!;
        const nameSlots = set.slots.filter((slot) => slot.location === "name");

        const kinds = nameSlots.find((slot) => slot.sampleValues.includes("somatic"));
        const callers = nameSlots.find((slot) => slot.sampleValues.includes("alpha"));
        expect(kinds?.sampleValues).toEqual(["germline", "somatic"]);
        expect(callers?.sampleValues).toEqual(["alpha", "beta"]);
        expect(set.formats).toEqual([{ format: "vcf", count: 72 }]);
    });

    it("links a stem token to the directory segment it repeats", () => {
        const set = detectSets(perSpecimenDelivery(9)).sets[0]!;

        const linked = set.slots.find((slot) => slot.sameAsSlot !== undefined);
        expect(linked).toBeDefined();
        expect(linked!.location).toBe("name");
        const target = set.slots.find((slot) => slot.id === linked!.sameAsSlot);
        expect(target?.location).toBe("directory");
        expect(target?.distinctValues).toBe(linked!.distinctValues);
    });

    it("attaches companions and computes per-member completeness", () => {
        const files = perSpecimenDelivery(9).filter(
            (f) => f.path !== "inputs/cohort/SUBJ001/SUBJ001-baseline/SUBJ001-baseline__calls.somatic.alpha.vcf.gz.tbi",
        );

        const set = detectSets(files).sets[0]!;

        expect(set.completeness.expectedCompanions).toEqual([".tbi"]);
        expect(set.completeness.incompleteMembers).toBe(1);
        expect(set.completeness.incompleteSample[0]!.path).toBe("inputs/cohort/SUBJ001/SUBJ001-baseline/SUBJ001-baseline__calls.somatic.alpha.vcf.gz");
    });

    it("quarantines a partial-download twin and says so", () => {
        const files = [
            ...perSpecimenDelivery(9),
            file("inputs/cohort/SUBJ001/SUBJ001-baseline/SUBJ001-baseline__calls.somatic.alpha.vcf.gz.tmp-3f6a1c92", { size: 4 }),
            file("inputs/.DS_Store", { size: 8 }),
        ];

        const result = detectSets(files);

        expect(result.quarantine.count).toBe(2);
        expect(result.quarantine.reasons.map((r) => r.reason).sort()).toEqual(["atomic-write-temp", "os-junk"]);
        expect(result.quarantine.sample).toContain("inputs/.DS_Store");
        const members = result.sets.flatMap((set) => set.members.map((member) => member.path));
        expect(members.some((path) => path.includes(".tmp-"))).toBe(false);
        expect(result.sets[0]!.memberCount).toBe(72);
    });

    it("keeps members that differ only in compression in one set", () => {
        const files = [
            ...Array.from({ length: 5 }, (_, i) => file(`inputs/panel_${pad(i + 1, 3)}.vcf`, { format: "vcf" })),
            ...Array.from({ length: 5 }, (_, i) => file(`inputs/panel_${pad(i + 6, 3)}.vcf.gz`, { format: "vcf", wrapper: "bgzip" })),
        ];

        const result = detectSets(files);

        expect(result.sets).toHaveLength(1);
        const set = result.sets[0]!;
        expect(set.memberCount).toBe(10);
        expect(set.formats).toEqual([{ format: "vcf", count: 10 }]);
        expect(set.wrappers).toEqual([
            { wrapper: "bgzip", count: 5 },
            { wrapper: "none", count: 5 },
        ]);
        expect(set.pathTemplate).toBe("inputs/panel_<digits:3>.{vcf,vcf.gz}");
    });

    it("reports a marker-claimed directory as one set instead of mining its filenames", () => {
        const files = [
            file("inputs/counts/matrix.mtx.gz", { format: "matrix-market", wrapper: "gzip" }),
            file("inputs/counts/barcodes.tsv.gz", { format: "tsv", wrapper: "gzip" }),
            file("inputs/counts/features.tsv.gz", { format: "tsv", wrapper: "gzip" }),
        ];

        const result = detectSets(files);

        expect(result.sets).toHaveLength(1);
        expect(result.sets[0]!.origin).toBe("marker");
        expect(result.sets[0]!.marker).toBe("feature-barcode-matrix");
        expect(result.sets[0]!.pathTemplate).toBe("inputs/counts/**");
        expect(result.sets[0]!.slots).toEqual([]);
        expect(result.coverage).toBe(1);
    });

    it("gathers files no set speaks for into one aggregate", () => {
        const files = [
            ...perSpecimenDelivery(9),
            file("inputs/protocol.pdf", { format: "pdf", size: 4096 }),
            file("inputs/README.md", { format: "markdown", size: 512 }),
            file("inputs/cohort_roster.xlsx", { format: "excel", size: 2048 }),
        ];

        const result = detectSets(files);

        expect(result.sets).toHaveLength(1);
        expect(result.leftovers.memberCount).toBe(3);
        expect(result.leftovers.totalBytes).toBe(6656);
        expect(result.leftovers.sample.map((entry) => entry.format).sort()).toEqual(["excel", "markdown", "pdf"]);
        expect(result.sets[0]!.fileCount + result.leftovers.fileCount).toBe(result.keptFileCount);
    });

    it("bounds the leftover sample without losing the count", () => {
        const files = Array.from({ length: 80 }, (_, i) => file(`inputs/${i % 2 === 0 ? "note" : "sheet"}-${i}-${i * 3}.dat${i}`, { format: `fmt-${i}` }));

        const result = detectSets(files);

        expect(result.leftovers.memberCount + result.sets.reduce((total, set) => total + set.memberCount, 0)).toBe(80);
        expect(result.leftovers.sample.length).toBeLessThanOrEqual(25);
    });

    it("selects one representative per set plus every leftover", () => {
        const files = [...perSpecimenDelivery(9), file("inputs/protocol.pdf", { format: "pdf" }), file("inputs/README.md", { format: "markdown" })];

        const result = detectSets(files);

        expect(result.readout.representatives).toHaveLength(result.sets.length);
        expect(result.readout.representatives[0]!.setId).toBe(result.sets[0]!.id);
        expect(result.readout.individual).toEqual(["inputs/protocol.pdf", "inputs/README.md"]);
        const total = result.readout.representatives.length + result.readout.individual.length;
        expect(total).toBeLessThan(result.keptFileCount);
    });

    it("carries the complete value set host-side while the slot sample stays bounded", () => {
        const result = detectSets(perSpecimenDelivery(40));
        const set = result.sets[0]!;
        const subjectSlot = set.slots.find((slot) => slot.location === "directory")!;

        expect(subjectSlot.distinctValues).toBe(40);
        expect(subjectSlot.sampleValues.length).toBeLessThanOrEqual(12);
        expect(result.slotValues.get(subjectSlot.id)).toHaveLength(40);
    });

    it("takes injected content agreement into account when clustering siblings", () => {
        const files = [
            file("inputs/first/alpha.csv", { format: "csv" }),
            file("inputs/first/beta.csv", { format: "csv" }),
            file("inputs/second/gamma.tsv", { format: "tsv" }),
            file("inputs/second/delta.tsv", { format: "tsv" }),
        ];
        const sameSchema: ContentSimilarity = () => 1;

        const structural = detectSets(files);
        const withContent = detectSets(files, { contentSimilarity: sameSchema });

        expect(structural.sets.every((set) => set.slots.every((slot) => slot.location === "name"))).toBe(true);
        expect(withContent.sets.some((set) => set.slots.some((slot) => slot.location === "directory"))).toBe(true);
    });

    it("reports an empty tree without dividing by zero", () => {
        const result = detectSets([]);

        expect(result.sets).toEqual([]);
        expect(result.coverage).toBe(1);
        expect(result.leftovers.memberCount).toBe(0);
        expect(result.readout.individual).toEqual([]);
    });
});
