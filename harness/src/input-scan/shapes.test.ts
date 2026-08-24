import { describe, expect, it } from "bun:test";

import { observeShapes } from "./shapes.js";
import type { ScannedFile } from "./types.js";

function file(path: string, opts: { format?: string; size?: number } = {}): ScannedFile {
    const base = path.slice(path.lastIndexOf("/") + 1);
    const dot = base.indexOf(".");
    const extensions = dot <= 0 ? [] : base.slice(dot + 1).split(".");
    return {
        path,
        size: opts.size ?? 1024,
        extensions,
        format: opts.format ?? extensions[0] ?? "unknown",
    };
}

function pad(n: number, width = 4): string {
    return String(n).padStart(width, "0");
}

describe("observeShapes", () => {
    it("reports a repeating structure as one shape carrying its values", () => {
        const files = Array.from({ length: 800 }, (_, i) => file(`data/inputs/vcf/PATIENT_${pad(i + 1)}.haplotypecaller.vcf.gz`, { format: "vcf" }));

        const observed = observeShapes(files);

        expect(observed.shapes).toHaveLength(1);
        const shape = observed.shapes[0]!;
        expect(shape.fileCount).toBe(800);
        expect(shape.variablePositions).toHaveLength(1);
        expect(shape.variablePositions[0]!.distinctValues).toBe(800);
        expect(shape.variablePositions[0]!.sampleValues.length).toBeGreaterThan(0);
        expect(shape.variablePositions[0]!.sampleValues).toContain("0001");
        expect(observed.unstructured.count).toBe(0);
    });

    it("reports nested variation per position rather than as a flat file count", () => {
        const files: ScannedFile[] = [];
        for (let subject = 1; subject <= 20; subject++) {
            for (const day of [0, 7, 28]) {
                for (const rep of [1, 2]) {
                    files.push(file(`data/inputs/fastq/PT${pad(subject, 3)}_D${day}_rep${rep}.fastq.gz`, { format: "fastq" }));
                }
            }
        }

        const observed = observeShapes(files);

        expect(observed.shapes).toHaveLength(1);
        const shape = observed.shapes[0]!;
        expect(shape.fileCount).toBe(120);
        expect(shape.variablePositions.map((p) => p.distinctValues)).toEqual([20, 3, 2]);
        // The design is fully crossed, and the manifest says so rather than reporting 120.
        expect(shape.cooccurrence.every((pair) => pair.observedPairs === pair.possiblePairs)).toBe(true);
    });

    it("reports a categorical position by its values, not merely its cardinality", () => {
        const files = [
            ...Array.from({ length: 12 }, (_, i) => file(`data/inputs/bam/tumor_${pad(i + 1, 2)}.bam`, { format: "bam" })),
            ...Array.from({ length: 12 }, (_, i) => file(`data/inputs/bam/normal_${pad(i + 1, 2)}.bam`, { format: "bam" })),
        ];

        const observed = observeShapes(files);

        expect(observed.shapes).toHaveLength(1);
        const categorical = observed.shapes[0]!.variablePositions.find((p) => p.distinctValues === 2);
        expect(categorical).toBeDefined();
        expect([...categorical!.sampleValues].sort()).toEqual(["normal", "tumor"]);
    });

    it("collapses files sharing no name structure into one aggregate", () => {
        const words = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa"];
        const files = Array.from({ length: 3000 }, (_, i) =>
            file(`data/inputs/misc/${words[i % words.length]}-${i}-${words[(i * 7) % words.length]}-${i * 13}.dat`, { format: "unknown" }),
        );

        const observed = observeShapes(files);

        expect(observed.shapes.length).toBeLessThanOrEqual(30);
        expect(observed.unstructured.count + observed.shapes.reduce((sum, s) => sum + s.fileCount, 0)).toBe(3000);
        expect(observed.unstructured.sample.length).toBeLessThanOrEqual(25);
    });

    it("names the gap when two shapes' value sets nearly overlap", () => {
        const variants = Array.from({ length: 20 }, (_, i) => file(`data/inputs/vcf/S${pad(i + 1, 3)}.vcf.gz`, { format: "vcf" }));
        // Three subjects have no index file — the completeness fact the overlap exists to surface.
        const indexes = Array.from({ length: 17 }, (_, i) => file(`data/inputs/tbi/S${pad(i + 1, 3)}.vcf.gz.tbi`, { format: "tabix-index" }));

        const observed = observeShapes([...variants, ...indexes]);

        expect(observed.shapes).toHaveLength(2);
        expect(observed.valueOverlaps).toHaveLength(1);
        const overlap = observed.valueOverlaps[0]!;
        expect(overlap.sharedValues).toBe(17);
        expect(overlap.onlyInFirst + overlap.onlyInSecond).toBe(3);
        expect(overlap.onlyInFirstSample).toContain("018");
    });

    it("lets an unrecognised format join a shape", () => {
        const files = Array.from({ length: 200 }, (_, i) => file(`data/inputs/blobs/run_${pad(i + 1, 3)}.qqq`, { format: "unknown" }));

        const observed = observeShapes(files);

        expect(observed.shapes).toHaveLength(1);
        expect(observed.shapes[0]!.format).toBe("unknown");
        expect(observed.shapes[0]!.extensions).toEqual(["qqq"]);
        expect(observed.shapes[0]!.variablePositions).toHaveLength(1);
    });

    it("does not merge shapes that differ in more than one alphabetic position", () => {
        const files = [
            ...Array.from({ length: 5 }, (_, i) => file(`data/inputs/a/tumor_biopsy_${i}.csv`)),
            ...Array.from({ length: 5 }, (_, i) => file(`data/inputs/a/normal_blood_${i}.csv`)),
        ];

        const observed = observeShapes(files);

        expect(observed.shapes).toHaveLength(2);
        expect(observed.shapes.every((s) => s.fileCount === 5)).toBe(true);
    });
});
