/**
 * Incremental absorption — replaying a completed profile's recipe against a fresh scan.
 *
 * The recipe is keyed to scanner TEMPLATES, so it survives the scan that produced it: a
 * tree that gained files for ten more subjects instantiates the same templates, and the
 * operations that grouped it still say what its files are. Replaying them re-derives
 * membership, counts, and the partition deterministically — no sandbox, no model — and the
 * profile completes on arithmetic alone.
 *
 * Three outcomes past "there was nothing to replay". A replay claiming every kept file is a
 * FULL absorb and completes the profile. A replay leaving files unclaimed is a PARTIAL
 * absorb: those files are the delta, and the agent sees them alongside the resolution that
 * already stands rather than an empty page. A recipe whose templates no longer resolve is
 * STRANDED and falls back to a full re-profile — loudly, because silently absorbing the
 * half that still resolves would persist a profile describing part of a tree while
 * claiming to describe all of it.
 *
 * Group ids survive a replay because the reconstructed annotation carries the PERSISTED
 * group name, which is what the original resolution derived the id from — including the
 * `name — value` a slot split minted. A dimension's `groupIds` therefore still point at
 * the groups they pointed at.
 */

import type { DataProfileGroup, DataProfileRecipeStep, DataProfileResult } from "../contracts/data-profile.js";
import type { GroupCategory, GroupRole } from "../contracts/profile-vocabulary.js";
import type { SetMenu } from "../input-scan/menu.js";
import type { DetectedSet, DetectedSets } from "../input-scan/set-types.js";
import type { GroupAnnotation, MenuOperation, ProfileSubmission } from "../schemas/data-profile-schemas.js";
import { resolveProfileSubmission, type ProfileResolution } from "./data-profile-resolve.js";

/** Delta paths named in the repair briefing before the tail folds into a count. */
export const MAX_DELTA_PATHS = 30;

export type AbsorbKind = "none" | "full" | "partial" | "stranded";

export type AbsorbOutcome =
    | { readonly kind: "none" }
    | { readonly kind: "stranded"; readonly reason: string }
    | { readonly kind: "full"; readonly operations: readonly MenuOperation[]; readonly resolution: ProfileResolution }
    | {
          readonly kind: "partial";
          readonly operations: readonly MenuOperation[];
          readonly resolution: ProfileResolution;
          /** Kept files the replayed recipe does not account for — what the agent is woken for. */
          readonly delta: readonly string[];
      };

/** Every kept path of a scan — members and leftovers alike. Companions ride on their member. */
function keptPaths(detected: DetectedSets): Set<string> {
    const paths = new Set<string>();
    for (const set of detected.sets) for (const member of set.members) paths.add(member.path);
    for (const member of detected.leftoverMembers) paths.add(member.path);
    return paths;
}

/**
 * A persisted group read back as the annotation that produced it.
 *
 * `role` and `category` are widened to `string` on the contract, because a consumer
 * rendering an old row must not fail on a retired id. They are carried through as they
 * stand: a replay records what the profile already said, and re-adjudicating a category
 * against today's catalogue would be authoring, which is the one thing a replay must not do.
 */
function annotationOf(group: DataProfileGroup, kept: ReadonlySet<string>): GroupAnnotation {
    const annotations = (group.memberAnnotations ?? []).filter((entry) => kept.has(entry.path));
    return {
        name: group.name,
        memberRepresents: group.memberRepresents,
        description: group.description,
        role: group.role as GroupRole,
        category: group.category as GroupCategory,
        ...(group.categoryLabel ? { categoryLabel: group.categoryLabel } : {}),
        ...(group.subtype ? { subtype: group.subtype } : {}),
        ...(group.categoryReason ? { categoryReason: group.categoryReason } : {}),
        ...(annotations.length > 0 ? { memberAnnotations: annotations.map((entry) => ({ path: entry.path, note: entry.note })) } : {}),
    };
}

interface ReplayContext {
    readonly setsByTemplate: ReadonlyMap<string, DetectedSet>;
    readonly groupsById: ReadonlyMap<string, DataProfileGroup>;
    readonly kept: ReadonlySet<string>;
}

class StrandedRecipe extends Error {}

function requireSet(ctx: ReplayContext, template: string, op: string): DetectedSet {
    const set = ctx.setsByTemplate.get(template);
    if (!set) throw new StrandedRecipe(`${op}: the template "${template}" is not on the fresh menu`);
    return set;
}

function requireGroup(ctx: ReplayContext, groupId: string | undefined, op: string): DataProfileGroup {
    const group = groupId ? ctx.groupsById.get(groupId) : undefined;
    if (!group) throw new StrandedRecipe(`${op}: the recipe names group "${groupId ?? "(none)"}", which the profile does not carry`);
    return group;
}

/**
 * Rebuild one recipe step as the operation that produced it.
 *
 * A split replays as a value mapping whatever it was authored as, and that is deliberate:
 * a slot value the mapping does not name is a value nobody has judged, so its members fall
 * out unclaimed and become the delta rather than landing in a group by default.
 * `undefined` means the step addressed only files that are gone.
 */
function replayStep(ctx: ReplayContext, step: DataProfileRecipeStep): MenuOperation | undefined {
    if (step.op === "use") {
        const set = requireSet(ctx, step.templates[0] ?? "", "use");
        return { op: "use", setId: set.id, group: annotationOf(requireGroup(ctx, step.groupIds[0], "use"), ctx.kept) };
    }

    if (step.op === "merge") {
        const sets = step.templates.map((template) => requireSet(ctx, template, "merge"));
        const group = requireGroup(ctx, step.groupIds[0], "merge");
        return { op: "merge", setIds: sets.map((set) => set.id), group: annotationOf(group, ctx.kept), reason: group.reason ?? "" };
    }

    if (step.op === "group") {
        const paths = (step.paths ?? []).filter((path) => ctx.kept.has(path));
        if (paths.length === 0) return undefined;
        return { op: "group", paths, group: annotationOf(requireGroup(ctx, step.groupIds[0], "group"), ctx.kept) };
    }

    const set = requireSet(ctx, step.templates[0] ?? "", "split");
    const slot = step.slotIndex !== undefined ? set.slots[step.slotIndex] : undefined;
    if (!slot) throw new StrandedRecipe(`split: the template "${set.pathTemplate}" no longer carries a slot at position ${step.slotIndex ?? "(none)"}`);

    const mapped = (step.valueMapping ?? [])
        .filter((entry) => entry.values.length > 0)
        .map((entry) => ({ values: [...entry.values], group: annotationOf(requireGroup(ctx, entry.groupId, "split"), ctx.kept) }));
    if (mapped.length === 0) throw new StrandedRecipe(`split: the recipe for "${set.pathTemplate}" maps no slot value to a group`);

    const reason = ctx.groupsById.get(step.groupIds[0] ?? "")?.reason ?? "";
    return { op: "split", setId: set.id, by: { kind: "values", slotId: slot.id, groups: mapped }, reason };
}

/**
 * Replay a completed profile's recipe against a fresh scan.
 *
 * Pure. Strandedness is decided while rebuilding the operations — a template, slot, or
 * group id that no longer resolves — so every fault the resolution itself reports (a value
 * no member takes any more, a grouped path that was deleted) is a fact about the tree
 * having moved, not about the recipe having come apart.
 */
export function absorbRecipe(prior: DataProfileResult | null | undefined, detected: DetectedSets, menu: SetMenu): AbsorbOutcome {
    if (!prior?.recipe?.length || !prior.groups?.length) return { kind: "none" };

    const ctx: ReplayContext = {
        setsByTemplate: new Map(menu.sets.map((set) => [set.pathTemplate, set])),
        groupsById: new Map(prior.groups.map((group) => [group.id, group])),
        kept: keptPaths(detected),
    };

    let operations: MenuOperation[];
    try {
        operations = prior.recipe.map((step) => replayStep(ctx, step)).filter((operation): operation is MenuOperation => operation !== undefined);
    } catch (err) {
        if (err instanceof StrandedRecipe) return { kind: "stranded", reason: err.message };
        throw err;
    }
    if (operations.length === 0) return { kind: "stranded", reason: "every step of the recipe addressed files or templates that are gone" };

    const submission: ProfileSubmission = {
        operations,
        analysisSummary: prior.summary,
        domain: prior.domain ?? "",
        organism: prior.organism ?? null,
    };
    const resolution = resolveProfileSubmission(submission, detected, menu);

    if (resolution.unclaimed.length === 0) return { kind: "full", operations, resolution };
    return { kind: "partial", operations, resolution, delta: resolution.unclaimed };
}

/** A carried-forward group in full, so resubmitting it verbatim needs no recall. */
function renderAnnotation(group: GroupAnnotation, indent = ""): string[] {
    const lines = [
        `${indent}  - name: ${group.name}`,
        `${indent}  - role/category: ${group.role} / ${group.category}${group.subtype ? ` (${group.subtype})` : ""}`,
        `${indent}  - memberRepresents: ${group.memberRepresents}`,
        `${indent}  - description: ${group.description}`,
    ];
    for (const annotation of group.memberAnnotations ?? []) lines.push(`${indent}  - member ${annotation.path}: ${annotation.note}`);
    return lines;
}

/**
 * The repair briefing for a partial absorb.
 *
 * It hands the agent the resolution that already stands, in fresh menu terms, plus the
 * files it does not cover. A drift event that added one directory should cost one
 * operation, not a re-authoring of a grouping nobody disputes.
 */
export function renderAbsorbDelta(outcome: Extract<AbsorbOutcome, { kind: "partial" }>): string {
    const lines: string[] = [];
    lines.push("This analysis was profiled before, and the previous profile's operations still resolve");
    lines.push("against the menu above. They are carried forward here, ready to resubmit as they stand:");
    lines.push("");

    for (const operation of outcome.operations) {
        if (operation.op === "use") lines.push(`- \`use\` ${operation.setId}`, ...renderAnnotation(operation.group));
        else if (operation.op === "merge")
            lines.push(`- \`merge\` ${operation.setIds.join(" + ")} — ${operation.reason}`, ...renderAnnotation(operation.group));
        else if (operation.op === "group") lines.push(`- \`group\` ${operation.paths.join(", ")}`, ...renderAnnotation(operation.group));
        else {
            lines.push(`- \`split\` ${operation.setId} by ${operation.by.slotId} — ${operation.reason}`);
            if (operation.by.kind === "values") {
                for (const mapped of operation.by.groups) lines.push(`  - values ${mapped.values.join(", ")}`, ...renderAnnotation(mapped.group, "  "));
            }
        }
    }

    lines.push("");
    lines.push(`${outcome.delta.length} kept files are NOT accounted for by them:`);
    for (const path of outcome.delta.slice(0, MAX_DELTA_PATHS)) lines.push(`- ${path}`);
    if (outcome.delta.length > MAX_DELTA_PATHS) lines.push(`- … ${outcome.delta.length - MAX_DELTA_PATHS} more`);

    lines.push("");
    lines.push("This is a REPAIR ROUND OVER THE DELTA, not a re-profile. Work out what those files are");
    lines.push("and add the operations that claim them. Then resubmit the WHOLE operation list — the");
    lines.push("carried-forward ones unchanged unless the new files change what a group MEANS, plus");
    lines.push("yours. Do not re-author what already resolves, and do not re-read files the carried");
    lines.push("operations already describe.");
    return lines.join("\n");
}
