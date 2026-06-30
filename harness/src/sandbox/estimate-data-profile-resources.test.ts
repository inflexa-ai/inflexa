import { describe, expect, it } from "bun:test";
import { estimateDataProfileResources } from "./estimate-data-profile-resources.js";

describe("estimateDataProfileResources", () => {
    it("empty list → minimal spec", () => {
        expect(estimateDataProfileResources([])).toEqual({ cpu: 1, memoryGb: 2 });
    });

    it("single 14 MB csv", () => {
        expect(estimateDataProfileResources([{ relativePath: "data/a.csv", size: 14_000_000 }])).toEqual({ cpu: 1, memoryGb: 3 });
    });

    it("single 5 GB csv → tier 4 cpu, large memory", () => {
        expect(estimateDataProfileResources([{ relativePath: "data/big.csv", size: 5_000_000_000 }])).toEqual({ cpu: 4, memoryGb: 42 });
    });

    it("single 2 GB parquet → factor 4", () => {
        expect(estimateDataProfileResources([{ relativePath: "data/x.parquet", size: 2_000_000_000 }])).toEqual({ cpu: 4, memoryGb: 10 });
    });

    it("single 3 GB bam → factor 2", () => {
        expect(estimateDataProfileResources([{ relativePath: "data/reads.bam", size: 3_000_000_000 }])).toEqual({ cpu: 4, memoryGb: 8 });
    });

    it("compound extension .csv.gz uses gz factor (12)", () => {
        // 1 GB → ceil(2 + 1e9*12/1e9) = ceil(14) = 14
        expect(estimateDataProfileResources([{ relativePath: "data/a.csv.gz", size: 1_000_000_000 }])).toEqual({ cpu: 4, memoryGb: 14 });
    });

    it("8 small files → +1 cpu", () => {
        const files = Array.from({ length: 8 }, (_, i) => ({
            relativePath: `data/f${i}.csv`,
            size: 1_000_000,
        }));
        expect(estimateDataProfileResources(files)).toEqual({ cpu: 2, memoryGb: 3 });
    });

    it("unknown extension → factor 6", () => {
        // 1 GB → ceil(2 + 1e9*6/1e9) = ceil(8) = 8
        expect(estimateDataProfileResources([{ relativePath: "data/foo.bin", size: 1_000_000_000 }])).toEqual({ cpu: 4, memoryGb: 8 });
    });
});
