/**
 * The profile's vector index, as a pure projection.
 *
 * The index is a function of the persisted profile crossed with the scan it was taken
 * against. It has no durable representation of its own and nothing derives from it, so it
 * can be rebuilt at any time from those two things — no model call, no re-profile.
 *
 * Three tiers, because they answer three different queries. A query naming a KIND of data
 * ("variant calls") wants the group: its meaning, its count, its template. A query naming
 * what VARIES ("timepoint") wants the dimension and the evidence behind it. A query naming
 * a particular FILE wants that file — but only the members an agent wrote about
 * individually are worth an entry, because a member entry templated from its group's text
 * is a near-duplicate of the group entry, and thousands of them are recall noise rather
 * than recall.
 *
 * `type: "input"` keeps its existing meaning — one entry addressing one workspace path —
 * so a search filtered to it matches whichever era wrote the profile it reads.
 *
 * Every file-addressed entry stamps its workspace path into `metadata.path`; pattern
 * entries (group, dimension, kind, entity) never do. That presence is the discriminator
 * `workspace_search` documents, so a consumer needs no id parsing to tell them apart.
 */

import type { ProfileDimensionView, ProfileGroupView } from "../app/data-profile-view.js";
import { dimensionCardinalities, profileDimensions, profileFileRecords, profileGroups } from "../app/data-profile-view.js";
import type {
    DataProfileDimension,
    DataProfileGroup,
    DataProfileGroupSlot,
    DataProfileMemberAnnotation,
    DataProfileObservation,
    DataProfileResult,
} from "../contracts/data-profile.js";
import type { InputScan } from "../input-scan/types.js";
import type { DataProfileFile } from "../state/data-profile.js";

/** Entity entries built for a legacy profile. Past this the entity tier is a liability, not a search aid. */
export const MAX_ENTITY_ENTRIES = 20_000;

/**
 * Every metadata `type` a profile writes, in either era.
 *
 * The index is a pure PROJECTION, so re-indexing replaces rather than merges: an upsert
 * keyed by entry id leaves the entries of a renamed group, a dropped dimension, or a
 * de-annotated member behind forever, searchable and wrong. Clearing exactly these types
 * clears exactly what a profile wrote — step outputs, summaries, and syntheses carry their
 * own types and are untouched.
 */
export const PROFILE_INDEX_TYPES = ["input-group", "input-dimension", "input", "input-kind"] as const;

/** Group names named in one legacy entity entry's text. */
const MAX_GROUPS_IN_ENTITY_TEXT = 6;

export interface ProfileIndexEntry {
    readonly id: string;
    readonly text: string;
    readonly metadata: Record<string, unknown>;
}

export interface BuildProfileIndexArgs {
    readonly analysisId: string;
    /** The profile as persisted. Whichever era wrote it, the entries are derived from it alone. */
    readonly result: DataProfileResult;
    /** The scan the profile was taken against — the source of a legacy profile's entity value set. */
    readonly scan?: InputScan;
}

function slug(value: string): string {
    return (
        value
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 60) || "unnamed"
    );
}

function slotSummary(slot: DataProfileGroupSlot): Record<string, unknown> {
    return { id: slot.id, location: slot.location, tokenClass: slot.tokenClass, distinctValues: slot.distinctValues };
}

function groupEntry(analysisId: string, group: DataProfileGroup): ProfileIndexEntry {
    const category = group.categoryLabel ?? group.category;
    const facts = [`${group.count} members`, `${group.fileCount} files`, group.displayPattern].join(", ");
    return {
        id: `/${analysisId}/group/${group.id}`,
        text: `${group.name} — one member is ${group.memberRepresents}. ${group.description} ${category} held as ${group.role}. (${facts})`,
        metadata: {
            type: "input-group",
            group: group.id,
            name: group.name,
            role: group.role,
            category: group.category,
            ...(group.categoryLabel ? { categoryLabel: group.categoryLabel } : {}),
            pathPattern: group.displayPattern,
            count: group.count,
            fileCount: group.fileCount,
            ...(group.slots && group.slots.length > 0 ? { slots: group.slots.map(slotSummary) } : {}),
            ...(group.unclassified ? { unclassified: true } : {}),
        },
    };
}

/** One observation as a searchable clause — where the dimension was seen, and what was seen there. */
function observationSummary(observation: DataProfileObservation): string {
    if (observation.kind === "slot") {
        const values = observation.sampleValues.length > 0 ? `, e.g. ${observation.sampleValues.join(", ")}` : "";
        return `slot ${observation.slotId} (${observation.tokenClass}, ${observation.cardinality} values${values})`;
    }
    if (observation.kind === "column") {
        const distinct = observation.distinctValues !== undefined ? `, ${observation.distinctValues} values` : "";
        return `column ${observation.column} of ${observation.path}${distinct}`;
    }
    return `document ${observation.path} (${observation.citation})`;
}

function dimensionEntry(analysisId: string, dimension: DataProfileDimension): ProfileIndexEntry {
    const category = dimension.categoryLabel ?? dimension.category;
    const description = dimension.description ? ` ${dimension.description}` : "";
    const observations = dimension.observations.map(observationSummary).join("; ");
    return {
        id: `/${analysisId}/dimension/${slug(dimension.label)}`,
        text: `${dimension.label} — ${category}, a ${dimension.scope} dimension of this dataset.${description} Observed as: ${observations}.`,
        metadata: {
            type: "input-dimension",
            dimension: dimension.label,
            category: dimension.category,
            ...(dimension.categoryLabel ? { categoryLabel: dimension.categoryLabel } : {}),
            scope: dimension.scope,
            cardinalities: dimensionCardinalities(dimension),
            groups: [...new Set(dimension.observations.flatMap((observation) => (observation.kind === "slot" ? observation.groupIds : [])))],
        },
    };
}

/**
 * One annotated member. The id addresses the member's workspace path, so a search hit
 * resolves to a file that exists rather than to a synthetic key.
 */
function memberEntry(analysisId: string, group: DataProfileGroup, annotation: DataProfileMemberAnnotation): ProfileIndexEntry {
    const format = group.formats.length === 1 ? group.formats[0]!.format : undefined;
    return {
        id: `/${analysisId}/${annotation.path}`,
        text: `${annotation.path} — ${annotation.note} In ${group.name}, where one member is ${group.memberRepresents}.`,
        metadata: {
            type: "input",
            path: annotation.path,
            group: group.id,
            groupName: group.name,
            category: group.category,
            ...(format ? { format } : {}),
        },
    };
}

/**
 * The entity value set of a legacy profile: the largest distinct-value set any single
 * variable position carries.
 *
 * Entities are what a dataset is ABOUT, and the position that varies most widely across
 * one shape is what identifies them. Taking the widest position rather than the cross
 * product is deliberate: the cross product is the file set.
 */
function entityValues(scan: InputScan | undefined): { values: string[]; distinct: number } {
    if (!scan) return { values: [], distinct: 0 };
    let best: readonly string[] = [];
    for (const shape of scan.manifest.shapes) {
        const positions = scan.positionValues.get(shape.id);
        if (!positions) continue;
        for (const position of shape.variablePositions) {
            const values = positions[position.index];
            if (values && values.length > best.length) best = values;
        }
    }
    return { values: [...best].sort((a, b) => a.localeCompare(b, "en")), distinct: best.length };
}

/**
 * The dimension label for a legacy entity set. The agent labels dimensions; the scan
 * counts values, so the dimension whose cardinality matches the observed set is the one
 * the agent was naming.
 */
function entityDimensionLabel(dimensions: readonly ProfileDimensionView[], distinct: number): string {
    if (dimensions.length === 0) return "entity";
    const exact = dimensions.find((dimension) => dimension.cardinalities.includes(distinct));
    if (exact) return exact.label;
    const widest = [...dimensions].sort((a, b) => Math.max(0, ...b.cardinalities) - Math.max(0, ...a.cardinalities))[0];
    return widest?.label ?? "entity";
}

function kindEntry(analysisId: string, group: ProfileGroupView): ProfileIndexEntry {
    const facts = [`${group.count} files`, group.format, group.pattern].filter((fact): fact is string => Boolean(fact)).join(", ");
    return {
        id: `/${analysisId}/kind/${slug(group.name)}`,
        text: `${group.name} — ${group.description} One member is ${group.memberRepresents}. (${facts})`,
        metadata: {
            type: "input-kind",
            kind: group.name,
            pathPattern: group.pattern,
            count: group.count,
            ...(group.format ? { format: group.format } : {}),
        },
    };
}

function entityEntry(analysisId: string, label: string, value: string, groups: readonly ProfileGroupView[]): ProfileIndexEntry {
    const named = groups.slice(0, MAX_GROUPS_IN_ENTITY_TEXT);
    const carried = named.map((group) => `${group.name} (${group.memberRepresents})`).join("; ");
    return {
        id: `/${analysisId}/entity/${encodeURIComponent(value)}`,
        text: `${label} ${value} — input data for this ${label}: ${carried}.`,
        metadata: {
            type: "input",
            entity: value,
            axis: label,
            kinds: named.map((group) => group.name),
        },
    };
}

/** A file entry, for a legacy profile that resolved to no structure at all. */
function fileEntry(analysisId: string, file: DataProfileFile): ProfileIndexEntry {
    return {
        id: `/${analysisId}/${file.path}`,
        text: `${file.path} — ${file.description}`,
        metadata: {
            type: "input",
            path: file.path,
            ...(file.dataType ? { dataType: file.dataType } : {}),
            ...(file.format ? { format: file.format } : {}),
            ...(file.tags ? { tags: file.tags } : {}),
        },
    };
}

/**
 * A snapshot of the kinds era, indexed as that era indexed it: one entry per kind and one
 * per entity value. Its groups were never resolved to a membership, so there is no
 * annotated-member tier to write.
 */
function legacyEntries(analysisId: string, result: DataProfileResult, scan: InputScan | undefined): ProfileIndexEntry[] {
    const groups = profileGroups(result);
    if (groups.length === 0) return profileFileRecords(result).map((file) => fileEntry(analysisId, file));

    const entries = groups.map((group) => kindEntry(analysisId, group));
    const { values, distinct } = entityValues(scan);
    if (values.length > 1 && values.length <= MAX_ENTITY_ENTRIES) {
        const label = entityDimensionLabel(profileDimensions(result), distinct);
        for (const value of values) entries.push(entityEntry(analysisId, label, value, groups));
    }
    return entries;
}

/**
 * Build every index entry for a completed profile. Deterministic and model-free: each
 * entry's text is templated from what the agent already wrote and what resolution already
 * computed, so indexing costs no LLM tokens whatever the dataset's size.
 */
export function buildProfileIndexEntries(args: BuildProfileIndexArgs): ProfileIndexEntry[] {
    const { analysisId, result, scan } = args;
    // Presence, not truthiness: a tree the scan kept nothing of resolves to `groups: []`,
    // and that is a groups-era record with no groups, not a record from before groups.
    if (result.groups === undefined) return legacyEntries(analysisId, result, scan);

    const entries = result.groups.map((group) => groupEntry(analysisId, group));
    for (const dimension of result.dimensions ?? []) entries.push(dimensionEntry(analysisId, dimension));
    for (const group of result.groups) {
        for (const annotation of group.memberAnnotations ?? []) entries.push(memberEntry(analysisId, group, annotation));
    }
    return entries;
}
