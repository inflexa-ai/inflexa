/**
 * The partition is the invariant every downstream consumer rests on: a planner reading
 * groups can trust that the groups ARE the dataset, and an index built from them reaches
 * every kept file's group. One hand-written example proves it for one tree; these run the
 * resolution over generated trees and generated operation lists and assert it for all of
 * them.
 *
 * Generation is seeded, so a failure names the seed that produced it and the run
 * reproduces exactly. Every tree here is synthetic — shapes authored to exercise the
 * resolver, not observed anywhere.
 */

import { describe, expect, it } from "bun:test";

import { detectSets } from "../input-scan/detect-sets.js";
import { buildSetMenu, type SetMenu } from "../input-scan/menu.js";
import type { DetectedSets } from "../input-scan/set-types.js";
import type { ScannedFile } from "../input-scan/types.js";
import { MAX_SPLIT_GROUPS, type GroupAnnotation, type MenuOperation, type ProfileSubmission } from "../schemas/data-profile-schemas.js";
import { UNCLASSIFIED_GROUP_ID, resolveProfileSubmission, type ProfileResolution } from "./data-profile-resolve.js";

/** Trees generated per property. Enough shapes to exercise the resolver, fast enough to run every time. */
const CASES = 60;

/** Deterministic PRNG (mulberry32) — a property failure has to reproduce from its seed alone. */
function rng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const pick = <T>(random: () => number, values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
const between = (random: () => number, low: number, high: number): number => low + Math.floor(random() * (high - low + 1));

function file(path: string, format: string, extensions: string[] = [], wrapper?: string): ScannedFile {
    return { path, size: 100, extensions, format, ...(wrapper ? { wrapper } : {}) };
}

const id = (n: number) => `S${String(n).padStart(3, "0")}`;

const FAMILY_DIRS = ["calls", "align", "counts", "peaks", "signal", "reports"] as const;
const ORIGINS = ["somatic", "germline"] as const;
const LEFTOVER_NAMES = ["samplesheet.csv", "README.md", "design_notes.txt"] as const;
const JUNK_NAMES = [".DS_Store", "counts.csv.part", "notes.txt.tmp"] as const;

/** A synthetic tree: a few templated families, a few one-off files, a little junk. */
function makeTree(random: () => number): ScannedFile[] {
    const files: ScannedFile[] = [];
    const dirs = [...FAMILY_DIRS];

    for (let family = between(random, 1, 4); family > 0; family--) {
        const dir = dirs.splice(Math.floor(random() * dirs.length), 1)[0]!;
        const members = between(random, 2, 7);
        const categorical = random() < 0.4;
        const companions = random() < 0.4;
        for (let member = 1; member <= members; member++) {
            for (const origin of categorical ? ORIGINS : [undefined]) {
                const stem = origin ? `${id(member)}.${origin}` : id(member);
                files.push(file(`data/inputs/${dir}/${stem}.vcf.gz`, "vcf", ["vcf", "gz"], "bgzip"));
                if (companions) files.push(file(`data/inputs/${dir}/${stem}.vcf.gz.tbi`, "tabix-index", ["vcf", "gz", "tbi"]));
            }
        }
    }

    for (let i = between(random, 0, LEFTOVER_NAMES.length); i > 0; i--) {
        const name = LEFTOVER_NAMES[i - 1]!;
        files.push(file(`data/inputs/meta/${name}`, name.endsWith(".csv") ? "csv" : "text", [name.slice(name.lastIndexOf(".") + 1)]));
    }
    for (let i = between(random, 0, JUNK_NAMES.length); i > 0; i--) {
        files.push(file(`data/inputs/${JUNK_NAMES[i - 1]!}`, "unknown"));
    }
    return files;
}

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

function submission(operations: MenuOperation[]): ProfileSubmission {
    return { operations, analysisSummary: "A synthetic tree.", domain: "genomics", organism: null };
}

/**
 * A valid operation list over whatever the scan actually found: one operation per listed
 * set, plus an explicit grouping of the files no set speaks for. `residue` withholds one
 * of those files, to exercise the sweep rather than avoid it.
 */
function makeOperations(detected: DetectedSets, menu: SetMenu, random: () => number, residue = false): MenuOperation[] {
    const operations: MenuOperation[] = [];
    const sets = [...menu.sets];

    if (sets.length >= 2 && random() < 0.3) {
        const merged = sets.splice(0, 2);
        operations.push({ op: "merge", setIds: merged.map((set) => set.id), group: annotation("merged sets") });
    }

    for (const set of sets) {
        const splittable = set.slots.filter((slot) => slot.distinctValues > 1 && slot.distinctValues <= MAX_SPLIT_GROUPS);
        if (splittable.length > 0 && random() < 0.4) {
            const slot = pick(random, splittable);
            operations.push({
                op: "split",
                setId: set.id,
                by: { kind: "slot", slotId: slot.id, group: annotation(`${set.id} by ${slot.id}`) },
                reason: "A downstream step consumes one value's files as a different substrate.",
            });
        } else {
            operations.push({ op: "use", setId: set.id, group: annotation(set.id) });
        }
    }

    const leftovers = detected.leftoverMembers.map((member) => member.path);
    const claimed = residue ? leftovers.slice(0, Math.max(0, leftovers.length - 1)) : leftovers;
    if (claimed.length > 0) operations.push({ op: "group", paths: claimed, group: annotation("context", { category: "document" }) });
    return operations;
}

/** Every kept member the scan found, which is the denominator the partition is checked against. */
function keptPaths(detected: DetectedSets): string[] {
    return [...detected.sets.flatMap((set) => set.members.map((member) => member.path)), ...detected.leftoverMembers.map((member) => member.path)].sort(
        (a, b) => a.localeCompare(b, "en"),
    );
}

/** The invariant itself: exactly one group per kept file, and an accounting that sums. */
function expectPartitions(detected: DetectedSets, resolution: ProfileResolution, seed: number): void {
    const claimed = resolution.groups.flatMap((group) => [...group.memberPaths]);
    const context = `seed ${seed}`;

    expect(new Set(claimed).size, context).toBe(claimed.length);
    expect(
        [...claimed].sort((a, b) => a.localeCompare(b, "en")),
        context,
    ).toEqual(keptPaths(detected));

    const { partition } = resolution;
    expect(
        resolution.groups.reduce((total, group) => total + group.fileCount, 0),
        context,
    ).toBe(partition.keptFiles);
    expect(
        resolution.groups.reduce((total, group) => total + group.count, 0),
        context,
    ).toBe(partition.keptMembers);
    expect(partition.keptFiles, context).toBe(detected.keptFileCount);
    expect(partition.groups, context).toBe(resolution.groups.length);
    // Quarantined files are accounted separately, and the two accountings exhaust the scan.
    expect(partition.keptFiles + partition.quarantine.count, context).toBe(partition.scannedFiles);
    expect(partition.scannedFiles, context).toBe(detected.fileCount);
}

describe("every kept file lands in exactly one group", () => {
    it("holds over generated trees under generated operations", () => {
        for (let seed = 1; seed <= CASES; seed++) {
            const random = rng(seed);
            const detected = detectSets(makeTree(random));
            const menu = buildSetMenu(detected);
            const resolution = resolveProfileSubmission(submission(makeOperations(detected, menu, random)), detected, menu);

            expect(resolution.errors, `seed ${seed}`).toEqual([]);
            expect(resolution.unclaimed, `seed ${seed}`).toEqual([]);
            expectPartitions(detected, resolution, seed);
        }
    });

    it("holds when the operations leave a residue, which sweeps into one visible group", () => {
        let swept = 0;
        for (let seed = 1; seed <= CASES; seed++) {
            const random = rng(seed);
            const detected = detectSets(makeTree(random));
            const menu = buildSetMenu(detected);
            const resolution = resolveProfileSubmission(submission(makeOperations(detected, menu, random, true)), detected, menu);

            expect(resolution.errors, `seed ${seed}`).toEqual([]);
            expectPartitions(detected, resolution, seed);

            const unclassified = resolution.groups.filter((group) => group.unclassified);
            expect(unclassified.length, `seed ${seed}`).toBe(resolution.unclaimed.length > 0 ? 1 : 0);
            if (unclassified.length === 1) {
                swept++;
                expect(unclassified[0]!.id, `seed ${seed}`).toBe(UNCLASSIFIED_GROUP_ID);
                expect(unclassified[0]!.count, `seed ${seed}`).toBe(resolution.unclaimed.length);
                expect(unclassified[0]!.memberPaths.length, `seed ${seed}`).toBe(resolution.unclaimed.length);
            }
        }
        // A property that never reaches the branch it is about proves nothing.
        expect(swept).toBeGreaterThan(0);
    });

    it("resolves the same input to the same output, every time", () => {
        for (let seed = 1; seed <= CASES; seed++) {
            const detected = detectSets(makeTree(rng(seed)));
            const menu = buildSetMenu(detected);
            const operations = makeOperations(detected, menu, rng(seed + 1000));
            expect(resolveProfileSubmission(submission(operations), detected, menu), `seed ${seed}`).toEqual(
                resolveProfileSubmission(submission(operations), detected, menu),
            );
        }
    });
});

describe("no operation sequence produces an unaccounted or doubly-claimed file", () => {
    /** One fixed tree, so each adversarial case names the shape it is adversarial against. */
    function fixture(): { detected: DetectedSets; menu: SetMenu } {
        const files: ScannedFile[] = [];
        for (let member = 1; member <= 4; member++) {
            for (const origin of ORIGINS) {
                files.push(file(`data/inputs/calls/${id(member)}.${origin}.vcf.gz`, "vcf", ["vcf", "gz"], "bgzip"));
            }
            files.push(file(`data/inputs/align/${id(member)}.bam`, "bam", ["bam"]));
        }
        files.push(file("data/inputs/meta/samplesheet.csv", "csv", ["csv"]));
        files.push(file("data/inputs/.DS_Store", "unknown"));
        const detected = detectSets(files);
        return { detected, menu: buildSetMenu(detected) };
    }

    it("refuses two operations that claim the same file, naming the overlap", () => {
        const { detected, menu } = fixture();
        const calls = menu.sets.find((set) => set.pathTemplate.includes("calls"))!;
        const resolution = resolveProfileSubmission(
            submission([
                { op: "use", setId: calls.id, group: annotation("calls") },
                { op: "use", setId: calls.id, group: annotation("calls again") },
            ]),
            detected,
            menu,
        );

        // Handed back for repair rather than resolved by precedence: a precedence would
        // pick a winner silently and the profile would still read as complete.
        expect(resolution.errors.some((error) => error.includes("claimed by both") && error.includes("exactly one group"))).toBe(true);
        expect(resolution.errors).toHaveLength(calls.memberCount);
    });

    it("refuses a split whose value mapping overlaps, rather than picking a winner", () => {
        const { detected, menu } = fixture();
        const calls = menu.sets.find((set) => set.pathTemplate.includes("calls"))!;
        const slot = calls.slots.find((candidate) => candidate.tokenClass === "word")!;
        const resolution = resolveProfileSubmission(
            submission([
                {
                    op: "split",
                    setId: calls.id,
                    by: {
                        kind: "values",
                        slotId: slot.id,
                        groups: [
                            { values: ["somatic", "germline"], group: annotation("everything") },
                            { values: ["somatic"], group: annotation("somatic again") },
                        ],
                    },
                    reason: "Two substrates.",
                },
            ]),
            detected,
            menu,
        );

        expect(resolution.errors.some((error) => error.includes('value "somatic" is claimed by more than one group'))).toBe(true);
        expectPartitions(detected, resolution, 0);
    });

    it("refuses an operation addressing a set the menu did not list, and sweeps its members", () => {
        const { detected } = fixture();
        const full = buildSetMenu(detected);
        // A menu whose tail is unlisted — the same shape a tree of more sets than the
        // rendered bound produces, without needing forty of them to make the point.
        const truncated: SetMenu = { ...full, sets: full.sets.slice(0, 1) };
        const unlisted = full.sets[1]!;

        const resolution = resolveProfileSubmission(
            submission([
                { op: "use", setId: truncated.sets[0]!.id, group: annotation("listed") },
                { op: "use", setId: unlisted.id, group: annotation("unlisted") },
            ]),
            detected,
            truncated,
        );

        expect(resolution.errors.some((error) => error.includes("past the menu's listed bound"))).toBe(true);
        expect(resolution.groups.some((group) => group.name === "unlisted")).toBe(false);
        expect(resolution.unclaimed).toEqual(expect.arrayContaining(unlisted.members.map((member) => member.path)));
        expectPartitions(detected, resolution, 0);
    });

    it("accounts an empty tree as an empty census, with no phantom unclassified group", () => {
        const detected = detectSets([]);
        const resolution = resolveProfileSubmission(submission([]), detected, buildSetMenu(detected));

        expect(resolution.errors).toEqual([]);
        expect(resolution.groups).toEqual([]);
        expect(resolution.partition).toMatchObject({ scannedFiles: 0, keptFiles: 0, keptMembers: 0, groups: 0, unclassifiedFiles: 0 });
        expectPartitions(detected, resolution, 0);
    });

    it("accounts an all-quarantined tree as zero kept files against a full quarantine", () => {
        const detected = detectSets(JUNK_NAMES.map((name) => file(`data/inputs/${name}`, "unknown")));
        const resolution = resolveProfileSubmission(submission([]), detected, buildSetMenu(detected));

        expect(resolution.groups).toEqual([]);
        expect(resolution.partition.keptFiles).toBe(0);
        expect(resolution.partition.quarantine.count).toBe(JUNK_NAMES.length);
        expectPartitions(detected, resolution, 0);
    });
});
