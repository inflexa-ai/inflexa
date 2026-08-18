import { describe, expect, it } from "bun:test";

import { computeCoverage } from "./coverage.js";

const tree = [
    ...Array.from({ length: 1171 }, (_, i) => `data/inputs/vcf/S${String(i + 1).padStart(4, "0")}.vcf.gz`),
    ...Array.from({ length: 1168 }, (_, i) => `data/inputs/tbi/S${String(i + 1).padStart(4, "0")}.vcf.gz.tbi`),
    "data/inputs/meta/samplesheet.csv",
];

describe("computeCoverage", () => {
    it("reports coverage of the submitted kinds, not of the scan", () => {
        const coverage = computeCoverage(tree, ["data/inputs/vcf/*.vcf.gz"]);
        expect(coverage.matched).toBe(1171);
        expect(coverage.unmatched).toBe(1169);
        expect(coverage.total).toBe(2340);
        expect(coverage.unmatchedSample.length).toBeGreaterThan(0);
    });

    it("reports zero unmatched when the kinds cover the tree", () => {
        const coverage = computeCoverage(tree, ["data/inputs/vcf/*.vcf.gz", "data/inputs/tbi/*.tbi", "data/inputs/meta/*.csv"]);
        expect(coverage.unmatched).toBe(0);
        expect(coverage.matched).toBe(coverage.total);
    });

    it("reproduces the 49-of-3513 shortfall that read as a fresh profile", () => {
        const files = Array.from({ length: 3513 }, (_, i) => `data/inputs/vcf/PATIENT_${String(i + 1).padStart(4, "0")}.vcf.gz`);
        const described = files.slice(0, 49).map((path) => path);
        const coverage = computeCoverage(files, described);
        expect(coverage.matched).toBe(49);
        expect(coverage.unmatched).toBe(3464);
    });

    it("treats a bare directory pattern as covering what is beneath it", () => {
        const coverage = computeCoverage(tree, ["data/inputs/vcf", "data/inputs/tbi", "data/inputs/meta"]);
        expect(coverage.unmatched).toBe(0);
    });

    it("supports ** across directories and the manifest's <n> placeholders", () => {
        expect(computeCoverage(tree, ["data/inputs/**/*.vcf.gz"]).matched).toBe(1171);
        expect(computeCoverage(tree, ["data/inputs/vcf/S<0>.vcf.gz"]).matched).toBe(1171);
    });

    it("counts a pattern that matches nothing as covering nothing", () => {
        const coverage = computeCoverage(tree, ["data/inputs/bam/*.bam"]);
        expect(coverage.matched).toBe(0);
        expect(coverage.unmatched).toBe(tree.length);
    });
});
