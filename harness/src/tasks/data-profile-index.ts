/**
 * The profile's vector index, as a pure projection.
 *
 * The index is a function of the scan crossed with the submitted kinds: for each kind,
 * one entry; for each entity, one entry templated from the kinds it participates in and
 * its own axis value. It has no persisted representation of its own and nothing derives
 * from it, so it can be rebuilt at any time by re-running the scan and reading `kinds`
 * off the existing profile — no model call, no re-profile. Improving the template,
 * adding a tier, or folding in entity attributes later are all re-projections.
 *
 * Two tiers, because they answer different queries. A query naming a KIND of data
 * ("variant calls") wants one result carrying the set's count and path pattern; a
 * per-entity tier would return five arbitrary subjects out of thousands of
 * indistinguishable ones. A query naming an ENTITY ("PT0421") wants that entity. A
 * per-file tier adds nothing: a file is identified by its kind and its entity, and its
 * path is on the filesystem.
 *
 * `type: "input"` keeps its existing meaning for the entity tier, so searches written
 * against it keep matching; `type: "input-kind"` is additive. Renaming `"input"` would
 * have silently broken existing search on every new analysis.
 */

import type { InputScan } from "../input-scan/types.js";
import type { DataProfileAxis, DataProfileFile, DataProfileKind } from "../state/data-profile.js";

/** Entity entries built per analysis. Past this the entity tier is a liability, not a search aid. */
export const MAX_ENTITY_ENTRIES = 20_000;

/** Kind names named in one entity's entry text. */
const MAX_KINDS_IN_ENTITY_TEXT = 6;

export interface ProfileIndexEntry {
    readonly id: string;
    readonly text: string;
    readonly metadata: Record<string, unknown>;
}

export interface BuildProfileIndexArgs {
    readonly analysisId: string;
    readonly kinds: readonly DataProfileKind[];
    readonly axes?: readonly DataProfileAxis[];
    /** The scan the profile was taken against — the source of the entity value set. */
    readonly scan?: InputScan;
    /** Individually described files, indexed only when there are no kinds to index. */
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
 * The axis label for an entity set. The agent labels axes; the scan counts values, so
 * the axis whose cardinality matches the observed set is the one the agent was naming.
 * With no match the entries still index under a neutral label rather than not at all.
 */
function entityAxisLabel(axes: readonly DataProfileAxis[] | undefined, distinct: number): string {
    if (!axes || axes.length === 0) return "entity";
    const exact = axes.find((axis) => axis.cardinality === distinct);
    if (exact) return exact.label;
    const widest = [...axes].sort((a, b) => b.cardinality - a.cardinality)[0];
    return widest?.label ?? "entity";
}

function kindEntry(analysisId: string, kind: DataProfileKind): ProfileIndexEntry {
    const facts = [`${kind.count} files`, kind.format, kind.pathPattern].filter((f): f is string => Boolean(f)).join(", ");
    return {
        id: `/${analysisId}/kind/${slug(kind.name)}`,
        text: `${kind.name} — ${kind.description} One member is ${kind.memberRepresents}. (${facts})`,
        metadata: {
            type: "input-kind",
            kind: kind.name,
            pathPattern: kind.pathPattern,
            count: kind.count,
            ...(kind.format ? { format: kind.format } : {}),
            ...(kind.axisLabels ? { axisLabels: kind.axisLabels } : {}),
        },
    };
}

function entityEntry(analysisId: string, label: string, value: string, kinds: readonly DataProfileKind[]): ProfileIndexEntry {
    const named = kinds.slice(0, MAX_KINDS_IN_ENTITY_TEXT);
    const carried = named.map((kind) => `${kind.name} (${kind.memberRepresents})`).join("; ");
    return {
        id: `/${analysisId}/entity/${encodeURIComponent(value)}`,
        text: `${label} ${value} — input data for this ${label}: ${carried}.`,
        metadata: {
            type: "input",
            entity: value,
            axis: label,
            kinds: named.map((kind) => kind.name),
        },
    };
}

/** A file entry, for the degenerate case where a profile submitted no kinds at all. */
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
    const { analysisId, kinds, axes, scan, files } = args;

    if (kinds.length === 0) {
        // No kinds is a degenerate profile, but the notable files it did describe stay
        // discoverable — the same losslessness the per-file fallback description had.
        return (files ?? []).map((file) => fileEntry(analysisId, file));
    }

    const entries = kinds.map((kind) => kindEntry(analysisId, kind));

    const { values, distinct } = entityValues(scan);
    if (values.length > 1 && values.length <= MAX_ENTITY_ENTRIES) {
        const label = entityAxisLabel(axes, distinct);
        for (const value of values) entries.push(entityEntry(analysisId, label, value, kinds));
    }

    return entries;
}
