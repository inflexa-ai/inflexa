/**
 * The detected-set pipeline: quarantine → markers → sibling clustering → template
 * mining → assembly.
 *
 * Pure over paths, sizes, and the format already detected — no read, no container, no
 * model. Each stage narrows what the next one has to explain: junk leaves before
 * structure is observed, a marker-claimed subtree never reaches inference, and a
 * clustered directory arrives at mining as one template with its entity already a
 * slot.
 *
 * Assembly carries variance rather than splitting on it. Members that differ only in
 * compression are one set whose wrapper census says so, and a token appearing in both
 * a directory segment and the stem is cross-checked and reported as ONE identity slot,
 * because reporting it twice would invent a second thing that varies.
 */

import { assessCompleteness, attachCompanions } from "./companions.js";
import type { ContentSimilarity, DirectoryEntry } from "./clustering.js";
import { buildTree, clusterChildren, computeSignatures } from "./clustering.js";
import { applyMarkers } from "./markers.js";
import { quarantine } from "./quarantine.js";
import { selectReadouts } from "./readout-budget.js";
import type { DetectedSet, DetectedSets, LeftoverFiles, MemberFile, SetOrigin, SetSlot, TemplateSegment, WrapperCount } from "./set-types.js";
import type { ContextFile, DraftSegment, DraftSlot, MinedGroup, MinedItem } from "./templates.js";
import { catchAll, describeGroup, describeSlot, mineContext, slotToken } from "./templates.js";
import type { FormatCount, ScannedFile, UnstructuredEntry } from "./types.js";
import { IDENTITY_CROSS_CHECK_RATIO, MAX_EXAMPLE_PATHS, MAX_LEFTOVER_SAMPLE, MAX_SETS_PER_CONTEXT, MIN_IDENTITY_TOKEN_LENGTH } from "./tuning.js";

export interface DetectSetsOptions {
    /** Read-based agreement between candidate clusters, when the caller has header readouts. */
    readonly contentSimilarity?: ContentSimilarity;
}

/** One position of a directory path template: fixed text, or a segment that varies. */
type PathSegment = { readonly kind: "literal"; readonly name: string } | { readonly kind: "variable"; readonly index: number };

interface DraftSet {
    readonly origin: SetOrigin;
    readonly marker?: string;
    readonly pathTemplate: string;
    readonly segments: readonly DraftSegment[];
    readonly slots: readonly DraftSlot[];
    readonly members: readonly MemberFile[];
}

function fileCountOf(members: readonly MemberFile[]): number {
    return members.reduce((total, member) => total + 1 + member.companions.length, 0);
}

function bytesOf(members: readonly MemberFile[]): number {
    return members.reduce((total, member) => total + member.size + member.companions.reduce((sum, companion) => sum + companion.size, 0), 0);
}

function formatCensus(members: readonly MemberFile[]): FormatCount[] {
    const counts = new Map<string, number>();
    for (const member of members) counts.set(member.format, (counts.get(member.format) ?? 0) + 1);
    return [...counts.entries()].map(([format, count]) => ({ format, count })).sort((a, b) => b.count - a.count || a.format.localeCompare(b.format, "en"));
}

function wrapperCensus(members: readonly MemberFile[]): WrapperCount[] {
    const counts = new Map<string, number>();
    for (const member of members) {
        const wrapper = member.wrapper ?? "none";
        counts.set(wrapper, (counts.get(wrapper) ?? 0) + 1);
    }
    return [...counts.entries()].map(([wrapper, count]) => ({ wrapper, count })).sort((a, b) => b.count - a.count || a.wrapper.localeCompare(b.wrapper, "en"));
}

function renderTemplate(segments: readonly DraftSegment[], slots: readonly DraftSlot[]): string {
    return segments.map((segment) => (segment.kind === "literal" ? segment.text : slotToken(slots[segment.slot]!))).join("");
}

/** The token value at a slot's position, with the literal affixes the template shows stripped off. */
function coreAt(item: MinedItem, slot: DraftSlot): string {
    const raw = item.tokens[slot.index]?.value ?? "";
    const end = slot.suffix ? raw.length - slot.suffix.length : raw.length;
    return raw.slice(slot.prefix?.length ?? 0, end);
}

/**
 * Link a name slot to the directory slot it repeats.
 *
 * Containment rather than equality: affix recovery can take a character off the token,
 * and a directory segment may carry decoration its stem twin lacks. Containment on its
 * own is weak evidence, so it counts only where the contained token is long enough to
 * be an identifier, or where the two positions have the same cardinality — a token
 * that appears inside a segment AND varies with it one-for-one is that segment's
 * identity, while one that merely appears inside it is a coincidence of naming.
 */
function crossCheckIdentity(
    group: MinedGroup,
    nameSlots: readonly DraftSlot[],
    directorySlots: readonly DraftSlot[],
    directoryValues: readonly (readonly string[])[],
): void {
    if (group.kind !== "tokens" && group.kind !== "family") return;
    for (const slot of nameSlots) {
        if (slot.distinctValues < 2) continue;
        for (let k = 0; k < directoryValues.length; k++) {
            const values = directoryValues[k]!;
            const paired = directorySlots[k]!.distinctValues === slot.distinctValues;
            let matches = 0;
            for (let i = 0; i < group.items.length; i++) {
                const core = coreAt(group.items[i]!, slot);
                const segment = values[i] ?? "";
                const alike =
                    core === segment ||
                    (segment.includes(core) && (paired || core.length >= MIN_IDENTITY_TOKEN_LENGTH)) ||
                    (core.includes(segment) && (paired || segment.length >= MIN_IDENTITY_TOKEN_LENGTH));
                if (alike) matches++;
            }
            if (matches / group.items.length < IDENTITY_CROSS_CHECK_RATIO) continue;
            slot.sameAs = k;
            slot.crossCheckMismatches = group.items.length - matches;
            break;
        }
    }
}

function assembleMinedSet(group: MinedGroup, path: readonly PathSegment[]): DraftSet {
    const members = group.items.map((item) => item.file);
    const { slots: nameSlots, segments: nameSegments } = describeGroup(group);

    const directorySlots: DraftSlot[] = [];
    const directorySegments: DraftSegment[] = [];
    const directoryValues: (readonly string[])[] = [];
    let variablePosition = 0;
    for (const segment of path) {
        if (segment.kind === "literal") {
            directorySegments.push({ kind: "literal", text: `${segment.name}/` });
            continue;
        }
        const at = variablePosition++;
        const values = members.map((member) => member.varValues[at] ?? "");
        const distinct = new Set(values);
        if (distinct.size === 1) {
            directorySegments.push({ kind: "literal", text: `${[...distinct][0]!}/` });
            continue;
        }
        const slot = describeSlot(values, "directory", segment.index);
        if (slot.prefix) directorySegments.push({ kind: "literal", text: slot.prefix });
        directorySegments.push({ kind: "slot", slot: directorySlots.length });
        if (slot.suffix) directorySegments.push({ kind: "literal", text: slot.suffix });
        directorySegments.push({ kind: "literal", text: "/" });
        directorySlots.push(slot);
        directoryValues.push(values);
    }

    crossCheckIdentity(group, nameSlots, directorySlots, directoryValues);

    const slots = [...directorySlots, ...nameSlots];
    const segments: DraftSegment[] = [
        ...directorySegments,
        ...nameSegments.map((segment) => (segment.kind === "slot" ? { kind: "slot" as const, slot: segment.slot + directorySlots.length } : segment)),
    ];

    const origin: SetOrigin = group.kind === "tokens" ? "mined" : group.kind;
    return { origin, pathTemplate: renderTemplate(segments, slots), segments, slots, members };
}

function finalizeSet(draft: DraftSet, index: number): { set: DetectedSet; values: [string, readonly string[]][] } {
    const id = `set-${index + 1}`;
    const slotIds = draft.slots.map((_, position) => `${id}.slot-${position + 1}`);
    const slots: SetSlot[] = draft.slots.map((slot, position) => ({
        id: slotIds[position]!,
        location: slot.location,
        index: slot.index,
        tokenClass: slot.tokenClass,
        ...(slot.width !== undefined ? { width: slot.width } : {}),
        ...(slot.minLength !== undefined ? { minLength: slot.minLength, maxLength: slot.maxLength } : {}),
        ...(slot.skeleton !== undefined ? { skeleton: slot.skeleton } : {}),
        ...(slot.prefix !== undefined ? { prefix: slot.prefix } : {}),
        ...(slot.suffix !== undefined ? { suffix: slot.suffix } : {}),
        distinctValues: slot.distinctValues,
        sampleValues: slot.sampleValues,
        ...(slot.sameAs !== undefined ? { sameAsSlot: slotIds[slot.sameAs]!, crossCheckMismatches: slot.crossCheckMismatches ?? 0 } : {}),
    }));

    const segments: TemplateSegment[] = draft.segments.map((segment) =>
        segment.kind === "literal" ? { kind: "literal", text: segment.text } : { kind: "slot", slotId: slotIds[segment.slot]! },
    );
    const { members, completeness } = assessCompleteness(draft.members);

    return {
        set: {
            id,
            origin: draft.origin,
            ...(draft.marker ? { marker: draft.marker } : {}),
            pathTemplate: draft.pathTemplate,
            segments,
            memberCount: members.length,
            fileCount: fileCountOf(members),
            totalBytes: bytesOf(members),
            formats: formatCensus(members),
            wrappers: wrapperCensus(members),
            slots,
            completeness,
            examplePaths: members.slice(0, MAX_EXAMPLE_PATHS).map((member) => member.path),
            members,
        },
        values: draft.slots.map((slot, position) => [slotIds[position]!, slot.values]),
    };
}

/**
 * Sample the leftovers across formats first, then by size.
 *
 * A metadata sheet, a README, and a paper are each one file of their own format, so a
 * size-ordered sample would bury all three under whichever large files failed to
 * group. Covering formats first is what makes the notable singletons visible.
 */
function sampleLeftovers(members: readonly MemberFile[]): UnstructuredEntry[] {
    const bySize = [...members].sort((a, b) => b.size - a.size || a.path.localeCompare(b.path, "en"));
    const picked: MemberFile[] = [];
    const seen = new Set<string>();
    for (const member of bySize) {
        if (picked.length >= MAX_LEFTOVER_SAMPLE) break;
        if (seen.has(member.format)) continue;
        seen.add(member.format);
        picked.push(member);
    }
    for (const member of bySize) {
        if (picked.length >= MAX_LEFTOVER_SAMPLE) break;
        if (!picked.includes(member)) picked.push(member);
    }
    return picked.map((member) => ({ path: member.path, size: member.size, format: member.format }));
}

/** Observe the detected sets of a scanned tree. Pure — no I/O, no container, no model. */
export function detectSets(files: readonly ScannedFile[], options: DetectSetsOptions = {}): DetectedSets {
    const { kept, summary } = quarantine(files);
    const { units, unclaimed } = applyMarkers(attachCompanions(kept));

    const drafts: DraftSet[] = [];
    for (const unit of units) {
        const template = `${unit.root ? `${unit.root}/` : ""}**`;
        drafts.push({
            origin: "marker",
            marker: unit.label,
            pathTemplate: template,
            segments: [{ kind: "literal", text: template }],
            slots: [],
            members: unit.members,
        });
    }

    const leftovers: MemberFile[] = [];
    const emit = (context: readonly ContextFile[], path: readonly PathSegment[]): void => {
        const hasDirectorySlot = path.some((segment) => segment.kind === "variable");
        const mined = mineContext(context);
        let sets = mined.sets;
        let residue = mined.residue;
        // The long tail of tiny sets inside a repeated directory shape is noise: the
        // repetition is the structure, and the catch-all is where it belongs.
        if (hasDirectorySlot && sets.length > MAX_SETS_PER_CONTEXT) {
            const ordered = [...sets].sort((a, b) => b.items.length - a.items.length);
            sets = ordered.slice(0, MAX_SETS_PER_CONTEXT);
            residue = [...residue, ...ordered.slice(MAX_SETS_PER_CONTEXT).flatMap((group) => group.items)];
        }
        const caught = catchAll(residue, hasDirectorySlot);
        for (const group of [...sets, ...caught.sets]) drafts.push(assembleMinedSet(group, path));
        leftovers.push(...caught.rest.map((item) => item.file));
    };

    const descend = (entries: readonly DirectoryEntry[], path: readonly PathSegment[]): void => {
        const context: ContextFile[] = [];
        for (const entry of entries) for (const file of entry.node.files) context.push({ ...file, varValues: entry.varValues });
        if (context.length > 0) emit(context, path);

        const children = entries.flatMap((entry) => [...entry.node.children.values()].map((node) => ({ node, varValues: entry.varValues })));
        if (children.length === 0) return;
        for (const cluster of clusterChildren(children, options.contentSimilarity)) {
            if (cluster.names.length === 1) {
                descend(cluster.entries, [...path, { kind: "literal", name: cluster.names[0]! }]);
                continue;
            }
            const next = cluster.entries.map((entry) => ({ node: entry.node, varValues: [...entry.varValues, entry.node.name] }));
            descend(next, [...path, { kind: "variable", index: path.length }]);
        }
    };

    descend([{ node: computeSignatures(buildTree(unclaimed)), varValues: [] }], []);

    const ordered = drafts.sort(
        (a, b) => b.members.length - a.members.length || bytesOf(b.members) - bytesOf(a.members) || a.pathTemplate.localeCompare(b.pathTemplate, "en"),
    );
    const slotValues = new Map<string, readonly string[]>();
    const sets: DetectedSet[] = [];
    for (const [index, draft] of ordered.entries()) {
        const finalized = finalizeSet(draft, index);
        sets.push(finalized.set);
        for (const [slotId, values] of finalized.values) slotValues.set(slotId, values);
    }

    const coveredFiles = sets.reduce((total, set) => total + set.fileCount, 0);
    const leftoverFiles: LeftoverFiles = {
        memberCount: leftovers.length,
        fileCount: fileCountOf(leftovers),
        totalBytes: bytesOf(leftovers),
        sample: sampleLeftovers(leftovers),
    };

    return {
        fileCount: files.length,
        keptFileCount: kept.length,
        coverage: kept.length === 0 ? 1 : coveredFiles / kept.length,
        quarantine: summary,
        sets,
        leftovers: leftoverFiles,
        readout: selectReadouts(sets, leftovers),
        slotValues,
    };
}
