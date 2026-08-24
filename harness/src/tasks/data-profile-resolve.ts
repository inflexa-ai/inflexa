/**
 * Submit-time resolution — the half of the authoring contract the agent does not write.
 *
 * The agent submits operations on the menu; this computes what they MEAN over the scanned
 * tree: which members each group holds, how many files that is, what each group's slots
 * take once a split has narrowed them, and whether the whole thing partitions the kept
 * files. A count the resolution can compute is not the agent's to assert, so nothing here
 * reads a number out of the submission.
 *
 * The partition is the load-bearing invariant: every kept file lands in exactly one
 * group. Overlapping operations are an error returned for repair rather than resolved by
 * precedence — precedence would silently pick a winner and the profile would still read
 * as complete. Past the last repair round there is nobody left to return them to, so a
 * still-contested file is removed from EVERY claimant and swept, recorded as a machine
 * finding: unowned and counted once beats owned by a winner nobody chose. Files no
 * operation claims are swept into the same visible `unclassified` group, so "how much did
 * the profile cover" stops being a question and becomes a census.
 */

import { assessCompleteness } from "../input-scan/companions.js";
import type { SetMenu } from "../input-scan/menu.js";
import { buildSetMenu } from "../input-scan/menu.js";
import type { DetectedSet, DetectedSets, MemberFile, SetSlot } from "../input-scan/set-types.js";
import { MAX_SLOT_SAMPLE_VALUES } from "../input-scan/tuning.js";
import { dimensionScope } from "../contracts/profile-vocabulary.js";
import type {
    DataProfileDimension,
    DataProfileGroup,
    DataProfileGroupSlot,
    DataProfileObservation,
    DataProfilePartition,
    DataProfileProbeReport,
    DataProfileRecipeStep,
} from "../contracts/data-profile.js";
import type { GroupAnnotation, MenuOperation, Observation, ProfileSubmission } from "../schemas/data-profile-schemas.js";
import { MAX_SPLIT_GROUPS } from "../schemas/data-profile-schemas.js";

/** The id the swept residue carries. Visible in the record and in the accounting. */
export const UNCLASSIFIED_GROUP_ID = "unclassified";

/**
 * Sweep paths the recipe carries, so a replay can tell a file the last profile declined
 * to classify from one that is new to the tree.
 *
 * Bounded because the record is a thin ledger and the row is detoasted by every reader.
 * A sweep past the bound records a prefix and says so; its replay wakes the agent, which
 * is the honest outcome for a profile that left that many files unaccounted for.
 */
export const MAX_UNCLASSIFIED_RECIPE_PATHS = 1000;

/** Contested paths named in the accounting before the count stands alone. */
export const MAX_CONTESTED_SAMPLE = 10;

/** A resolved group plus the membership the record deliberately does not carry. */
export interface ResolvedGroup extends DataProfileGroup {
    /** Member paths — what the index projects from. The persisted record holds counts only. */
    readonly memberPaths: readonly string[];
}

export interface ProfileResolution {
    /** Repairable faults. A submission carrying any of these is handed back to the agent whole. */
    readonly errors: readonly string[];
    /** Kept members no operation claimed. Already swept into the `unclassified` group below. */
    readonly unclaimed: readonly string[];
    /** Kept members more than one operation claimed. Swept rather than awarded on the final round. */
    readonly contested: readonly string[];
    readonly groups: readonly ResolvedGroup[];
    readonly dimensions: readonly DataProfileDimension[];
    readonly probes: readonly DataProfileProbeReport[];
    readonly partition: DataProfilePartition;
    readonly recipe: readonly DataProfileRecipeStep[];
}

interface Claim {
    readonly member: MemberFile;
    readonly set?: DetectedSet;
    readonly memberIndex?: number;
}

interface DraftGroup {
    readonly annotation: GroupAnnotation;
    readonly nameOverride?: string;
    readonly reason?: string;
    readonly displayPattern: string;
    readonly sets: readonly DetectedSet[];
    readonly claims: readonly Claim[];
    /** Slot values this draft claimed, for the recipe's value mapping. */
    readonly splitValues?: readonly string[];
    readonly unclassified?: boolean;
}

/** One operation and the groups it produced, paired so the recipe can name them by id. */
interface RecipeEntry {
    readonly step: DataProfileRecipeStep;
    readonly drafts: DraftGroup[];
}

function slug(value: string): string {
    return (
        value
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 60) || "group"
    );
}

function fileCountOf(members: readonly MemberFile[]): number {
    return members.reduce((total, member) => total + 1 + member.companions.length, 0);
}

function bytesOf(members: readonly MemberFile[]): number {
    return members.reduce((total, member) => total + member.size + member.companions.reduce((sum, companion) => sum + companion.size, 0), 0);
}

function formatCensus(members: readonly MemberFile[]): { format: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const member of members) counts.set(member.format, (counts.get(member.format) ?? 0) + 1);
    return [...counts.entries()].map(([format, count]) => ({ format, count })).sort((a, b) => b.count - a.count || a.format.localeCompare(b.format, "en"));
}

/** The directory every path shares, or `""` when they share none. */
function commonDirectory(paths: readonly string[]): string {
    const segments = paths.map((path) => path.split("/").slice(0, -1));
    const first = segments[0] ?? [];
    let shared = first.length;
    for (const other of segments) {
        let i = 0;
        while (i < shared && i < other.length && other[i] === first[i]) i++;
        shared = i;
    }
    return first.slice(0, shared).join("/");
}

/**
 * A slot's class and values as they stand INSIDE one group.
 *
 * Recomputed from the claimed members rather than copied off the set: after a split the
 * group holds one value of the split slot, and reporting the set's cardinality there
 * would describe files the group does not hold.
 */
function narrowSlot(slot: SetSlot, values: readonly string[]): DataProfileGroupSlot {
    const distinct = [...new Set(values)].sort((a, b) => a.localeCompare(b, "en"));
    return {
        id: slot.id,
        location: slot.location,
        index: slot.index,
        tokenClass: slot.tokenClass,
        distinctValues: distinct.length,
        sampleValues: distinct.slice(0, MAX_SLOT_SAMPLE_VALUES),
        ...(slot.sameAsSlot ? { sameAsSlot: slot.sameAsSlot } : {}),
    };
}

function groupSlots(detected: DetectedSets, draft: DraftGroup, claims: readonly Claim[]): DataProfileGroupSlot[] {
    const slots: DataProfileGroupSlot[] = [];
    for (const set of draft.sets) {
        const indices = claims.filter((claim) => claim.set?.id === set.id && claim.memberIndex !== undefined).map((claim) => claim.memberIndex!);
        for (const slot of set.slots) {
            const values = detected.memberSlotValues.get(slot.id);
            if (!values) continue;
            slots.push(
                narrowSlot(
                    slot,
                    indices.map((index) => values[index] ?? ""),
                ),
            );
        }
    }
    return slots;
}

function finalizeGroup(detected: DetectedSets, draft: DraftGroup, id: string, claims: readonly Claim[]): ResolvedGroup {
    const members = claims.map((claim) => claim.member);
    const { annotation } = draft;
    const { completeness } = assessCompleteness(members);
    const slots = groupSlots(detected, draft, claims);

    return {
        id,
        name: draft.nameOverride ?? annotation.name,
        memberRepresents: annotation.memberRepresents,
        description: annotation.description,
        role: annotation.role,
        category: annotation.category,
        ...(annotation.categoryLabel ? { categoryLabel: annotation.categoryLabel } : {}),
        ...(annotation.subtype ? { subtype: annotation.subtype } : {}),
        ...(annotation.categoryReason ? { categoryReason: annotation.categoryReason } : {}),
        ...(draft.reason ? { reason: draft.reason } : {}),
        count: members.length,
        fileCount: fileCountOf(members),
        totalBytes: bytesOf(members),
        displayPattern: draft.displayPattern,
        formats: formatCensus(members),
        ...(slots.length > 0 ? { slots } : {}),
        ...(annotation.memberAnnotations && annotation.memberAnnotations.length > 0
            ? { memberAnnotations: annotation.memberAnnotations.map((entry) => ({ path: entry.path, note: entry.note })) }
            : {}),
        ...(completeness.expectedCompanions.length > 0
            ? {
                  completeness: {
                      expectedCompanions: [...completeness.expectedCompanions],
                      completeMembers: completeness.completeMembers,
                      incompleteMembers: completeness.incompleteMembers,
                      incompleteSample: completeness.incompleteSample.map((entry) => ({ path: entry.path, missingCompanions: [...entry.missingCompanions] })),
                  },
              }
            : {}),
        ...(draft.unclassified ? { unclassified: true } : {}),
        memberPaths: members.map((member) => member.path),
    };
}

/** The residue group. Authored by nobody, which is exactly why it says so. */
function unclassifiedDraft(claims: readonly Claim[]): DraftGroup {
    return {
        annotation: {
            name: "unclassified",
            memberRepresents: "one file no operation claimed",
            description: "Kept files the submitted operations did not account for. Swept here so the partition holds and the gap stays visible.",
            role: "data",
            category: "other",
            categoryLabel: "unclassified",
        },
        displayPattern: commonDirectory(claims.map((claim) => claim.member.path)) || "(unclassified)",
        sets: [],
        claims,
        unclassified: true,
    };
}

interface OperationContext {
    readonly detected: DetectedSets;
    readonly menuSets: ReadonlyMap<string, DetectedSet>;
    readonly errors: string[];
    readonly drafts: DraftGroup[];
    readonly recipe: RecipeEntry[];
    readonly byPath: ReadonlyMap<string, Claim>;
}

function openStep(ctx: OperationContext, step: DataProfileRecipeStep): RecipeEntry {
    const entry: RecipeEntry = { step, drafts: [] };
    ctx.recipe.push(entry);
    return entry;
}

function emit(ctx: OperationContext, entry: RecipeEntry, draft: DraftGroup): void {
    ctx.drafts.push(draft);
    entry.drafts.push(draft);
}

function resolveSet(ctx: OperationContext, setId: string, op: string): DetectedSet | undefined {
    const set = ctx.menuSets.get(setId);
    if (set) return set;
    const known = ctx.detected.sets.some((candidate) => candidate.id === setId);
    ctx.errors.push(
        known
            ? `${op}: "${setId}" is past the menu's listed bound, so it is not addressable. Its members sweep into unclassified unless another operation claims them.`
            : `${op}: no set "${setId}" is on the menu.`,
    );
    return undefined;
}

function allClaims(set: DetectedSet): Claim[] {
    return set.members.map((member, index) => ({ member, set, memberIndex: index }));
}

function claimsAt(set: DetectedSet, indices: readonly number[]): Claim[] {
    return indices.map((index) => ({ member: set.members[index]!, set, memberIndex: index }));
}

function applyUse(ctx: OperationContext, op: Extract<MenuOperation, { op: "use" }>): void {
    const set = resolveSet(ctx, op.setId, "use");
    if (!set) return;
    const entry = openStep(ctx, { op: "use", templates: [set.pathTemplate], groupIds: [] });
    emit(ctx, entry, { annotation: op.group, displayPattern: set.pathTemplate, sets: [set], claims: allClaims(set) });
}

function applySplit(ctx: OperationContext, op: Extract<MenuOperation, { op: "split" }>): void {
    const set = resolveSet(ctx, op.setId, "split");
    if (!set) return;
    const slotIndex = set.slots.findIndex((slot) => slot.id === op.by.slotId);
    const slot = set.slots[slotIndex];
    if (!slot) {
        ctx.errors.push(`split ${op.setId}: no slot "${op.by.slotId}" on that set. Its slots are ${set.slots.map((s) => s.id).join(", ") || "none"}.`);
        return;
    }

    const memberValues = ctx.detected.memberSlotValues.get(slot.id) ?? [];
    const byValue = new Map<string, number[]>();
    for (let index = 0; index < set.members.length; index++) {
        const value = memberValues[index] ?? "";
        const bucket = byValue.get(value);
        if (bucket) bucket.push(index);
        else byValue.set(value, [index]);
    }

    if (op.by.kind === "slot") {
        if (byValue.size > MAX_SPLIT_GROUPS) {
            ctx.errors.push(
                `split ${op.setId} by ${slot.id}: that slot takes ${byValue.size} values, past the ${MAX_SPLIT_GROUPS}-group bound. ` +
                    "A slot with that many values is an identifier, and identifiers are never split.",
            );
            return;
        }
        const entry = openStep(ctx, { op: "split", templates: [set.pathTemplate], slotIndex, groupIds: [] });
        for (const value of [...byValue.keys()].sort((a, b) => a.localeCompare(b, "en"))) {
            emit(ctx, entry, {
                annotation: op.by.group,
                nameOverride: `${op.by.group.name} — ${value}`,
                reason: op.reason,
                displayPattern: set.pathTemplate,
                sets: [set],
                claims: claimsAt(set, byValue.get(value)!),
                splitValues: [value],
            });
        }
        return;
    }

    const entry = openStep(ctx, { op: "split", templates: [set.pathTemplate], slotIndex, groupIds: [] });
    const claimedValues = new Set<string>();
    for (const mapped of op.by.groups) {
        const indices: number[] = [];
        const taken: string[] = [];
        // Deduped within the group first: a value repeated inside ONE group's list is a
        // typo, not a cross-group overlap, and reading it as one accused the group of
        // colliding with itself.
        for (const value of new Set(mapped.values)) {
            if (claimedValues.has(value)) {
                ctx.errors.push(`split ${op.setId} by ${slot.id}: value "${value}" is claimed by more than one group.`);
                continue;
            }
            claimedValues.add(value);
            const bucket = byValue.get(value);
            if (!bucket) {
                ctx.errors.push(
                    `split ${op.setId} by ${slot.id}: no member takes the value "${value}". Observed values include ${slot.sampleValues.join(", ")}.`,
                );
                continue;
            }
            indices.push(...bucket);
            taken.push(value);
        }
        if (indices.length === 0) continue;
        emit(ctx, entry, {
            annotation: mapped.group,
            reason: op.reason,
            displayPattern: set.pathTemplate,
            sets: [set],
            claims: claimsAt(set, indices),
            splitValues: taken,
        });
    }

    const restValues = [...byValue.keys()].filter((value) => !claimedValues.has(value));
    if (restValues.length === 0) return;
    if (!op.by.rest) {
        const restMembers = restValues.reduce((total, value) => total + byValue.get(value)!.length, 0);
        ctx.errors.push(
            `split ${op.setId} by ${slot.id}: ${restMembers} members take a value the mapping did not name. ` +
                'Name the remaining values, or add a "rest" group for them.',
        );
        return;
    }
    emit(ctx, entry, {
        annotation: op.by.rest,
        reason: op.reason,
        displayPattern: set.pathTemplate,
        sets: [set],
        claims: claimsAt(
            set,
            restValues.flatMap((value) => byValue.get(value)!),
        ),
        splitValues: restValues,
    });
}

function applyMerge(ctx: OperationContext, op: Extract<MenuOperation, { op: "merge" }>): void {
    const sets: DetectedSet[] = [];
    const named = new Set<string>();
    for (const setId of op.setIds) {
        // A repeated id would claim the same members twice under one group id, which no
        // cross-group overlap check can see. The schema refuses it too; this is the half
        // that holds for a submission the schema never validated (a replayed recipe).
        if (named.has(setId)) {
            ctx.errors.push(`merge: set "${setId}" is named more than once. Each set may be merged once.`);
            continue;
        }
        named.add(setId);
        const set = resolveSet(ctx, setId, "merge");
        if (set) sets.push(set);
    }
    if (sets.length < 2) return;
    const entry = openStep(ctx, { op: "merge", templates: sets.map((set) => set.pathTemplate), groupIds: [] });
    emit(ctx, entry, {
        annotation: op.group,
        reason: op.reason,
        displayPattern: sets.map((set) => set.pathTemplate).join(" | "),
        sets,
        claims: sets.flatMap(allClaims),
    });
}

function applyGroup(ctx: OperationContext, op: Extract<MenuOperation, { op: "group" }>): void {
    const claims: Claim[] = [];
    for (const path of op.paths) {
        const claim = ctx.byPath.get(path);
        if (!claim) {
            ctx.errors.push(`group "${op.group.name}": no kept file at "${path}". A quarantined file and a companion are both unclaimable.`);
            continue;
        }
        claims.push(claim);
    }
    if (claims.length === 0) return;
    const paths = claims.map((claim) => claim.member.path);
    const entry = openStep(ctx, { op: "group", templates: [], paths: [...op.paths], groupIds: [] });
    emit(ctx, entry, {
        annotation: op.group,
        displayPattern: paths.length === 1 ? paths[0]! : `${commonDirectory(paths) || "."}/… (${paths.length} paths)`,
        sets: [],
        claims,
    });
}

/** Every kept member of the scan, keyed by path — the denominator the partition is checked against. */
function keptMembers(detected: DetectedSets): Map<string, Claim> {
    const byPath = new Map<string, Claim>();
    for (const set of detected.sets) {
        for (const [index, member] of set.members.entries()) byPath.set(member.path, { member, set, memberIndex: index });
    }
    for (const member of detected.leftoverMembers) byPath.set(member.path, { member });
    return byPath;
}

interface ObservationContext {
    readonly detected: DetectedSets;
    readonly menuSets: ReadonlyMap<string, DetectedSet>;
    readonly groupsBySet: ReadonlyMap<string, readonly string[]>;
    readonly label: string;
    readonly errors: string[];
}

function resolveObservation(observation: Observation, ctx: ObservationContext): DataProfileObservation | undefined {
    if (observation.kind !== "slot") return { ...observation };

    const set = ctx.menuSets.get(observation.setId);
    if (!set) {
        ctx.errors.push(`dimension "${ctx.label}": slot observation names set "${observation.setId}", which is not on the menu.`);
        return undefined;
    }
    const slotIndex = set.slots.findIndex((candidate) => candidate.id === observation.slotId);
    const slot = set.slots[slotIndex];
    if (!slot) {
        ctx.errors.push(`dimension "${ctx.label}": set "${observation.setId}" has no slot "${observation.slotId}".`);
        return undefined;
    }
    const values = ctx.detected.slotValues.get(slot.id) ?? [];
    return {
        kind: "slot",
        groupIds: [...(ctx.groupsBySet.get(set.id) ?? [])],
        slotId: slot.id,
        // Template + position, not the scan-scoped id: an absorb re-resolves this against a
        // fresh scan, where the same id can name a different slot, and every number below is
        // recomputed from whatever it resolves to.
        binding: { template: set.pathTemplate, slotIndex },
        tokenClass: slot.tokenClass,
        cardinality: slot.distinctValues,
        sampleValues: [...values].sort((a, b) => a.localeCompare(b, "en")).slice(0, MAX_SLOT_SAMPLE_VALUES),
        ...(observation.note ? { note: observation.note } : {}),
    };
}

/** Every slot of the scan, keyed by id — the scanner's own view of what a slot observation points at. */
function slotsById(detected: DetectedSets): Map<string, SetSlot> {
    const byId = new Map<string, SetSlot>();
    for (const set of detected.sets) for (const slot of set.slots) byId.set(slot.id, slot);
    return byId;
}

/**
 * Measure the overlap between a dimension's slot observations.
 *
 * Both value sets are known host-side, so the check is PERFORMED rather than claimed —
 * and where it was not performed the field is simply absent. A boolean would assert an
 * exhaustive comparison that never happened.
 *
 * Two positions the SCANNER already linked are exempt. It matched them member by member
 * and counted the disagreements; an exact-string intersection over their value sets
 * measures something else, because affix recovery strips literal text off one side and
 * identical identifiers then compare unequal. Running it anyway would persist
 * `matched: 0` — a claim of total disjointness — over a one-to-one correspondence.
 */
function crossCheckSlots(detected: DetectedSets, observations: readonly DataProfileObservation[]): DataProfileObservation[] {
    const reference = observations.find((observation) => observation.kind === "slot");
    if (!reference || reference.kind !== "slot") return [...observations];
    const byId = slotsById(detected);
    const referenceSlot = byId.get(reference.slotId);
    const referenceValues = new Set(detected.slotValues.get(reference.slotId) ?? []);

    return observations.map((observation) => {
        if (observation.kind !== "slot" || observation.slotId === reference.slotId || observation.checked) return observation;
        const slot = byId.get(observation.slotId);
        if (slot?.sameAsSlot === reference.slotId || referenceSlot?.sameAsSlot === observation.slotId) {
            const linked = slot?.sameAsSlot === reference.slotId ? slot : referenceSlot;
            return {
                ...observation,
                sameAsSlot: reference.slotId,
                ...(linked?.crossCheckMismatches !== undefined ? { sameAsSlotMismatches: linked.crossCheckMismatches } : {}),
            };
        }
        if (referenceValues.size === 0) return observation;
        const values = detected.slotValues.get(observation.slotId) ?? [];
        if (values.length === 0) return observation;
        const matched = values.filter((value) => referenceValues.has(value)).length;
        return { ...observation, checked: { matched, of: values.length }, checkedAgainst: reference.slotId };
    });
}

function resolveDimensions(
    submission: ProfileSubmission,
    detected: DetectedSets,
    menuSets: ReadonlyMap<string, DetectedSet>,
    groupsBySet: ReadonlyMap<string, readonly string[]>,
    errors: string[],
): DataProfileDimension[] {
    const labels = new Set((submission.dimensions ?? []).map((dimension) => dimension.label));
    const resolved: DataProfileDimension[] = [];

    for (const dimension of submission.dimensions ?? []) {
        if (dimension.category === "other" && !dimension.categoryLabel) {
            errors.push(`dimension "${dimension.label}": category "other" needs a categoryLabel saying what varies.`);
        }
        if (dimension.nestsUnder && !labels.has(dimension.nestsUnder.dimension)) {
            errors.push(`dimension "${dimension.label}": nests under "${dimension.nestsUnder.dimension}", which is not among the submitted dimensions.`);
        }

        const ctx: ObservationContext = { detected, menuSets, groupsBySet, label: dimension.label, errors };
        const observations = dimension.observations
            .map((observation) => resolveObservation(observation, ctx))
            .filter((observation): observation is DataProfileObservation => observation !== undefined);
        if (observations.length === 0) {
            errors.push(`dimension "${dimension.label}": every observation failed to resolve, so nothing evidences it.`);
            continue;
        }

        resolved.push({
            label: dimension.label,
            category: dimension.category,
            ...(dimension.categoryLabel ? { categoryLabel: dimension.categoryLabel } : {}),
            scope: dimensionScope(dimension.category, dimension.scope),
            ...(dimension.description ? { description: dimension.description } : {}),
            observations: crossCheckSlots(detected, observations),
            ...(dimension.reconciliations && dimension.reconciliations.length > 0
                ? {
                      reconciliations: dimension.reconciliations.map((entry) => ({
                          note: entry.note,
                          ...(entry.delta !== undefined ? { delta: entry.delta } : {}),
                      })),
                  }
                : {}),
            ...(dimension.nestsUnder ? { nestsUnder: { ...dimension.nestsUnder } } : {}),
            ...(dimension.treatmentReason ? { treatmentReason: dimension.treatmentReason } : {}),
        });
    }
    return resolved;
}

export interface ResolveOptions {
    /**
     * True when no repair round follows. A contested file is then swept rather than
     * reported: there is nobody left to hand the error to, and leaving it with whichever
     * operation ran first would be the precedence the partition forbids.
     */
    readonly finalRound?: boolean;
}

/**
 * Resolve a submission against the scan it was authored over.
 *
 * Pure and total: it always returns a resolution, and the caller decides what to do with
 * `errors` and `unclaimed`. A first round hands both back to the live agent; the repair
 * round is a full resubmit, and after it the residue sweeps rather than blocking a
 * profile that gates planning.
 */
export function resolveProfileSubmission(
    submission: ProfileSubmission,
    detected: DetectedSets,
    menu: SetMenu = buildSetMenu(detected),
    options: ResolveOptions = {},
): ProfileResolution {
    const errors: string[] = [];
    const byPath = keptMembers(detected);
    const ctx: OperationContext = {
        detected,
        menuSets: new Map(menu.sets.map((set) => [set.id, set])),
        errors,
        drafts: [],
        recipe: [],
        byPath,
    };

    for (const operation of submission.operations) {
        if (operation.op === "use") applyUse(ctx, operation);
        else if (operation.op === "split") applySplit(ctx, operation);
        else if (operation.op === "merge") applyMerge(ctx, operation);
        else applyGroup(ctx, operation);
    }

    // Ids are assigned before membership is checked, so an overlap error can name both
    // groups and a slot observation can bind to the groups its set produced.
    const ids = new Map<DraftGroup, string>();
    const groupsBySet = new Map<string, string[]>();
    const used = new Set<string>([UNCLASSIFIED_GROUP_ID]);
    for (const draft of ctx.drafts) {
        const base = slug(draft.nameOverride ?? draft.annotation.name);
        let id = base;
        for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
        used.add(id);
        ids.set(draft, id);
        for (const set of draft.sets) {
            const bucket = groupsBySet.get(set.id);
            if (bucket) bucket.push(id);
            else groupsBySet.set(set.id, [id]);
        }
    }

    // Claims are normalized before anything counts them. Within a draft a path appears at
    // most once — an operation naming the same set twice would otherwise put its members in
    // one group twice, which no cross-group check can see. Across drafts, a path more than
    // one draft claims is CONTESTED.
    const claimsByDraft = new Map<DraftGroup, Claim[]>();
    const claimants = new Map<string, string[]>();
    for (const draft of ctx.drafts) {
        const id = ids.get(draft)!;
        const seen = new Set<string>();
        const kept: Claim[] = [];
        for (const claim of draft.claims) {
            if (seen.has(claim.member.path)) continue;
            seen.add(claim.member.path);
            kept.push(claim);
            const owners = claimants.get(claim.member.path);
            if (owners) owners.push(id);
            else claimants.set(claim.member.path, [id]);
        }
        claimsByDraft.set(draft, kept);

        for (const annotation of draft.annotation.memberAnnotations ?? []) {
            if (!seen.has(annotation.path)) errors.push(`group "${id}": annotated member "${annotation.path}" is not one of its members.`);
        }
        if (draft.annotation.category === "other" && !draft.annotation.categoryLabel) {
            errors.push(`group "${id}": category "other" needs a categoryLabel saying what it is.`);
        }
    }

    const contested = [...claimants]
        .filter(([, owners]) => owners.length > 1)
        .map(([path]) => path)
        .sort((a, b) => a.localeCompare(b, "en"));

    if (contested.length > 0) {
        const disputed = new Set(contested);
        if (options.finalRound) {
            // Removed from every claimant, not awarded to one: it lands in `unclassified`,
            // counted exactly once, and the accounting says how many were swept that way.
            for (const [draft, kept] of claimsByDraft)
                claimsByDraft.set(
                    draft,
                    kept.filter((claim) => !disputed.has(claim.member.path)),
                );
        } else {
            for (const path of contested) {
                const owners = claimants.get(path)!;
                errors.push(`"${path}" is claimed by both "${owners[0]}" and "${owners[1]}". A kept file belongs to exactly one group.`);
            }
            // The repair round decides who keeps it. Until then the first claimant holds it,
            // so the accounting handed back to the agent still sums.
            for (const [draft, kept] of claimsByDraft) {
                const id = ids.get(draft)!;
                claimsByDraft.set(
                    draft,
                    kept.filter((claim) => !disputed.has(claim.member.path) || claimants.get(claim.member.path)![0] === id),
                );
            }
        }
    }

    const claimed = new Set<string>();
    for (const kept of claimsByDraft.values()) for (const claim of kept) claimed.add(claim.member.path);

    const unclaimed = [...byPath.keys()].filter((path) => !claimed.has(path)).sort((a, b) => a.localeCompare(b, "en"));
    const drafts = [...ctx.drafts];
    if (unclaimed.length > 0) {
        const residue = unclassifiedDraft(unclaimed.map((path) => byPath.get(path)!));
        drafts.push(residue);
        ids.set(residue, UNCLASSIFIED_GROUP_ID);
        claimsByDraft.set(residue, [...residue.claims]);
    }

    for (const entry of ctx.recipe) {
        entry.step.groupIds = entry.drafts.map((draft) => ids.get(draft)!);
        if (entry.step.op === "split") {
            entry.step.valueMapping = entry.drafts.map((draft) => ({ groupId: ids.get(draft)!, values: [...(draft.splitValues ?? [])] }));
        }
    }

    const recipe: DataProfileRecipeStep[] = ctx.recipe.map((entry) => entry.step);
    if (unclaimed.length > 0) {
        const paths = unclaimed.slice(0, MAX_UNCLASSIFIED_RECIPE_PATHS);
        recipe.push({
            op: "unclassified",
            templates: [],
            paths,
            ...(unclaimed.length > paths.length ? { pathsTruncated: true } : {}),
            groupIds: [UNCLASSIFIED_GROUP_ID],
        });
    }

    const groups = drafts.map((draft) => finalizeGroup(detected, draft, ids.get(draft)!, claimsByDraft.get(draft) ?? []));
    const unclassifiedGroup = groups.find((group) => group.unclassified);

    const partition: DataProfilePartition = {
        scannedFiles: detected.fileCount,
        keptFiles: groups.reduce((total, group) => total + group.fileCount, 0),
        keptMembers: groups.reduce((total, group) => total + group.count, 0),
        groups: groups.length,
        unclassifiedMembers: unclassifiedGroup?.count ?? 0,
        unclassifiedFiles: unclassifiedGroup?.fileCount ?? 0,
        quarantine: {
            count: detected.quarantine.count,
            totalBytes: detected.quarantine.totalBytes,
            reasons: detected.quarantine.reasons.map((entry) => ({ reason: entry.reason, count: entry.count })),
            sample: [...detected.quarantine.sample],
        },
        ...(contested.length > 0 ? { contested: { members: contested.length, sample: contested.slice(0, MAX_CONTESTED_SAMPLE) } } : {}),
        ...(menu.truncated ? { scanTruncated: true } : {}),
    };

    return {
        errors,
        unclaimed,
        contested,
        groups,
        dimensions: resolveDimensions(submission, detected, ctx.menuSets, groupsBySet, errors),
        probes: (submission.probes ?? []).map((probe) => ({ ...probe })),
        partition,
        recipe,
    };
}

/** The repair round's errors, phrased for the agent that must fix them in one resubmit. */
export function formatResolutionErrors(resolution: ProfileResolution, unclaimedSample = 10): string {
    const lines: string[] = [];
    if (resolution.errors.length > 0) {
        lines.push("Your operations did not resolve:");
        for (const error of resolution.errors) lines.push(`- ${error}`);
    }
    if (resolution.contested.length > 0) {
        lines.push("Leave these claimed once. On a resubmit that still contests them they are swept into `unclassified` rather than awarded to either group.");
    }
    if (resolution.unclaimed.length > 0) {
        lines.push(`${resolution.unclaimed.length} kept files are claimed by no operation:`);
        for (const path of resolution.unclaimed.slice(0, unclaimedSample)) lines.push(`- ${path}`);
        if (resolution.unclaimed.length > unclaimedSample) lines.push(`- … ${resolution.unclaimed.length - unclaimedSample} more`);
    }
    lines.push("Resubmit the WHOLE operation list, corrected. A partial correction is not merged into the previous submission.");
    lines.push("Anything you still leave unclaimed is swept into a visible `unclassified` group.");
    return lines.join("\n");
}
