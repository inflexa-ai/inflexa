/**
 * The menu — the bounded projection of a detected-set scan that the profiler agent
 * authors against.
 *
 * It is the briefing's replacement for an enumeration of input paths: a tree of three
 * thousand files costs the same context as a tree of thirty, because every list it draws
 * from is capped and the set list itself is capped again here. A menu past its bound
 * SAYS so — an elided tail is a fact the agent can act on, and a silent truncation is
 * the failure this projection exists to prevent.
 *
 * Nothing here names a group or a dimension. Slot correspondence across sets is reported
 * as measured overlap with its gaps, never as a shared dimension: whether two sets' id
 * slots are the same thing is the agent's determination, recorded as a slot observation.
 */

import { formatBytes } from "./scan.js";
import type { DetectedSet, DetectedSets, LeftoverFiles, QuarantineSummary, SetSlot } from "./set-types.js";
import type { HeaderReadout } from "./types.js";

/**
 * Sets the menu lists before the tail folds into a counted line.
 *
 * Forty is far past any tree that groups: a scan producing more has told the agent
 * everything a longer list would, and the aggregate says how much was left out.
 */
export const MAX_MENU_SETS = 40;

/** Slot pairs reported, ordered by how much they overlap. */
export const MAX_CORRESPONDENCES = 20;

/** Values named per side of an overlap, so a near-complete correspondence names its misses. */
export const MAX_CORRESPONDENCE_SAMPLE = 5;

/** Slots below this cardinality are compared to nothing: one value overlaps by accident. */
const MIN_CORRESPONDENCE_CARDINALITY = 2;

/**
 * Members listed in full rather than by one example.
 *
 * A set this small is a handful of distinct artifacts, and `memberAnnotations` are keyed
 * by path — an agent shown one example of five cannot write per-member prose for the
 * other four. Past the bound the example plus the template is the whole of what a listing
 * would add, at a cost that grows with the tree.
 */
export const MAX_FULLY_LISTED_SET_MEMBERS = 10;

/** Slots crossed in one co-occurrence report. Past this the cross product says nothing a reader can hold. */
export const MAX_CROSSED_SLOTS = 3;

/** Combinations the cross product may reach before it is reported as unbounded rather than counted. */
const MAX_POSSIBLE_COMBINATIONS = 1_000_000;

/**
 * How a set's slots vary TOGETHER.
 *
 * Per-slot cardinalities describe the margins; a set of 8 subjects × 3 timepoints could be
 * a full 24-member crossing or 8 members each at one timepoint, and the two are different
 * experimental designs. The margins alone cannot tell them apart.
 */
export interface SetCrossing {
    readonly setId: string;
    readonly slotIds: readonly string[];
    readonly observedCombinations: number;
    /** The full cross product, or `null` when it is past counting. */
    readonly possibleCombinations: number | null;
}

/**
 * Measured overlap between two sets' slots, with its gaps.
 *
 * Evidence, not a claim. Two id slots drawing on the same values is what makes a shared
 * dimension plausible; the values present in one and absent from the other are what make
 * it checkable.
 */
export interface SlotCorrespondence {
    readonly sets: readonly [string, string];
    readonly slots: readonly [string, string];
    readonly shared: number;
    readonly onlyInFirst: number;
    readonly onlyInSecond: number;
    readonly sharedSample: readonly string[];
    readonly onlyInFirstSample: readonly string[];
    readonly onlyInSecondSample: readonly string[];
}

/** The tail the menu did not list, in aggregate. */
export interface UnlistedSets {
    readonly sets: number;
    readonly members: number;
    readonly files: number;
    readonly totalBytes: number;
}

export interface SetMenu {
    readonly fileCount: number;
    readonly keptFileCount: number;
    /** The addressable entries. An operation may name one of these ids and no other. */
    readonly sets: readonly DetectedSet[];
    readonly unlisted: UnlistedSets;
    readonly correspondences: readonly SlotCorrespondence[];
    /** How each multi-slot set's slots vary together. Empty for single-slot sets. */
    readonly crossings: readonly SetCrossing[];
    readonly quarantine: QuarantineSummary;
    readonly leftovers: LeftoverFiles;
    /** Header readouts keyed by path — one member per set, plus every leftover. */
    readonly headers: ReadonlyMap<string, HeaderReadout>;
    /**
     * True when the walk stopped at its file ceiling. Every count below then describes a
     * prefix of the tree — carried on the menu because the agent's grouping, the persisted
     * census, and the orientation all read as complete otherwise.
     */
    readonly truncated: boolean;
    /** Leftovers whose header readout was elided by the readout budget. */
    readonly readoutsElided: number;
}

function sample(values: Iterable<string>, limit: number): string[] {
    const picked: string[] = [];
    for (const value of values) {
        if (picked.length >= limit) break;
        picked.push(value);
    }
    return picked.sort((a, b) => a.localeCompare(b, "en"));
}

function correspond(
    first: { readonly set: DetectedSet; readonly slot: SetSlot; readonly values: ReadonlySet<string> },
    second: { readonly set: DetectedSet; readonly slot: SetSlot; readonly values: ReadonlySet<string> },
): SlotCorrespondence | undefined {
    const shared: string[] = [];
    const onlyInFirst: string[] = [];
    for (const value of first.values) (second.values.has(value) ? shared : onlyInFirst).push(value);
    if (shared.length === 0) return undefined;
    const onlyInSecond: string[] = [];
    for (const value of second.values) if (!first.values.has(value)) onlyInSecond.push(value);

    return {
        sets: [first.set.id, second.set.id],
        slots: [first.slot.id, second.slot.id],
        shared: shared.length,
        onlyInFirst: onlyInFirst.length,
        onlyInSecond: onlyInSecond.length,
        sharedSample: sample(shared, MAX_CORRESPONDENCE_SAMPLE),
        onlyInFirstSample: sample(onlyInFirst, MAX_CORRESPONDENCE_SAMPLE),
        onlyInSecondSample: sample(onlyInSecond, MAX_CORRESPONDENCE_SAMPLE),
    };
}

/**
 * Slot overlap across the listed sets, strongest first.
 *
 * Computed from the complete value sets the scan keeps host-side — a bounded sample
 * could not tell a full correspondence from a partial one, which is the whole content of
 * this observation.
 */
export function buildCorrespondences(detected: DetectedSets, sets: readonly DetectedSet[]): SlotCorrespondence[] {
    const candidates = sets.flatMap((set) =>
        set.slots
            .filter((slot) => slot.distinctValues >= MIN_CORRESPONDENCE_CARDINALITY)
            .map((slot) => ({ set, slot, values: new Set(detected.slotValues.get(slot.id) ?? []) })),
    );

    const found: SlotCorrespondence[] = [];
    for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
            const first = candidates[i]!;
            const second = candidates[j]!;
            if (first.set.id === second.set.id) continue;
            const overlap = correspond(first, second);
            if (overlap) found.push(overlap);
        }
    }

    return found
        .sort((a, b) => b.shared - a.shared || a.slots[0].localeCompare(b.slots[0], "en") || a.slots[1].localeCompare(b.slots[1], "en"))
        .slice(0, MAX_CORRESPONDENCES);
}

/**
 * How the slots of one set vary together, from the per-member values the scan keeps
 * host-side. A bounded sample could not distinguish a full crossing from a partial one,
 * which is the whole content of the observation.
 */
export function buildCrossings(detected: DetectedSets, sets: readonly DetectedSet[]): SetCrossing[] {
    const crossings: SetCrossing[] = [];
    for (const set of sets) {
        const slots = set.slots.filter((slot) => slot.sameAsSlot === undefined).slice(0, MAX_CROSSED_SLOTS);
        if (slots.length < 2) continue;

        const columns = slots.map((slot) => detected.memberSlotValues.get(slot.id) ?? []);
        const combinations = new Set<string>();
        for (let member = 0; member < set.members.length; member++) combinations.add(columns.map((values) => values[member] ?? "").join(" "));

        const product = slots.reduce((total, slot) => total * slot.distinctValues, 1);
        crossings.push({
            setId: set.id,
            slotIds: slots.map((slot) => slot.id),
            observedCombinations: combinations.size,
            possibleCombinations: product > MAX_POSSIBLE_COMBINATIONS ? null : product,
        });
    }
    return crossings;
}

export interface BuildSetMenuOptions {
    readonly headers?: ReadonlyMap<string, HeaderReadout>;
    /** The walk stopped at its ceiling; see {@link SetMenu.truncated}. */
    readonly truncated?: boolean;
    readonly readoutsElided?: number;
}

/** Project a scan into the bounded menu the agent authors against. */
export function buildSetMenu(detected: DetectedSets, options: BuildSetMenuOptions = {}): SetMenu {
    const sets = detected.sets.slice(0, MAX_MENU_SETS);
    const tail = detected.sets.slice(MAX_MENU_SETS);

    return {
        fileCount: detected.fileCount,
        keptFileCount: detected.keptFileCount,
        sets,
        unlisted: {
            sets: tail.length,
            members: tail.reduce((total, set) => total + set.memberCount, 0),
            files: tail.reduce((total, set) => total + set.fileCount, 0),
            totalBytes: tail.reduce((total, set) => total + set.totalBytes, 0),
        },
        correspondences: buildCorrespondences(detected, sets),
        crossings: buildCrossings(detected, sets),
        quarantine: detected.quarantine,
        leftovers: detected.leftovers,
        headers: options.headers ?? new Map(),
        truncated: options.truncated ?? false,
        readoutsElided: options.readoutsElided ?? detected.readout.individualElided,
    };
}

function renderHeader(readout: HeaderReadout | undefined): string | undefined {
    if (!readout) return undefined;
    const fields = Object.entries(readout.fields)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
    return `  - readout (${readout.path}): ${fields || readout.unavailable || "no fields read"}`;
}

function renderSlot(slot: SetSlot): string {
    const position = `${slot.location} ${slot.index}`;
    const affix = [slot.prefix ? `after "${slot.prefix}"` : undefined, slot.suffix ? `before "${slot.suffix}"` : undefined]
        .filter((part): part is string => part !== undefined)
        .join(", ");
    const identity = slot.sameAsSlot
        ? `, same identity as ${slot.sameAsSlot}${slot.crossCheckMismatches ? ` (${slot.crossCheckMismatches} members disagreed)` : ""}`
        : "";
    const more = slot.distinctValues > slot.sampleValues.length ? ", …" : "";
    const where = affix ? `${position}, ${affix}` : position;
    return `  - slot ${slot.id} (${where}, ${slot.tokenClass})${identity}: ${slot.distinctValues} distinct — ${slot.sampleValues.join(", ")}${more}`;
}

function renderCrossing(crossing: SetCrossing | undefined): string | undefined {
    if (!crossing) return undefined;
    const { observedCombinations: observed, possibleCombinations: possible } = crossing;
    const of = possible === null ? "an uncounted cross product" : `${possible}`;
    const verdict = possible === null ? "" : observed === possible ? " — fully crossed" : ` — incomplete crossing, ${possible - observed} combinations absent`;
    return `  - crossing ${crossing.slotIds.join(" × ")}: ${observed} combinations observed of ${of}${verdict}`;
}

function renderSet(set: DetectedSet, headers: ReadonlyMap<string, HeaderReadout>, crossing: SetCrossing | undefined): string[] {
    const lines: string[] = [];
    const origin = set.origin === "marker" ? `marker: ${set.marker ?? "recognised"}` : set.origin;
    lines.push(`- ${set.id} — ${set.memberCount} members, ${set.fileCount} files, ${formatBytes(set.totalBytes)} (${origin})`);
    lines.push(`  - template: ${set.pathTemplate}`);
    lines.push(`  - formats: ${set.formats.map((f) => `${f.format} (${f.count})`).join(", ") || "unknown"}`);
    if (set.wrappers.length > 1) lines.push(`  - wrappers vary: ${set.wrappers.map((w) => `${w.wrapper} (${w.count})`).join(", ")}`);
    for (const slot of set.slots) lines.push(renderSlot(slot));
    const crossed = renderCrossing(crossing);
    if (crossed) lines.push(crossed);
    if (set.completeness.expectedCompanions.length > 0) {
        const gaps = set.completeness.incompleteSample.map((member) => `${member.path} missing ${member.missingCompanions.join(", ")}`);
        lines.push(
            `  - companions ${set.completeness.expectedCompanions.join(", ")}: ${set.completeness.completeMembers} complete, ` +
                `${set.completeness.incompleteMembers} incomplete${gaps.length > 0 ? ` — ${gaps.join("; ")}` : ""}`,
        );
    }
    // A residue set is what no other template explained and a mixed format census says its
    // members are not one substrate — both are the shape a lazy `use` covers over.
    if (set.origin === "catch-all" || set.origin === "prefix" || set.formats.length > 1) {
        lines.push("  - residue: these members are what no sharper template explained. Consider a split before you use or merge it.");
    }
    const header = renderHeader([...set.members].map((member) => headers.get(member.path)).find((readout) => readout !== undefined));
    if (header) lines.push(header);
    // A small set is a handful of distinct artifacts, and member annotations are keyed by
    // path: one example of five leaves the other four unwritable.
    if (set.memberCount > 0 && set.memberCount <= MAX_FULLY_LISTED_SET_MEMBERS) {
        const paths = [...set.members].map((member) => member.path).sort((a, b) => a.localeCompare(b, "en"));
        lines.push(`  - members: ${paths.join(", ")}`);
    } else {
        lines.push(`  - example: ${set.examplePaths[0] ?? "—"}`);
    }
    return lines;
}

/**
 * Render the menu for a briefing or a tool result.
 *
 * The wording states observations only: it never calls a set a group, and it says
 * outright that the grouping decision belongs to the reader.
 */
export function renderSetMenu(menu: SetMenu, root: string): string {
    const lines: string[] = [];
    const listed = menu.sets.length === 1 ? "1 set listed" : `${menu.sets.length} sets listed`;
    lines.push(`Input menu for ${root} — ${menu.keptFileCount} files kept of ${menu.fileCount} scanned, ${listed}.`);

    // Ahead of everything, because every count below is a count over a prefix of the tree
    // and a grouping authored as if it were complete would be wrong in a way nothing later
    // reveals.
    if (menu.truncated) {
        lines.push(
            "INCOMPLETE SCAN: the walk stopped at its file ceiling, so this menu describes PART of the tree. " +
                "Every count below is a count over that part. Say so in your caveats.",
        );
    }

    if (menu.quarantine.count > 0) {
        const reasons = menu.quarantine.reasons.map((r) => `${r.reason} (${r.count})`).join(", ");
        lines.push(`Quarantined before structure was observed: ${menu.quarantine.count} files — ${reasons}. e.g. ${menu.quarantine.sample.join(", ")}`);
    }

    lines.push("");
    lines.push("These are OBSERVATIONS of path structure, not a grouping of the dataset. A set is the");
    lines.push("files that instantiate one template; a slot is a position in that template whose token");
    lines.push("varies. What is one GROUP of data, and what a slot's variation MEANS, is your judgement,");
    lines.push("and you record it as operations on the ids below — no other id is addressable.");

    if (menu.sets.length > 0) {
        const crossings = new Map(menu.crossings.map((crossing) => [crossing.setId, crossing]));
        lines.push("");
        lines.push("Sets:");
        for (const set of menu.sets) lines.push(...renderSet(set, menu.headers, crossings.get(set.id)));
    }

    if (menu.unlisted.sets > 0) {
        lines.push(
            `- … ${menu.unlisted.sets} more sets not listed (${menu.unlisted.members} members, ${menu.unlisted.files} files, ` +
                `${formatBytes(menu.unlisted.totalBytes)}). Their members are unaddressable; anything you do not claim is swept into ` +
                `an unclassified group.`,
        );
    }

    if (menu.correspondences.length > 0) {
        lines.push("");
        lines.push("Slot value overlap between sets (measured evidence, NOT an assertion that they share a dimension):");
        for (const overlap of menu.correspondences) {
            const gaps: string[] = [];
            if (overlap.onlyInFirst > 0) gaps.push(`${overlap.onlyInFirst} only in ${overlap.slots[0]} (${overlap.onlyInFirstSample.join(", ")})`);
            if (overlap.onlyInSecond > 0) gaps.push(`${overlap.onlyInSecond} only in ${overlap.slots[1]} (${overlap.onlyInSecondSample.join(", ")})`);
            lines.push(
                `- ${overlap.slots[0]} vs ${overlap.slots[1]}: ${overlap.shared} shared values (${overlap.sharedSample.join(", ")})` +
                    `${gaps.length > 0 ? `; ${gaps.join("; ")}` : "; no gaps"}`,
            );
        }
    }

    if (menu.leftovers.memberCount > 0) {
        lines.push("");
        lines.push(
            `Files no set speaks for (${menu.leftovers.memberCount} members, ${menu.leftovers.fileCount} files, ${formatBytes(menu.leftovers.totalBytes)}):`,
        );
        for (const entry of menu.leftovers.sample) {
            lines.push(`- ${entry.path} (${entry.format}, ${formatBytes(entry.size)})`);
            const header = renderHeader(menu.headers.get(entry.path));
            if (header) lines.push(header);
        }
        if (menu.leftovers.memberCount > menu.leftovers.sample.length) {
            lines.push(`- … ${menu.leftovers.memberCount - menu.leftovers.sample.length} more not listed`);
        }
        if (menu.readoutsElided > 0) {
            lines.push(`- ${menu.readoutsElided} leftovers past the readout budget were not opened, so they carry no header above.`);
        }
        lines.push("Gather the ones that belong together with a `group` operation naming their paths.");
    }

    return lines.join("\n");
}
