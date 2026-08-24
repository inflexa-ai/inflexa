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
import type { GroupAnnotation, MenuOperation, ProfileDimension, ProfileSubmission } from "../schemas/data-profile-schemas.js";
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

function submission(operations: MenuOperation[], dimensions?: ProfileDimension[]): ProfileSubmission {
    return { operations, ...(dimensions ? { dimensions } : {}), analysisSummary: "A synthetic tree.", domain: "genomics", organism: null };
}

/** What a fixture's author names their operations and dimensions against: the fresh scan's own ids. */
interface Authoring {
    readonly setId: (fragment: string) => string;
    readonly slotId: (fragment: string, index?: number) => string;
}

interface ProfileFixture {
    readonly operations: MenuOperation[];
    readonly dimensions?: ProfileDimension[];
    /** Some fixtures leave files unclaimed on purpose — that residue is what a replay must re-sweep. */
    readonly residue?: boolean;
}

/**
 * Profile a tree the way the workflow does, and persist the result the way it does —
 * so a test's "prior profile" is a real resolution, not a hand-written recipe.
 */
function profile(files: ScannedFile[], build: (authoring: Authoring) => ProfileFixture): DataProfileResult {
    const detected = detectSets(files);
    const menu = buildSetMenu(detected);
    const set = (fragment: string) => menu.sets.find((candidate) => candidate.pathTemplate.includes(fragment))!;
    const fixture = build({ setId: (fragment) => set(fragment).id, slotId: (fragment, index = 0) => set(fragment).slots[index]!.id });
    const resolution = resolveProfileSubmission(submission(fixture.operations, fixture.dimensions), detected, menu);
    expect(resolution.errors).toEqual([]);
    if (!fixture.residue) expect(resolution.unclaimed).toEqual([]);
    return {
        summary: "A synthetic tree.",
        groups: resolution.groups.map(({ memberPaths, ...group }) => {
            void memberPaths;
            return group;
        }),
        dimensions: [...resolution.dimensions],
        partition: resolution.partition,
        recipe: [...resolution.recipe],
        profiledAt: "2020-01-01T00:00:00.000Z",
        domain: "genomics",
        organism: null,
    };
}

const useEverything = ({ setId }: Authoring): ProfileFixture => ({
    operations: [
        { op: "use", setId: setId("calls"), group: annotation("per-subject calls") },
        { op: "group", paths: ["data/inputs/meta/samplesheet.csv"], group: annotation("sample sheet", { role: "metadata", category: "sample-annotation" }) },
        { op: "group", paths: ["data/inputs/README.md"], group: annotation("readme", { role: "documentation", category: "document" }) },
    ],
});

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
        expect(briefing).toContain("2 kept files are NEW to the tree");
        expect(briefing).toContain("REPAIR ROUND OVER THE DELTA");
    });
});

describe("a split absorbs its named values and hands back the ones nobody judged", () => {
    const prior = profile(tree(3), (authoring) => ({
        operations: [
            {
                op: "split",
                setId: authoring.setId("calls"),
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
            ...useEverything(authoring).operations.slice(1),
        ],
    }));

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

describe("a dimension's slot binding survives a set-order flip", () => {
    /** Two sets whose relative size decides which one the scan calls `set-1`. */
    function twoSets(calls: number, aligns: number): ScannedFile[] {
        const files: ScannedFile[] = [];
        for (let i = 1; i <= calls; i++) files.push(file(`data/inputs/calls/${id(i)}.vcf`, "vcf", ["vcf"]));
        for (let i = 1; i <= aligns; i++) files.push(file(`data/inputs/align/${id(i)}.bam`, "bam", ["bam"]));
        return files;
    }

    const prior = profile(twoSets(3, 6), ({ setId, slotId }) => ({
        operations: [
            { op: "use", setId: setId("calls"), group: annotation("per-subject calls") },
            { op: "use", setId: setId("align"), group: annotation("per-subject alignments", { category: "alignment" }) },
        ],
        dimensions: [{ label: "subject", category: "subject", observations: [{ kind: "slot", setId: setId("calls"), slotId: slotId("calls") }] }],
    }));

    // The calls set overtakes the alignment set, so the slot ids the profile was written
    // against now name the other set's slot.
    const flipped = detectSets(twoSets(9, 6));
    const outcome = absorbRecipe(prior, flipped, buildSetMenu(flipped));

    it("was written against a slot id that now names a different set's slot", () => {
        const priorObservation = prior.dimensions![0]!.observations[0]!;
        if (priorObservation.kind !== "slot") throw new Error("expected a slot observation");
        expect(priorObservation.slotId).toBe("set-2.slot-1");
        expect(priorObservation.cardinality).toBe(3);
        expect(flipped.sets.find((set) => set.id === "set-2")!.pathTemplate).toContain("/align/");
    });

    it("re-binds to the same TEMPLATE slot and recomputes its cardinality", () => {
        if (outcome.kind !== "full") throw new Error("expected a full absorb");
        const observation = outcome.resolution.dimensions[0]!.observations[0]!;
        if (observation.kind !== "slot") throw new Error("expected a slot observation");

        expect(observation.binding!.template).toContain("/calls/");
        expect(observation.slotId).toBe("set-1.slot-1");
        expect(observation.cardinality).toBe(9);
        expect(observation.groupIds).toEqual(["per-subject-calls"]);
    });

    it("strands when the bound template is gone rather than re-binding to whatever is there", () => {
        const reshaped = detectSets([file("data/inputs/matrix/counts.tsv", "tsv", ["tsv"]), file("data/inputs/matrix/features.tsv", "tsv", ["tsv"])]);
        expect(absorbRecipe(prior, reshaped, buildSetMenu(reshaped)).kind).toBe("stranded");
    });
});

describe("a recipe step that resolves to no group strands", () => {
    it("strands when the last file of an explicitly grouped set is deleted", () => {
        const prior = profile(tree(3), useEverything);
        const withoutReadme = tree(3).filter((candidate) => !candidate.path.endsWith("README.md"));
        const detected = detectSets(withoutReadme);
        const outcome = absorbRecipe(prior, detected, buildSetMenu(detected));

        expect(outcome.kind).toBe("stranded");
        if (outcome.kind !== "stranded") return;
        expect(outcome.reason).toContain("readme");
    });
});

describe("the residue a profile already swept is not delta", () => {
    /** A profile that deliberately leaves the README unclaimed, so the sweep has something in it. */
    const prior = profile(tree(3), ({ setId }) => ({
        residue: true,
        operations: [
            { op: "use", setId: setId("calls"), group: annotation("per-subject calls") },
            {
                op: "group",
                paths: ["data/inputs/meta/samplesheet.csv"],
                group: annotation("sample sheet", { role: "metadata", category: "sample-annotation" }),
            },
        ],
    }));

    it("carries the swept paths in the recipe", () => {
        expect(prior.recipe!.find((step) => step.op === "unclassified")!.paths).toEqual(["data/inputs/README.md"]);
    });

    it("absorbs a byte-identical tree in full, with no model", () => {
        const detected = detectSets(tree(3));
        const outcome = absorbRecipe(prior, detected, buildSetMenu(detected));

        expect(outcome.kind).toBe("full");
        if (outcome.kind !== "full") return;
        expect(outcome.resolution.groups.find((group) => group.unclassified)!.memberPaths).toEqual(["data/inputs/README.md"]);
        expect(outcome.resolution.partition.keptFiles).toBe(detected.keptFileCount);
    });

    it("re-sweeps the residue that remains and drops the part of it that was deleted", () => {
        const grown = [...tree(5), file("data/inputs/NOTICE.txt", "text", ["txt"])];
        const detected = detectSets(grown);
        const outcome = absorbRecipe(prior, detected, buildSetMenu(detected));

        expect(outcome.kind).toBe("partial");
        if (outcome.kind !== "partial") return;
        // Only the file that is new to the tree is delta; the README sweeps as it did before.
        expect(outcome.delta).toEqual(["data/inputs/NOTICE.txt"]);
        expect([...outcome.resolution.unclaimed].sort()).toEqual(["data/inputs/NOTICE.txt", "data/inputs/README.md"]);
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
