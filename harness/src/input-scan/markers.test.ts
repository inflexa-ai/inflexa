import { describe, expect, it } from "bun:test";

import { applyMarkers } from "./markers.js";
import type { MemberFile } from "./set-types.js";
import { basenameOf } from "./tokens.js";

function member(path: string): MemberFile {
    return { path, name: basenameOf(path), size: 1024, format: "unknown", companions: [] };
}

describe("applyMarkers", () => {
    it("claims the directory holding a matrix triplet", () => {
        const files = [
            member("data/inputs/counts/matrix.mtx.gz"),
            member("data/inputs/counts/barcodes.tsv.gz"),
            member("data/inputs/counts/features.tsv.gz"),
            member("data/inputs/panel.csv"),
        ];

        const { units, unclaimed } = applyMarkers(files);

        expect(units).toHaveLength(1);
        expect(units[0]!.label).toBe("feature-barcode-matrix");
        expect(units[0]!.root).toBe("data/inputs/counts");
        expect(units[0]!.members).toHaveLength(3);
        expect(unclaimed.map((f) => f.path)).toEqual(["data/inputs/panel.csv"]);
    });

    it("leaves an incomplete triplet to inference", () => {
        const files = [member("data/inputs/counts/matrix.mtx.gz"), member("data/inputs/counts/barcodes.tsv.gz")];

        const { units, unclaimed } = applyMarkers(files);

        expect(units).toHaveLength(0);
        expect(unclaimed).toHaveLength(2);
    });

    it("claims a whole subtree from a study manifest", () => {
        const files = [
            member("data/inputs/study/meta_study.txt"),
            member("data/inputs/study/meta_clinical.txt"),
            member("data/inputs/study/case_lists/cases_all.txt"),
            member("data/inputs/elsewhere/panel.csv"),
        ];

        const { units, unclaimed } = applyMarkers(files);

        expect(units).toHaveLength(1);
        expect(units[0]!.label).toBe("study-manifest");
        expect(units[0]!.members).toHaveLength(3);
        expect(unclaimed.map((f) => f.path)).toEqual(["data/inputs/elsewhere/panel.csv"]);
    });

    it("does not let a bare descriptor claim a tree it may not describe", () => {
        const files = [member("data/inputs/dataset_description.json"), member("data/inputs/panel.csv"), member("data/inputs/notes.md")];

        const { units, unclaimed } = applyMarkers(files);

        expect(units).toHaveLength(0);
        expect(unclaimed).toHaveLength(3);
    });

    it("claims the subtree once a corroborating sibling is present", () => {
        const files = [
            member("data/inputs/collection/dataset_description.json"),
            member("data/inputs/collection/sub-01/scan.nii.gz"),
            member("data/inputs/collection/sub-02/scan.nii.gz"),
        ];

        const { units, unclaimed } = applyMarkers(files);

        expect(units).toHaveLength(1);
        expect(units[0]!.label).toBe("dataset-descriptor");
        expect(unclaimed).toHaveLength(0);
    });

    it("gives an outer claim precedence over one nested inside it", () => {
        const files = [
            member("data/inputs/study/meta_study.txt"),
            member("data/inputs/study/nested/dataset_description.json"),
            member("data/inputs/study/nested/sub-01/scan.nii.gz"),
        ];

        const { units } = applyMarkers(files);

        expect(units).toHaveLength(1);
        expect(units[0]!.label).toBe("study-manifest");
        expect(units[0]!.members).toHaveLength(3);
    });
});
