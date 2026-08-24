/**
 * The profile's vector index, as a pure projection.
 *
 * The index is a function of the scan crossed with the resolved groups: for each group,
 * one entry; for each entity, one entry templated from the groups it participates in and
 * its own dimension value. It has no persisted representation of its own and nothing
 * derives from it, so it can be rebuilt at any time by re-running the scan and reading the
 * existing profile — no model call, no re-profile.
 *
 * Two tiers, because they answer different queries. A query naming a KIND of data
 * ("variant calls") wants one result carrying the group's count and display pattern; a
 * per-entity tier would return five arbitrary subjects out of thousands of
 * indistinguishable ones. A query naming an ENTITY wants that entity.
 *
 * `type: "input"` keeps its existing meaning for the entity tier and `type: "input-kind"`
 * its meaning for the group tier, so searches written against either keep matching
 * whichever era wrote the profile they read.
 */

import type { ProfileDimensionView, ProfileGroupView } from "../app/data-profile-view.js";
import type { InputScan } from "../input-scan/types.js";
import type { DataProfileFile } from "../state/data-profile.js";

/** Entity entries built per analysis. Past this the entity tier is a liability, not a search aid. */
export const MAX_ENTITY_ENTRIES = 20_000;

/** Group names named in one entity's entry text. */
const MAX_GROUPS_IN_ENTITY_TEXT = 6;

export interface ProfileIndexEntry {
    readonly id: string;
    readonly text: string;
    readonly metadata: Record<string, unknown>;
}

export interface BuildProfileIndexArgs {
    readonly analysisId: string;
    readonly groups: readonly ProfileGroupView[];
    readonly dimensions?: readonly ProfileDimensionView[];
    /** The scan the profile was taken against — the source of the entity value set. */
    readonly scan?: InputScan;
    /** Individually described files, indexed only when there are no groups to index. */
    readonly files?: readonly DataProfileFile[];
}

function slug(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);
}

/**
 * The entity value set: the largest distinct-value set any single variable position
 * carries.
 *
 * Entities are what a dataset is ABOUT, and the position that varies most widely across
 * one shape is what identifies them — 1171 subjects, against three timepoints and two
 * replicates. Taking the widest position rather than the cross product is deliberate:
 * the cross product is the file set, which is the tier this projection exists to avoid.
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
 * The dimension label for an entity set. The agent labels dimensions; the scan counts
 * values, so the dimension whose cardinality matches the observed set is the one the
 * agent was naming. With no match the entries still index under a neutral label rather
 * than not at all.
 */
function entityDimensionLabel(dimensions: readonly ProfileDimensionView[] | undefined, distinct: number): string {
    if (!dimensions || dimensions.length === 0) return "entity";
    const exact = dimensions.find((dimension) => dimension.cardinalities.includes(distinct));
    if (exact) return exact.label;
    const widest = [...dimensions].sort((a, b) => Math.max(0, ...b.cardinalities) - Math.max(0, ...a.cardinalities))[0];
    return widest?.label ?? "entity";
}

function groupEntry(analysisId: string, group: ProfileGroupView): ProfileIndexEntry {
    const facts = [`${group.count} files`, group.format, group.pattern].filter((f): f is string => Boolean(f)).join(", ");
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

/** A file entry, for the degenerate case where a profile resolved to no groups at all. */
function fileEntry(analysisId: string, file: DataProfileFile): ProfileIndexEntry {
    return {
        id: `/${analysisId}/${file.path}`,
        text: `${file.path} — ${file.description}`,
        metadata: {
            type: "input",
            ...(file.dataType ? { dataType: file.dataType } : {}),
            ...(file.format ? { format: file.format } : {}),
            ...(file.tags ? { tags: file.tags } : {}),
        },
    };
}

/**
 * Build every index entry for a completed profile. Deterministic and model-free: the
 * text is templated from the kind's own description and the entity's axis value, so
 * indexing costs no LLM tokens whatever the dataset's size.
 */
export function buildProfileIndexEntries(args: BuildProfileIndexArgs): ProfileIndexEntry[] {
    const { analysisId, groups, dimensions, scan, files } = args;

    if (groups.length === 0) {
        // No groups is a degenerate profile, but the notable files it did describe stay
        // discoverable — the same losslessness the per-file fallback description had.
        return (files ?? []).map((file) => fileEntry(analysisId, file));
    }

    const entries = groups.map((group) => groupEntry(analysisId, group));

    const { values, distinct } = entityValues(scan);
    if (values.length > 1 && values.length <= MAX_ENTITY_ENTRIES) {
        const label = entityDimensionLabel(dimensions, distinct);
        for (const value of values) entries.push(entityEntry(analysisId, label, value, groups));
    }

    return entries;
}
