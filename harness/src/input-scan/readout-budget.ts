/**
 * Which files a header readout should open.
 *
 * Members of a set are alike by construction — that is what made them a set — so one
 * readout per set establishes what a readout per member would, at a cost that does not
 * grow with the tree. What a set does not speak for still needs reading individually:
 * a leftover is a file nothing else is like, and there is nothing to generalise from.
 *
 * The selection is data, not an action. Deciding to run it, and where, belongs to the
 * caller.
 */

import type { DetectedSet, DetectedSets, MemberFile, ReadoutSelection, SetRepresentative } from "./set-types.js";

/** A file the selection named, with what the scan already knows about its bytes. */
export interface ReadoutTarget {
    readonly path: string;
    readonly format: string;
    readonly wrapper?: string;
}

/** The member a set is best read through: the first non-empty one, by path order. */
function representativeOf(set: DetectedSet): string | undefined {
    const ordered = [...set.members].sort((a, b) => a.path.localeCompare(b.path, "en"));
    return (ordered.find((member) => member.size > 0) ?? ordered[0])?.path;
}

export function selectReadouts(sets: readonly DetectedSet[], leftovers: readonly MemberFile[]): ReadoutSelection {
    const representatives: SetRepresentative[] = [];
    for (const set of sets) {
        const path = representativeOf(set);
        if (path !== undefined) representatives.push({ setId: set.id, path });
    }
    return {
        representatives,
        individual: [...leftovers].map((file) => file.path).sort((a, b) => a.localeCompare(b, "en")),
    };
}

/**
 * The selection as readout targets. The format the scan detected rides along, so the
 * reader picks a decoder without re-sniffing bytes it already sniffed.
 */
export function readoutTargets(detected: DetectedSets): ReadoutTarget[] {
    const members = new Map<string, MemberFile>();
    for (const set of detected.sets) for (const member of set.members) members.set(member.path, member);
    for (const member of detected.leftoverMembers) members.set(member.path, member);

    const paths = [...detected.readout.representatives.map((entry) => entry.path), ...detected.readout.individual];
    const targets: ReadoutTarget[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
        const member = members.get(path);
        if (!member || seen.has(path)) continue;
        seen.add(path);
        targets.push({ path, format: member.format, ...(member.wrapper ? { wrapper: member.wrapper } : {}) });
    }
    return targets;
}
