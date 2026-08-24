import { describe, expect, it } from "bun:test";

import type { ContextFile } from "./templates.js";
import { catchAll, describeGroup, describeSlot, mineContext, slotToken } from "./templates.js";
import { basenameOf } from "./tokens.js";

function contextFile(path: string, options: { format?: string; wrapper?: string; varValues?: readonly string[] } = {}): ContextFile {
    return {
        path,
        name: basenameOf(path),
        size: 1024,
        format: options.format ?? "unknown",
        ...(options.wrapper ? { wrapper: options.wrapper } : {}),
        companions: [],
        varValues: options.varValues ?? [],
    };
}

function templateOf(group: Parameters<typeof describeGroup>[0]): string {
    const { slots, segments } = describeGroup(group);
    return segments.map((segment) => (segment.kind === "literal" ? segment.text : slotToken(slots[segment.slot]!))).join("");
}

describe("mineContext", () => {
    it("makes each categorical token of a suffix chain its own slot", () => {
        const files: ContextFile[] = [];
        for (const specimen of ["01", "02", "03"]) {
            for (const cls of ["somatic", "germline"]) {
                for (const caller of ["alpha", "beta"]) {
                    files.push(contextFile(`spec-${specimen}__calls.${cls}.${caller}.vcf.gz`, { format: "vcf", wrapper: "bgzip" }));
                }
            }
        }

        const { sets, residue } = mineContext(files);

        expect(sets).toHaveLength(1);
        expect(residue).toHaveLength(0);
        const { slots } = describeGroup(sets[0]!);
        expect(slots.map((slot) => slot.distinctValues)).toEqual([3, 2, 2]);
        expect(slots[1]!.sampleValues).toEqual(["germline", "somatic"]);
        expect(slots[2]!.sampleValues).toEqual(["alpha", "beta"]);
        expect(templateOf(sets[0]!)).toBe("spec-<digits:2>__calls.<word>.<word>.vcf.gz");
    });

    it("keeps long machine-issued stems in one set instead of one set each", () => {
        const ids = ["k7Qm2xVb9Lr4Tz8Wp3Ny", "Zx4Np8Ct2Mv6Bq1Rs5Hd", "Jw9Fd3Kp7Yn2Vc8Ml4Ta", "Rb6Hs1Xq5Dg9Pw3Zk7Uf"];
        const files = ids.map((id) => contextFile(`upload_${id}.csv`, { format: "csv" }));

        const { sets } = mineContext(files);

        expect(sets).toHaveLength(1);
        expect(sets[0]!.items).toHaveLength(4);
        const { slots } = describeGroup(sets[0]!);
        expect(slots).toHaveLength(1);
        expect(slots[0]!.tokenClass).toBe("opaque-id");
        expect(slots[0]!.distinctValues).toBe(4);
    });

    it("reads a date position as a date", () => {
        const files = ["2026-08-24", "2026-09-01", "2026-10-15", "2026-11-02"].map((day) => contextFile(`intake_${day}.tsv`, { format: "tsv" }));

        const { sets } = mineContext(files);

        expect(sets).toHaveLength(1);
        const { slots } = describeGroup(sets[0]!);
        expect(slots).toHaveLength(1);
        expect(slots[0]!.tokenClass).toBe("date");
        expect(templateOf(sets[0]!)).toBe("intake_<date>.tsv");
    });

    it("carries extension disagreement as a census rather than splitting the set", () => {
        const files = [
            ...["001", "002", "003"].map((n) => contextFile(`panel_${n}.vcf`, { format: "vcf" })),
            ...["004", "005", "006"].map((n) => contextFile(`panel_${n}.vcf.gz`, { format: "vcf", wrapper: "bgzip" })),
        ];

        const { sets } = mineContext(files);

        expect(sets).toHaveLength(1);
        expect(sets[0]!.items).toHaveLength(6);
        expect([...sets[0]!.suffixes.entries()].sort()).toEqual([
            ["vcf", 3],
            ["vcf.gz", 3],
        ]);
        expect(templateOf(sets[0]!)).toBe("panel_<digits:3>.{vcf,vcf.gz}");
    });

    it("collapses a family of one-off names into one set rather than one template each", () => {
        const files = ["adverse_events", "dose_levels", "visit_windows", "lab_panels", "site_roster"].map((name) =>
            contextFile(`${name}.csv`, { format: "csv" }),
        );

        const { sets, residue } = mineContext(files);

        expect(residue).toHaveLength(0);
        expect(sets).toHaveLength(1);
        expect(sets[0]!.kind).toBe("family");
        expect(sets[0]!.items).toHaveLength(5);
    });

    it("claims residual singletons that share a literal prefix", () => {
        const files = ["qc_daily", "qc_run12_summary", "qc_batch_07_notes", "qc_v2_final_check"].map((name) => contextFile(`${name}.log`, { format: "text" }));

        const { sets, residue } = mineContext(files);

        expect(residue).toHaveLength(0);
        expect(sets).toHaveLength(1);
        expect(sets[0]!.kind).toBe("prefix");
        expect(templateOf(sets[0]!)).toStartWith("qc_<");
    });

    it("leaves genuinely unrelated names alone", () => {
        const files = [
            contextFile("protocol.pdf", { format: "pdf" }),
            contextFile("notes.md", { format: "markdown" }),
            contextFile("cohort_roster.xlsx", { format: "excel" }),
        ];

        const { sets, residue } = mineContext(files);

        expect(sets).toHaveLength(0);
        expect(residue).toHaveLength(3);
    });
});

describe("catchAll", () => {
    it("folds a cross-directory residue into one set", () => {
        const files = [contextFile("a/notes.md", { varValues: ["a"] }), contextFile("b/summary.txt", { varValues: ["b"] })];
        const { residue } = mineContext(files);

        const caught = catchAll(residue, true);

        expect(caught.sets).toHaveLength(1);
        expect(caught.sets[0]!.items).toHaveLength(2);
        expect(caught.rest).toHaveLength(0);
    });

    it("claims nothing where the directory does not repeat", () => {
        const files = [contextFile("notes.md"), contextFile("summary.txt")];
        const { residue } = mineContext(files);

        const caught = catchAll(residue, false);

        expect(caught.sets).toHaveLength(0);
        expect(caught.rest).toHaveLength(2);
    });
});

describe("describeSlot", () => {
    it("reports the cardinality in full and the values in a bounded sample", () => {
        const values = Array.from({ length: 200 }, (_, i) => String(i + 1).padStart(4, "0"));

        const slot = describeSlot(values, "name", 2);

        expect(slot.distinctValues).toBe(200);
        expect(slot.sampleValues.length).toBeLessThanOrEqual(12);
        expect(slot.values).toHaveLength(200);
        expect(slot.tokenClass).toBe("digits-fixed");
        expect(slot.width).toBe(4);
    });

    it("recovers a literal affix instead of reporting it as part of the value", () => {
        const slot = describeSlot(["specimenAA01x", "specimenBB02x", "specimenCC03x"], "name", 0);

        expect(slot.prefix).toBe("specimen");
        expect(slot.sampleValues).toEqual(["AA01x", "BB02x", "CC03x"]);
    });

    it("never splits an all-digit value into an affix and a remainder", () => {
        const slot = describeSlot(["20260824", "20260901"], "name", 0);

        expect(slot.prefix).toBeUndefined();
        expect(slot.tokenClass).toBe("date");
    });
});
