/**
 * Resolution is where the agent's judgement becomes arithmetic, so these assert the
 * arithmetic: which members each operation claims, what the derived counts are, and that
 * the kept files partition. Nothing here asserts that a function was called.
 */

import { describe, expect, it } from "bun:test";

import { detectSets } from "../input-scan/detect-sets.js";
import { buildSetMenu } from "../input-scan/menu.js";
import type { DetectedSets } from "../input-scan/set-types.js";
import type { ScannedFile } from "../input-scan/types.js";
import { ProfileSubmissionSchema, type GroupAnnotation, type MenuOperation, type ProfileSubmission } from "../schemas/data-profile-schemas.js";
import { UNCLASSIFIED_GROUP_ID, formatResolutionErrors, resolveProfileSubmission } from "./data-profile-resolve.js";

function file(path: string, format: string, extensions: string[] = [], wrapper?: string): ScannedFile {
    return { path, size: 100, extensions, format, ...(wrapper ? { wrapper } : {}) };
}

/**
 * Deterministic PRNG (mulberry32), the same one the property suite uses. A power-of-two
 * LCG's low bits cycle, so `next() % 2` would alternate and the "arbitrary" partition
 * below would only ever be one of them.
 */
function rng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const id = (n: number) => `S${String(n).padStart(3, "0")}`;

const SUBJECTS = 6;
const ALIGNED = 5;

/**
 * A synthetic tree: one calls set with a subject slot and an origin slot, one alignment
 * set sharing most subjects, two leftovers, one quarantined file.
 */
function tree(): ScannedFile[] {
    const files: ScannedFile[] = [];
    for (let i = 1; i <= SUBJECTS; i++) {
        for (const origin of ["somatic", "germline"]) {
            files.push(file(`data/inputs/calls/${id(i)}.${origin}.vcf.gz`, "vcf", ["vcf", "gz"], "bgzip"));
            files.push(file(`data/inputs/calls/${id(i)}.${origin}.vcf.gz.tbi`, "tabix-index", ["vcf", "gz", "tbi"]));
        }
        if (i <= ALIGNED) files.push(file(`data/inputs/align/${id(i)}.bam`, "bam", ["bam"]));
    }
    files.push(file("data/inputs/meta/samplesheet.csv", "csv", ["csv"]));
    files.push(file("data/inputs/README.md", "markdown", ["md"]));
    files.push(file("data/inputs/.DS_Store", "unknown"));
    return files;
}

const detected: DetectedSets = detectSets(tree());
const menu = buildSetMenu(detected);
const calls = detected.sets.find((set) => set.pathTemplate.includes("calls"))!;
const align = detected.sets.find((set) => set.pathTemplate.includes("align"))!;
const originSlot = calls.slots.find((slot) => slot.tokenClass === "word")!;
const subjectSlot = calls.slots.find((slot) => slot.tokenClass !== "word")!;
const alignSubjectSlot = align.slots[0]!;

function annotation(name: string, over: Partial<GroupAnnotation> = {}): GroupAnnotation {
    return {
        name,
        memberRepresents: `one ${name} member`,
        description: `What ${name} holds.`,
        role: "data",
        category: "variant-calls",
        ...over,
    };
}

function submission(operations: MenuOperation[], over: Partial<ProfileSubmission> = {}): ProfileSubmission {
    return {
        operations,
        analysisSummary: "A synthetic tree.",
        domain: "genomics",
        organism: null,
        ...over,
    };
}

/** Claim every kept file, so a test can vary one operation without tripping the sweep. */
function claimEverything(extra: MenuOperation[] = []): MenuOperation[] {
    return [
        { op: "use", setId: align.id, group: annotation("alignments", { category: "alignment" }) },
        { op: "group", paths: ["data/inputs/meta/samplesheet.csv", "data/inputs/README.md"], group: annotation("context", { category: "document" }) },
        ...extra,
    ];
}

describe("membership is computed per operation", () => {
    it("use takes every member of the set, and its counts come from the scan", () => {
        const resolution = resolveProfileSubmission(submission(claimEverything([{ op: "use", setId: calls.id, group: annotation("calls") }])), detected, menu);
        const group = resolution.groups.find((candidate) => candidate.name === "calls")!;

        expect(resolution.errors).toEqual([]);
        expect(group.count).toBe(calls.memberCount);
        expect(group.fileCount).toBe(calls.fileCount);
        expect(group.displayPattern).toBe(calls.pathTemplate);
        expect(group.memberPaths).toHaveLength(SUBJECTS * 2);
    });

    it("split by value mapping resolves one group per mapped value, membership computed from the mapping", () => {
        const resolution = resolveProfileSubmission(
            submission(
                claimEverything([
                    {
                        op: "split",
                        setId: calls.id,
                        by: {
                            kind: "values",
                            slotId: originSlot.id,
                            groups: [
                                { values: ["somatic"], group: annotation("somatic calls") },
                                { values: ["germline"], group: annotation("germline calls") },
                            ],
                        },
                        reason: "A downstream step consumes one origin or the other, never both.",
                    },
                ]),
            ),
            detected,
            menu,
        );

        const somatic = resolution.groups.find((group) => group.name === "somatic calls")!;
        const germline = resolution.groups.find((group) => group.name === "germline calls")!;
        expect(resolution.errors).toEqual([]);
        expect(somatic.count).toBe(SUBJECTS);
        expect(germline.count).toBe(SUBJECTS);
        expect(somatic.memberPaths.every((path) => path.includes("somatic"))).toBe(true);
        // The split narrows the slot: inside the group the origin no longer varies.
        expect(somatic.slots!.find((slot) => slot.id === originSlot.id)!.distinctValues).toBe(1);
        expect(somatic.slots!.find((slot) => slot.id === subjectSlot.id)!.distinctValues).toBe(SUBJECTS);
        expect(somatic.reason).toContain("downstream step");
    });

    it("split by slot resolves one group per distinct value", () => {
        const resolution = resolveProfileSubmission(
            submission(
                claimEverything([
                    {
                        op: "split",
                        setId: calls.id,
                        by: { kind: "slot", slotId: originSlot.id, group: annotation("calls") },
                        reason: "Somatic and germline are different substrates.",
                    },
                ]),
            ),
            detected,
            menu,
        );
        const names = resolution.groups.map((group) => group.name).filter((name) => name.startsWith("calls —"));
        expect(names.sort()).toEqual(["calls — germline", "calls — somatic"]);
        expect(resolution.errors).toEqual([]);
    });

    it("merge unions the named sets into one group whose pattern names both templates", () => {
        const resolution = resolveProfileSubmission(
            submission([
                { op: "merge", setIds: [calls.id, align.id], group: annotation("per-subject data"), reason: "One group under two naming conventions." },
                { op: "group", paths: ["data/inputs/meta/samplesheet.csv", "data/inputs/README.md"], group: annotation("context", { category: "document" }) },
            ]),
            detected,
            menu,
        );
        const merged = resolution.groups.find((group) => group.name === "per-subject data")!;
        expect(resolution.errors).toEqual([]);
        expect(merged.count).toBe(calls.memberCount + align.memberCount);
        expect(merged.displayPattern).toContain(calls.pathTemplate);
        expect(merged.displayPattern).toContain(align.pathTemplate);
    });

    it("group gathers explicit paths the scan left over", () => {
        const resolution = resolveProfileSubmission(submission(claimEverything([{ op: "use", setId: calls.id, group: annotation("calls") }])), detected, menu);
        const context = resolution.groups.find((group) => group.name === "context")!;
        expect(context.count).toBe(2);
        expect([...context.memberPaths].sort()).toEqual(["data/inputs/README.md", "data/inputs/meta/samplesheet.csv"]);
    });

    it("rejects a path no kept file sits at", () => {
        const resolution = resolveProfileSubmission(
            submission([{ op: "group", paths: ["data/inputs/nope.csv"], group: annotation("context", { category: "document" }) }]),
            detected,
            menu,
        );
        expect(resolution.errors.join(" ")).toContain("no kept file at");
    });

    it("rejects a slot value no member takes, naming what was observed", () => {
        const resolution = resolveProfileSubmission(
            submission([
                {
                    op: "split",
                    setId: calls.id,
                    by: {
                        kind: "values",
                        slotId: originSlot.id,
                        groups: [
                            { values: ["somatik"], group: annotation("a") },
                            { values: ["germline"], group: annotation("b") },
                        ],
                    },
                    reason: "Different substrates.",
                },
            ]),
            detected,
            menu,
        );
        expect(resolution.errors.join(" ")).toContain('no member takes the value "somatik"');
    });
});

describe("the partition", () => {
    it("makes overlapping operations an error naming both groups, not a precedence", () => {
        const resolution = resolveProfileSubmission(
            submission([
                { op: "use", setId: calls.id, group: annotation("calls") },
                { op: "merge", setIds: [calls.id, align.id], group: annotation("everything"), reason: "Overlapping on purpose." },
            ]),
            detected,
            menu,
        );
        expect(resolution.errors.some((error) => error.includes("claimed by both") && error.includes("calls") && error.includes("everything"))).toBe(true);
        expect(formatResolutionErrors(resolution)).toContain("Resubmit the WHOLE operation list");
    });

    it("sweeps unclaimed files into a visible unclassified group and reports them", () => {
        const resolution = resolveProfileSubmission(submission([{ op: "use", setId: calls.id, group: annotation("calls") }]), detected, menu);
        const unclassified = resolution.groups.find((group) => group.id === UNCLASSIFIED_GROUP_ID)!;

        expect(unclassified.unclassified).toBe(true);
        expect(resolution.unclaimed).toContain("data/inputs/README.md");
        expect(unclassified.count).toBe(resolution.unclaimed.length);
        expect(formatResolutionErrors(resolution)).toContain("claimed by no operation");
    });

    it("derives an accounting that sums, with quarantine reported apart from it", () => {
        const resolution = resolveProfileSubmission(submission(claimEverything([{ op: "use", setId: calls.id, group: annotation("calls") }])), detected, menu);
        const summed = resolution.groups.reduce((total, group) => total + group.fileCount, 0);

        expect(resolution.partition.keptFiles).toBe(summed);
        expect(resolution.partition.keptFiles).toBe(detected.keptFileCount);
        expect(resolution.partition.scannedFiles).toBe(detected.fileCount);
        expect(resolution.partition.quarantine.count).toBe(1);
        expect(resolution.partition.quarantine.reasons).toEqual([{ reason: "os-junk", count: 1 }]);
        expect(resolution.partition.unclassifiedFiles).toBe(0);
    });

    it("holds the invariant under arbitrary partitions of the leftovers", () => {
        const leftovers = detected.leftoverMembers.map((member) => member.path);
        const random = rng(7);

        for (let round = 0; round < 40; round++) {
            const buckets: string[][] = [[], []];
            for (const path of leftovers) buckets[Math.floor(random() * buckets.length)]!.push(path);

            const operations: MenuOperation[] = [
                { op: "use", setId: calls.id, group: annotation("calls") },
                { op: "use", setId: align.id, group: annotation("alignments", { category: "alignment" }) },
                ...buckets
                    .filter((paths) => paths.length > 0)
                    .map((paths, index): MenuOperation => ({ op: "group", paths, group: annotation(`bucket ${index}`, { category: "document" }) })),
            ];

            const resolution = resolveProfileSubmission(submission(operations), detected, menu);
            const claimed = resolution.groups.flatMap((group) => group.memberPaths);

            expect(resolution.errors).toEqual([]);
            expect(new Set(claimed).size).toBe(claimed.length);
            expect(claimed.length).toBe(detected.sets.reduce((total, set) => total + set.memberCount, 0) + leftovers.length);
            expect(resolution.partition.keptFiles).toBe(detected.keptFileCount);
        }
    });

    it("does not merge a repair into the submission it replaces", () => {
        const first = resolveProfileSubmission(submission([{ op: "use", setId: calls.id, group: annotation("calls") }]), detected, menu);
        expect(first.unclaimed.length).toBeGreaterThan(0);

        const repaired = resolveProfileSubmission(
            submission(claimEverything([{ op: "use", setId: calls.id, group: annotation("renamed calls") }])),
            detected,
            menu,
        );
        expect(repaired.groups.map((group) => group.name)).not.toContain("calls");
        expect(repaired.unclaimed).toEqual([]);
        expect(repaired.groups.some((group) => group.id === UNCLASSIFIED_GROUP_ID)).toBe(false);
    });

    it("keeps two groups of the same name distinguishable", () => {
        const resolution = resolveProfileSubmission(
            submission([
                { op: "use", setId: calls.id, group: annotation("data") },
                { op: "use", setId: align.id, group: annotation("data", { category: "alignment" }) },
                { op: "group", paths: ["data/inputs/meta/samplesheet.csv", "data/inputs/README.md"], group: annotation("data", { category: "document" }) },
            ]),
            detected,
            menu,
        );
        expect(new Set(resolution.groups.map((group) => group.id)).size).toBe(resolution.groups.length);
    });

    it("refuses an annotation for a member the group does not hold", () => {
        const resolution = resolveProfileSubmission(
            submission([
                {
                    op: "use",
                    setId: align.id,
                    group: annotation("alignments", {
                        category: "alignment",
                        memberAnnotations: [{ path: "data/inputs/README.md", note: "Not a member of this group." }],
                    }),
                },
            ]),
            detected,
            menu,
        );
        expect(resolution.errors.join(" ")).toContain("is not one of its members");
    });

    it("requires a free label behind an `other` category", () => {
        const resolution = resolveProfileSubmission(
            submission([{ op: "use", setId: align.id, group: annotation("mystery", { category: "other" }) }]),
            detected,
            menu,
        );
        expect(resolution.errors.join(" ")).toContain("needs a categoryLabel");
    });
});

describe("a contested file on the final round", () => {
    /** Two operations that both claim every member of the calls set. */
    const overlapping: MenuOperation[] = claimEverything([
        { op: "use", setId: calls.id, group: annotation("calls") },
        { op: "use", setId: calls.id, group: annotation("calls again") },
    ]);

    it("is still an error while a repair round remains", () => {
        const resolution = resolveProfileSubmission(submission(overlapping), detected, menu);

        expect(resolution.contested).toHaveLength(calls.memberCount);
        expect(resolution.errors.filter((error) => error.includes("claimed by both"))).toHaveLength(calls.memberCount);
    });

    it("is removed from every claimant and swept, never awarded to one", () => {
        const resolution = resolveProfileSubmission(submission(overlapping), detected, menu, { finalRound: true });
        const first = resolution.groups.find((group) => group.name === "calls")!;
        const second = resolution.groups.find((group) => group.name === "calls again")!;
        const unclassified = resolution.groups.find((group) => group.id === UNCLASSIFIED_GROUP_ID)!;

        expect(first.memberPaths).toEqual([]);
        expect(second.memberPaths).toEqual([]);
        expect([...unclassified.memberPaths].sort()).toEqual([...calls.members.map((member) => member.path)].sort());
        expect(resolution.errors.filter((error) => error.includes("claimed by both"))).toEqual([]);
    });

    it("is recorded in the accounting as a machine finding", () => {
        const resolution = resolveProfileSubmission(submission(overlapping), detected, menu, { finalRound: true });

        expect(resolution.partition.contested!.members).toBe(calls.memberCount);
        expect(resolution.partition.contested!.sample.length).toBeGreaterThan(0);
        expect(resolution.partition.contested!.sample.every((path) => path.includes("/calls/"))).toBe(true);
    });

    it("leaves the accounting summing, with no path counted twice", () => {
        for (const finalRound of [false, true]) {
            const resolution = resolveProfileSubmission(submission(overlapping), detected, menu, { finalRound });
            const claimed = resolution.groups.flatMap((group) => group.memberPaths);

            expect(new Set(claimed).size).toBe(claimed.length);
            expect(resolution.groups.reduce((total, group) => total + group.fileCount, 0)).toBe(detected.keptFileCount);
            expect(resolution.partition.keptFiles).toBe(detected.keptFileCount);
        }
    });
});

describe("an operation that claims the same members twice", () => {
    it("is refused by the schema when a merge repeats a set id", () => {
        const parsed = ProfileSubmissionSchema.safeParse(
            submission([{ op: "merge", setIds: [calls.id, calls.id], group: annotation("doubled"), reason: "Repeated on purpose." }]),
        );
        expect(parsed.success).toBe(false);
    });

    it("is refused by resolution too, and counts the members once", () => {
        const resolution = resolveProfileSubmission(
            submission(claimEverything([{ op: "merge", setIds: [calls.id, calls.id], group: annotation("doubled"), reason: "Repeated on purpose." }])),
            detected,
            menu,
        );
        expect(resolution.errors.join(" ")).toContain('set "' + calls.id + '" is named more than once');
        expect(resolution.groups.some((group) => group.name === "doubled")).toBe(false);
        expect(resolution.partition.keptFiles).toBe(detected.keptFileCount);
    });

    it("does not read a value repeated inside ONE mapped group as a cross-group overlap", () => {
        const resolution = resolveProfileSubmission(
            submission(
                claimEverything([
                    {
                        op: "split",
                        setId: calls.id,
                        by: {
                            kind: "values",
                            slotId: originSlot.id,
                            groups: [
                                { values: ["somatic", "somatic"], group: annotation("somatic calls") },
                                { values: ["germline"], group: annotation("germline calls") },
                            ],
                        },
                        reason: "Different substrates.",
                    },
                ]),
            ),
            detected,
            menu,
        );
        const somatic = resolution.groups.find((group) => group.name === "somatic calls")!;

        expect(resolution.errors).toEqual([]);
        expect(somatic.count).toBe(SUBJECTS);
        expect(resolution.recipe.find((step) => step.op === "split")!.valueMapping).toEqual([
            { groupId: "somatic-calls", values: ["somatic"] },
            { groupId: "germline-calls", values: ["germline"] },
        ]);
    });
});

describe("the swept residue is carried in the recipe", () => {
    it("records the paths it swept, so a replay can tell them from files new to the tree", () => {
        const resolution = resolveProfileSubmission(submission([{ op: "use", setId: calls.id, group: annotation("calls") }]), detected, menu);
        const sweep = resolution.recipe.find((step) => step.op === "unclassified")!;

        expect(sweep.groupIds).toEqual([UNCLASSIFIED_GROUP_ID]);
        expect([...sweep.paths!].sort()).toEqual([...resolution.unclaimed].sort());
        expect(sweep).not.toHaveProperty("pathsTruncated");
    });

    it("records no sweep step when every kept file is claimed", () => {
        const resolution = resolveProfileSubmission(submission(claimEverything([{ op: "use", setId: calls.id, group: annotation("calls") }])), detected, menu);
        expect(resolution.recipe.some((step) => step.op === "unclassified")).toBe(false);
    });
});

describe("dimensions", () => {
    const base = claimEverything([{ op: "use", setId: calls.id, group: annotation("calls") }]);

    it("computes a slot observation's cardinality and values, and binds it to the groups of its set", () => {
        const resolution = resolveProfileSubmission(
            submission(base, {
                dimensions: [{ label: "subject", category: "subject", observations: [{ kind: "slot", setId: calls.id, slotId: subjectSlot.id }] }],
            }),
            detected,
            menu,
        );
        const observation = resolution.dimensions[0]!.observations[0]!;

        expect(resolution.errors).toEqual([]);
        expect(resolution.dimensions[0]!.scope).toBe("biological");
        expect(observation.kind).toBe("slot");
        if (observation.kind !== "slot") throw new Error("expected a slot observation");
        expect(observation.cardinality).toBe(SUBJECTS);
        expect(observation.groupIds).toEqual(["calls"]);
        expect(observation.sampleValues.length).toBeGreaterThan(0);
    });

    it("measures the overlap between two slot observations rather than claiming one", () => {
        const resolution = resolveProfileSubmission(
            submission(base, {
                dimensions: [
                    {
                        label: "subject",
                        category: "subject",
                        observations: [
                            { kind: "slot", setId: calls.id, slotId: subjectSlot.id },
                            { kind: "slot", setId: align.id, slotId: alignSubjectSlot.id },
                        ],
                    },
                ],
            }),
            detected,
            menu,
        );
        const second = resolution.dimensions[0]!.observations[1]!;
        if (second.kind !== "slot") throw new Error("expected a slot observation");
        expect(second.checked).toEqual({ matched: ALIGNED, of: ALIGNED });
        expect(second.checkedAgainst).toBe(subjectSlot.id);
    });

    it("leaves `checked` absent when nothing was measured", () => {
        const resolution = resolveProfileSubmission(
            submission(base, {
                dimensions: [
                    {
                        label: "batch",
                        category: "batch",
                        observations: [{ kind: "column", path: "data/inputs/meta/samplesheet.csv", column: "plate", exampleValues: ["P1", "P2"] }],
                    },
                ],
            }),
            detected,
            menu,
        );
        const observation = resolution.dimensions[0]!.observations[0]!;
        expect(observation).not.toHaveProperty("checked");
        expect(resolution.dimensions[0]!.scope).toBe("technical");
    });

    it("carries disagreeing observations side by side with the delta", () => {
        const resolution = resolveProfileSubmission(
            submission(base, {
                dimensions: [
                    {
                        label: "subject",
                        category: "subject",
                        observations: [
                            { kind: "slot", setId: calls.id, slotId: subjectSlot.id },
                            { kind: "document", path: "data/inputs/README.md", citation: "The cohort holds eight subjects.", statesCardinality: 8 },
                        ],
                        reconciliations: [{ note: "The document states more subjects than files exist for.", delta: 2 }],
                    },
                ],
            }),
            detected,
            menu,
        );
        const dimension = resolution.dimensions[0]!;
        expect(dimension.reconciliations).toEqual([{ note: "The document states more subjects than files exist for.", delta: 2 }]);
        expect(dimension).not.toHaveProperty("cardinality");
    });

    it("refuses a slot binding to a slot the named set does not have", () => {
        const resolution = resolveProfileSubmission(
            submission(base, {
                dimensions: [{ label: "subject", category: "subject", observations: [{ kind: "slot", setId: align.id, slotId: subjectSlot.id }] }],
            }),
            detected,
            menu,
        );
        expect(resolution.errors.join(" ")).toContain(`has no slot "${subjectSlot.id}"`);
        expect(resolution.dimensions).toEqual([]);
    });

    it("persists a slot observation's binding as a template and a position, not a scan-scoped id", () => {
        const resolution = resolveProfileSubmission(
            submission(base, {
                dimensions: [{ label: "subject", category: "subject", observations: [{ kind: "slot", setId: calls.id, slotId: subjectSlot.id }] }],
            }),
            detected,
            menu,
        );
        const observation = resolution.dimensions[0]!.observations[0]!;
        if (observation.kind !== "slot") throw new Error("expected a slot observation");

        expect(observation.binding).toEqual({
            template: calls.pathTemplate,
            slotIndex: calls.slots.findIndex((slot) => slot.id === subjectSlot.id),
        });
    });

    it("lets the agent declare the scope of an `other` dimension, defaulting to technical", () => {
        const observations = [{ kind: "slot" as const, setId: calls.id, slotId: originSlot.id }];
        const declared = resolveProfileSubmission(
            submission(base, {
                dimensions: [{ label: "graft state", category: "other", categoryLabel: "graft state", scope: "biological", observations }],
            }),
            detected,
            menu,
        );
        const defaulted = resolveProfileSubmission(
            submission(base, { dimensions: [{ label: "graft state", category: "other", categoryLabel: "graft state", observations }] }),
            detected,
            menu,
        );

        expect(declared.dimensions[0]!.scope).toBe("biological");
        expect(defaulted.dimensions[0]!.scope).toBe("technical");
    });

    it("refuses a nesting under a dimension that was not submitted", () => {
        const resolution = resolveProfileSubmission(
            submission(base, {
                dimensions: [
                    {
                        label: "sample",
                        category: "sample",
                        observations: [{ kind: "slot", setId: calls.id, slotId: subjectSlot.id }],
                        nestsUnder: { dimension: "subject", evidence: "Sample directories sit under subject directories." },
                    },
                ],
            }),
            detected,
            menu,
        );
        expect(resolution.errors.join(" ")).toContain("not among the submitted dimensions");
    });
});

describe("two slots the scanner itself linked", () => {
    /**
     * One identity in two positions: the directory carries `S001`, the stem carries the
     * same id after a literal prefix. The scanner links them and counts zero disagreements —
     * but affix recovery leaves the two value sets textually different, so an exact-string
     * intersection over them would measure nothing real.
     */
    const linkedTree = Array.from({ length: 5 }, (_, i) => {
        const subject = `S${String(i + 1).padStart(3, "0")}`;
        return file(`data/inputs/${subject}/lib-${subject}.vcf`, "vcf", ["vcf"]);
    });
    const linked = detectSets(linkedTree);
    const linkedMenu = buildSetMenu(linked);
    const linkedSet = linked.sets[0]!;

    it("are not intersected, so the profile never claims two corresponding id sets are disjoint", () => {
        const dirSlot = linkedSet.slots.find((slot) => slot.location === "directory")!;
        const stemSlot = linkedSet.slots.find((slot) => slot.location === "name")!;
        // The premise: the scan linked them, and their values differ as text.
        expect(stemSlot.sameAsSlot).toBe(dirSlot.id);
        expect(new Set(linked.slotValues.get(dirSlot.id)!)).not.toEqual(new Set(linked.slotValues.get(stemSlot.id)!));

        const resolution = resolveProfileSubmission(
            {
                operations: [{ op: "use", setId: linkedSet.id, group: annotation("per-subject calls") }],
                dimensions: [
                    {
                        label: "subject",
                        category: "subject",
                        observations: [
                            { kind: "slot", setId: linkedSet.id, slotId: dirSlot.id },
                            { kind: "slot", setId: linkedSet.id, slotId: stemSlot.id },
                        ],
                    },
                ],
                analysisSummary: "A synthetic per-subject tree.",
                domain: "genomics",
                organism: null,
            },
            linked,
            linkedMenu,
        );
        const second = resolution.dimensions[0]!.observations[1]!;
        if (second.kind !== "slot") throw new Error("expected a slot observation");

        expect(second).not.toHaveProperty("checked");
        expect(second.sameAsSlot).toBe(dirSlot.id);
        expect(second.sameAsSlotMismatches).toBe(0);
    });
});

describe("the recipe", () => {
    it("keys each step to the scanner templates rather than the menu ids", () => {
        const resolution = resolveProfileSubmission(submission(claimEverything([{ op: "use", setId: calls.id, group: annotation("calls") }])), detected, menu);
        const use = resolution.recipe.find((step) => step.op === "use" && step.templates.includes(calls.pathTemplate))!;

        expect(use.groupIds).toEqual(["calls"]);
        expect(JSON.stringify(resolution.recipe)).not.toContain(calls.id);
    });

    it("records the value mapping a split resolved against", () => {
        const resolution = resolveProfileSubmission(
            submission(
                claimEverything([
                    {
                        op: "split",
                        setId: calls.id,
                        by: {
                            kind: "values",
                            slotId: originSlot.id,
                            groups: [
                                { values: ["somatic"], group: annotation("somatic calls") },
                                { values: ["germline"], group: annotation("germline calls") },
                            ],
                        },
                        reason: "Different substrates.",
                    },
                ]),
            ),
            detected,
            menu,
        );
        const split = resolution.recipe.find((step) => step.op === "split")!;
        expect(split.slotIndex).toBe(calls.slots.findIndex((slot) => slot.id === originSlot.id));
        expect(split.valueMapping).toEqual([
            { groupId: "somatic-calls", values: ["somatic"] },
            { groupId: "germline-calls", values: ["germline"] },
        ]);
    });
});

describe("the submission schema", () => {
    it("makes a declared count and a path pattern unrepresentable", () => {
        const withCount = ProfileSubmissionSchema.safeParse(
            submission([{ op: "use", setId: calls.id, group: { ...annotation("calls"), count: 12 } as unknown as GroupAnnotation }]),
        );
        const withPattern = ProfileSubmissionSchema.safeParse(
            submission([{ op: "use", setId: calls.id, group: { ...annotation("calls"), pathPattern: "data/**" } as unknown as GroupAnnotation }]),
        );
        expect(withCount.success).toBe(false);
        expect(withPattern.success).toBe(false);
    });

    it("refuses a dimension carrying no observation", () => {
        const parsed = ProfileSubmissionSchema.safeParse(
            submission([{ op: "use", setId: calls.id, group: annotation("calls") }], {
                dimensions: [{ label: "subject", category: "subject", observations: [] }],
            }),
        );
        expect(parsed.success).toBe(false);
    });

    it("refuses a category outside the shipped vocabulary", () => {
        const parsed = ProfileSubmissionSchema.safeParse(
            submission([{ op: "use", setId: calls.id, group: { ...annotation("calls"), category: "hypercubes" } as unknown as GroupAnnotation }]),
        );
        expect(parsed.success).toBe(false);
    });

    it("refuses an over-long operation list rather than truncating it", () => {
        const operations = Array.from({ length: 60 }, (): MenuOperation => ({ op: "use", setId: calls.id, group: annotation("calls") }));
        expect(ProfileSubmissionSchema.safeParse(submission(operations)).success).toBe(false);
    });

    it("has no place to claim an overlap that was never measured", () => {
        const parsed = ProfileSubmissionSchema.safeParse(
            submission([{ op: "use", setId: calls.id, group: annotation("calls") }], {
                dimensions: [
                    {
                        label: "subject",
                        category: "subject",
                        observations: [{ kind: "slot", setId: calls.id, slotId: subjectSlot.id, checked: { matched: 0, of: 0 } } as never],
                    },
                ],
            }),
        );
        expect(parsed.success).toBe(false);
    });
});
