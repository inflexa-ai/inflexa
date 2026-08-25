import { describe, expect, it } from "bun:test";

import { fileTargetOf } from "./workspace-search.js";

describe("fileTargetOf — the file/pattern resolution the tool performs per hit", () => {
    it("resolves a file entry to its stamped metadata path", () => {
        expect(fileTargetOf("/a1/runs/r1/s1/output/x.csv", { type: "output", path: "runs/r1/s1/output/x.csv" })).toBe("runs/r1/s1/output/x.csv");
        expect(fileTargetOf("/a1/data/inputs/vcf/SUBJ_0001.vcf.gz", { type: "input", path: "data/inputs/vcf/SUBJ_0001.vcf.gz" })).toBe("data/inputs/vcf/SUBJ_0001.vcf.gz");
        expect(fileTargetOf("/a1/runs/r1/synthesis.json", { type: "synthesis", path: "runs/r1/synthesis.json" })).toBe("runs/r1/synthesis.json");
    });

    it("derives the path from the id on rows older than the stamp", () => {
        expect(fileTargetOf("/a1/runs/r1/s1/output/x.csv", { type: "output" })).toBe("runs/r1/s1/output/x.csv");
        expect(fileTargetOf("/a1/data/inputs/meta/sheet_1.csv", { type: "input", format: "csv" })).toBe("data/inputs/meta/sheet_1.csv");
        expect(fileTargetOf("/a1/runs/r1/synthesis.json", { type: "synthesis", runId: "r1" })).toBe("runs/r1/synthesis.json");
        expect(fileTargetOf("/a1/data/x.csv", null)).toBe("data/x.csv");
    });

    it("resolves every pattern entry to no path, path-shaped id notwithstanding", () => {
        expect(fileTargetOf("/a1/group/per-subject-calls", { type: "input-group", group: "per-subject-calls" })).toBeUndefined();
        expect(fileTargetOf("/a1/dimension/subject", { type: "input-dimension", dimension: "subject" })).toBeUndefined();
        expect(fileTargetOf("/a1/kind/variant-calls", { type: "input-kind", kind: "variant-calls" })).toBeUndefined();
        expect(fileTargetOf("/a1/entity/SUBJ_0001", { type: "input", entity: "SUBJ_0001", axis: "subject" })).toBeUndefined();
    });
});
