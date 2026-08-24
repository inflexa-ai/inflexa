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

import type { DetectedSet, MemberFile, ReadoutSelection, SetRepresentative } from "./set-types.js";

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
