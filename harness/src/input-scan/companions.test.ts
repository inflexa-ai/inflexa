import { describe, expect, it } from "bun:test";

import { assessCompleteness, attachCompanions } from "./companions.js";
import type { MemberFile } from "./set-types.js";
import { basenameOf } from "./tokens.js";
import type { ScannedFile } from "./types.js";

function file(path: string, size = 1024): ScannedFile {
    const base = basenameOf(path);
    const dot = base.indexOf(".");
    const extensions = dot <= 0 ? [] : base.slice(dot + 1).split(".");
    return { path, size, extensions, format: extensions[0] ?? "unknown" };
}

function member(path: string, companionPaths: readonly string[] = []): MemberFile {
    return {
        path,
        name: basenameOf(path),
        size: 1024,
        format: "unknown",
        companions: companionPaths.map((companionPath) => ({
            path: companionPath,
            suffix: companionPath.slice(companionPath.lastIndexOf(".")),
            size: 8,
        })),
    };
}

describe("attachCompanions", () => {
    it("folds an index into the file it serves", () => {
        const members = attachCompanions([file("inputs/spec_01.vcf.gz"), file("inputs/spec_01.vcf.gz.tbi", 16)]);

        expect(members).toHaveLength(1);
        expect(members[0]!.path).toBe("inputs/spec_01.vcf.gz");
        expect(members[0]!.companions).toEqual([{ path: "inputs/spec_01.vcf.gz.tbi", suffix: ".tbi", size: 16 }]);
    });

    it("attaches a companion that replaces the extension rather than extending it", () => {
        const members = attachCompanions([file("inputs/align_01.bam"), file("inputs/align_01.bai", 16)]);

        expect(members).toHaveLength(1);
        expect(members[0]!.companions.map((companion) => companion.suffix)).toEqual([".bai"]);
    });

    it("follows a chain to the file that is data", () => {
        const members = attachCompanions([file("inputs/spec_01.vcf.gz"), file("inputs/spec_01.vcf.gz.tbi"), file("inputs/spec_01.vcf.gz.tbi.md5")]);

        expect(members).toHaveLength(1);
        expect(members[0]!.companions.map((companion) => companion.suffix).sort()).toEqual([".md5", ".tbi"]);
    });

    it("leaves a companion whose data file is absent as a member of its own", () => {
        const members = attachCompanions([file("inputs/orphan.vcf.gz.tbi"), file("inputs/panel.csv")]);

        expect(members.map((m) => m.path).sort()).toEqual(["inputs/orphan.vcf.gz.tbi", "inputs/panel.csv"]);
        expect(members.every((m) => m.companions.length === 0)).toBe(true);
    });

    it("counts a data file and its companions as one member", () => {
        const files = [
            ...["01", "02", "03"].flatMap((n) => [file(`inputs/spec_${n}.vcf.gz`), file(`inputs/spec_${n}.vcf.gz.tbi`), file(`inputs/spec_${n}.vcf.gz.md5`)]),
        ];

        const members = attachCompanions(files);

        expect(members).toHaveLength(3);
        expect(members.every((m) => m.companions.length === 2)).toBe(true);
    });
});

describe("assessCompleteness", () => {
    it("names the member missing a companion the rest of the set carries", () => {
        const members = [
            member("inputs/spec_01.vcf.gz", ["inputs/spec_01.vcf.gz.tbi"]),
            member("inputs/spec_02.vcf.gz", ["inputs/spec_02.vcf.gz.tbi"]),
            member("inputs/spec_03.vcf.gz", ["inputs/spec_03.vcf.gz.tbi"]),
            member("inputs/spec_04.vcf.gz"),
        ];

        const { members: assessed, completeness } = assessCompleteness(members);

        expect(completeness.expectedCompanions).toEqual([".tbi"]);
        expect(completeness.completeMembers).toBe(3);
        expect(completeness.incompleteMembers).toBe(1);
        expect(completeness.incompleteSample).toEqual([{ path: "inputs/spec_04.vcf.gz", missingCompanions: [".tbi"] }]);
        expect(assessed[3]!.missingCompanions).toEqual([".tbi"]);
    });

    it("expects nothing from a companion only a minority carries", () => {
        const members = [
            member("inputs/spec_01.vcf.gz", ["inputs/spec_01.vcf.gz.md5"]),
            member("inputs/spec_02.vcf.gz"),
            member("inputs/spec_03.vcf.gz"),
            member("inputs/spec_04.vcf.gz"),
        ];

        const { completeness } = assessCompleteness(members);

        expect(completeness.expectedCompanions).toEqual([]);
        expect(completeness.incompleteMembers).toBe(0);
    });

    it("bounds the sample of incomplete members", () => {
        const members = [
            ...Array.from({ length: 20 }, (_, i) => member(`inputs/spec_a${i}.vcf.gz`, [`inputs/spec_a${i}.vcf.gz.tbi`])),
            ...Array.from({ length: 19 }, (_, i) => member(`inputs/spec_b${i}.vcf.gz`)),
        ];

        const { completeness } = assessCompleteness(members);

        expect(completeness.incompleteMembers).toBe(19);
        expect(completeness.incompleteSample.length).toBeLessThanOrEqual(10);
    });
});
