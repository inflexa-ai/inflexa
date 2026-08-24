/**
 * Absorption is a replay, so these assert what the replay produces: which files each
 * carried-forward group holds after the tree moved, what the delta is when it does not
 * cover everything, and that a recipe whose templates are gone strands rather than
 * absorbing the half that still resolves. Every tree here is authored in this file.
 */

import { describe, expect, it } from "bun:test";

import type { DataProfileResult } from "../contracts/data-profile.js";
import { detectSets } from "../input-scan/detect-sets.js";
import { buildSetMenu } from "../input-scan/menu.js";
import type { ScannedFile } from "../input-scan/types.js";
import type { GroupAnnotation, MenuOperation, ProfileSubmission } from "../schemas/data-profile-schemas.js";
import { absorbRecipe, renderAbsorbDelta } from "./data-profile-absorb.js";
import { resolveProfileSubmission } from "./data-profile-resolve.js";

function file(path: string, format: string, extensions: string[] = []): ScannedFile {
    return { path, size: 100, extensions, format };
}

const id = (n: number) => `S${String(n).padStart(3, "0")}`;

/** A per-subject calls set with an origin slot, a sample sheet, and a README. */
function tree(subjects: number): ScannedFile[] {
    const files: ScannedFile[] = [];
    for (let i = 1; i <= subjects; i++) {
        for (const origin of ["somatic", "germline"]) files.push(file(`data/inputs/calls/${id(i)}.${origin}.vcf`, "vcf", ["vcf"]));
    }
    files.push(file("data/inputs/meta/samplesheet.csv", "csv", ["csv"]));
    files.push(file("data/inputs/README.md", "markdown", ["md"]));
    return files;
}

function annotation(name: string, over: Partial<GroupAnnotation> = {}): GroupAnnotation {
    return { name, memberRepresents: `one ${name} member`, description: `What ${name} holds.`, role: "data", category: "variant-calls", ...over };
}

function submission(operations: MenuOperation[]): ProfileSubmission {
    return { operations, analysisSummary: "A synthetic tree.", domain: "genomics", organism: null };
}

/**
 * Profile a tree the way the workflow does, and persist the result the way it does —
 * so a test's "prior profile" is a real resolution, not a hand-written recipe.
 */
function profile(files: ScannedFile[], build: (setId: (fragment: string) => string) => MenuOperation[]): DataProfileResult {
    const detected = detectSets(files);
    const menu = buildSetMenu(detected);
    const setId = (fragment: string) => menu.sets.find((set) => set.pathTemplate.includes(fragment))!.id;
    const resolution = resolveProfileSubmission(submission(build(setId)), detected, menu);
    expect(resolution.errors).toEqual([]);
    expect(resolution.unclaimed).toEqual([]);
    return {
        summary: "A synthetic tree.",
        groups: resolution.groups.map(({ memberPaths, ...group }) => {
            void memberPaths;
            return group;
        }),
        partition: resolution.partition,
        recipe: [...resolution.recipe],
        profiledAt: "2020-01-01T00:00:00.000Z",
        domain: "genomics",
        organism: null,
    };
}

const useEverything = (setId: (fragment: string) => string): MenuOperation[] => [
    { op: "use", setId: setId("calls"), group: annotation("per-subject calls") },
    { op: "group", paths: ["data/inputs/meta/samplesheet.csv"], group: annotation("sample sheet", { role: "metadata", category: "sample-annotation" }) },
    { op: "group", paths: ["data/inputs/README.md"], group: annotation("readme", { role: "documentation", category: "document" }) },
];

describe("a recipe that covers the fresh tree absorbs in full", () => {
    const prior = profile(tree(4), useEverything);
    const detected = detectSets(tree(7));
    const outcome = absorbRecipe(prior, detected, buildSetMenu(detected));

    it("reports a full absorb", () => {
        expect(outcome.kind).toBe("full");
    });

    it("re-derives the counts over the files that arrived", () => {
        if (outcome.kind !== "full") throw new Error("expected a full absorb");
        const calls = outcome.resolution.groups.find((group) => group.name === "per-subject calls")!;
        expect(calls.count).toBe(14);
        expect(outcome.resolution.partition.keptFiles).toBe(16);
        expect(outcome.resolution.partition.unclassifiedFiles).toBe(0);
    });

    it("keeps the group ids the prior profile carried, so dimension bindings still point somewhere", () => {
        if (outcome.kind !== "full") throw new Error("expected a full absorb");
        expect(outcome.resolution.groups.map((group) => group.id).sort()).toEqual(prior.groups!.map((group) => group.id).sort());
    });

    it("re-emits a template-keyed recipe, so the next drift absorbs too", () => {
        if (outcome.kind !== "full") throw new Error("expected a full absorb");
        expect(outcome.resolution.recipe.map((step) => step.op)).toEqual(prior.recipe!.map((step) => step.op));
        const nextTree = detectSets(tree(9));
        expect(
            absorbRecipe({ ...prior, groups: outcome.resolution.groups, recipe: [...outcome.resolution.recipe] }, nextTree, buildSetMenu(nextTree)).kind,
        ).toBe("full");
    });
});

describe("structurally new files leave a delta for the agent", () => {
    const prior = profile(tree(3), useEverything);
    const grown = [...tree(3), file("data/inputs/imaging/scan-001.dcm", "dicom", ["dcm"]), file("data/inputs/imaging/scan-002.dcm", "dicom", ["dcm"])];
    const detected = detectSets(grown);
    const outcome = absorbRecipe(prior, detected, buildSetMenu(detected));

    it("reports a partial absorb naming only the unresolved files", () => {
        expect(outcome.kind).toBe("partial");
        if (outcome.kind !== "partial") return;
        expect([...outcome.delta].sort()).toEqual(["data/inputs/imaging/scan-001.dcm", "data/inputs/imaging/scan-002.dcm"]);
    });

    it("carries the resolution forward rather than re-authoring it", () => {
        if (outcome.kind !== "partial") throw new Error("expected a partial absorb");
        expect(outcome.operations.map((operation) => operation.op)).toEqual(["use", "group", "group"]);
        const calls = outcome.resolution.groups.find((group) => group.name === "per-subject calls")!;
        expect(calls.count).toBe(6);
    });

    it("briefs the agent with the carried operations and the delta paths", () => {
        if (outcome.kind !== "partial") throw new Error("expected a partial absorb");
        const briefing = renderAbsorbDelta(outcome);
        expect(briefing).toContain("per-subject calls");
        expect(briefing).toContain("one per-subject calls member");
        expect(briefing).toContain("data/inputs/imaging/scan-001.dcm");
        expect(briefing).toContain("2 kept files are NOT accounted for");
        expect(briefing).toContain("REPAIR ROUND OVER THE DELTA");
    });
});

describe("a split absorbs its named values and hands back the ones nobody judged", () => {
    const prior = profile(tree(3), (setId) => [
        {
            op: "split",
            setId: setId("calls"),
            by: {
                kind: "values",
                slotId: detectSets(tree(3))
                    .sets.find((set) => set.pathTemplate.includes("calls"))!
                    .slots.find((slot) => slot.tokenClass === "word")!.id,
                groups: [
                    { values: ["somatic"], group: annotation("somatic calls") },
                    { values: ["germline"], group: annotation("germline calls") },
                ],
            },
            reason: "callers consume one origin at a time",
        },
        ...useEverything(setId).slice(1),
    ]);

    it("absorbs new members of a value the mapping already names", () => {
        const detected = detectSets(tree(5));
        const outcome = absorbRecipe(prior, detected, buildSetMenu(detected));
        expect(outcome.kind).toBe("full");
        if (outcome.kind !== "full") return;
        expect(outcome.resolution.groups.find((group) => group.name === "somatic calls")!.count).toBe(5);
    });

    it("hands back members taking a value the mapping never named", () => {
        const withRna = [...tree(3), file(`data/inputs/calls/${id(1)}.rnaedit.vcf`, "vcf", ["vcf"])];
        const detected = detectSets(withRna);
        const outcome = absorbRecipe(prior, detected, buildSetMenu(detected));
        expect(outcome.kind).toBe("partial");
        if (outcome.kind !== "partial") return;
        expect(outcome.delta).toEqual([`data/inputs/calls/${id(1)}.rnaedit.vcf`]);
    });
});

describe("a stranded recipe falls back to a full re-profile", () => {
    it("strands when a template it names is gone", () => {
        const prior = profile(tree(3), useEverything);
        const reshaped = [file("data/inputs/matrix/counts.tsv", "tsv", ["tsv"]), file("data/inputs/matrix/features.tsv", "tsv", ["tsv"])];
        const detected = detectSets(reshaped);
        const outcome = absorbRecipe(prior, detected, buildSetMenu(detected));

        expect(outcome.kind).toBe("stranded");
        if (outcome.kind !== "stranded") return;
        expect(outcome.reason).toContain("template");
    });

    it("strands rather than absorbing the half that still resolves", () => {
        const prior = profile(tree(3), useEverything);
        const half = [...tree(3).filter((f) => !f.path.includes("/calls/")), file("data/inputs/matrix/counts.tsv", "tsv", ["tsv"])];
        const detected = detectSets(half);
        const outcome = absorbRecipe(prior, detected, buildSetMenu(detected));

        expect(outcome.kind).toBe("stranded");
    });

    it("strands when the recipe names a group the profile no longer carries", () => {
        const prior = profile(tree(3), useEverything);
        const detected = detectSets(tree(3));
        const outcome = absorbRecipe({ ...prior, groups: prior.groups!.slice(1) }, detected, buildSetMenu(detected));

        expect(outcome.kind).toBe("stranded");
    });
});

describe("nothing to replay", () => {
    const detected = detectSets(tree(3));
    const menu = buildSetMenu(detected);

    it("reports none for a first profile", () => {
        expect(absorbRecipe(null, detected, menu).kind).toBe("none");
    });

    it("reports none for a snapshot written before recipes existed", () => {
        const prior = profile(tree(3), useEverything);
        expect(absorbRecipe({ ...prior, recipe: undefined }, detected, menu).kind).toBe("none");
    });
});
