/**
 * One reading of a persisted profile, whichever era wrote it.
 *
 * A snapshot carries the fields of its era: rows written under the groups-and-dimensions
 * model carry `groups`/`dimensions`, and rows written before it carry `kinds`/`axes` and
 * a `files` list. There is no version field to consult — optionality is the compatibility
 * mechanism — so a consumer must read both, and reading both in five places is how they
 * drift apart. They read it here instead.
 *
 * The projection is lossy in one direction only: it narrows the newer record to what the
 * older consumers already handled. Nothing it drops is unavailable — the full record is
 * on the row, and consumers that want the resolved structure read it directly.
 */

import type { DataProfileDimension, DataProfileFile, DataProfileGroup, DataProfileResult } from "../contracts/data-profile.js";

/** A group as consumers read it, whether it was authored as a group or as a kind. */
export interface ProfileGroupView {
    readonly id: string;
    readonly name: string;
    readonly memberRepresents: string;
    readonly description: string;
    /** Members — a data file and its companions count once. */
    readonly count: number;
    /** Display only. Nothing computes membership from it. */
    readonly pattern: string;
    readonly format?: string;
    /** The scanner slots this group carries, on a groups-era row. */
    readonly slotIds?: readonly string[];
    readonly unclassified?: boolean;
}

/**
 * A dimension as consumers read it. `cardinalities` carries every number the
 * observations reported, side by side: there is no canonical count, and a single field
 * would be a silent judgement between disagreeing sources.
 */
export interface ProfileDimensionView {
    readonly label: string;
    readonly cardinalities: readonly number[];
    readonly exampleValues: readonly string[];
    readonly description?: string;
}

function cardinalitiesOf(dimension: DataProfileDimension): number[] {
    const counts: number[] = [];
    for (const observation of dimension.observations) {
        if (observation.kind === "slot") counts.push(observation.cardinality);
        else if (observation.kind === "column" && observation.distinctValues !== undefined) counts.push(observation.distinctValues);
        else if (observation.kind === "document" && observation.statesCardinality !== undefined) counts.push(observation.statesCardinality);
    }
    return [...new Set(counts)];
}

function examplesOf(dimension: DataProfileDimension): string[] {
    for (const observation of dimension.observations) {
        if (observation.kind === "slot" && observation.sampleValues.length > 0) return observation.sampleValues;
        if (observation.kind === "column" && observation.exampleValues.length > 0) return observation.exampleValues;
    }
    return [];
}

function fromGroup(group: DataProfileGroup): ProfileGroupView {
    const format = group.formats.length === 1 ? group.formats[0]!.format : undefined;
    return {
        id: group.id,
        name: group.name,
        memberRepresents: group.memberRepresents,
        description: group.description,
        count: group.count,
        pattern: group.displayPattern,
        ...(format ? { format } : {}),
        ...(group.slots ? { slotIds: group.slots.map((slot) => slot.id) } : {}),
        ...(group.unclassified ? { unclassified: true } : {}),
    };
}

/** The dataset's structure, from whichever field the snapshot carries it in. */
export function profileGroups(result: DataProfileResult): ProfileGroupView[] {
    if (result.groups) return result.groups.map(fromGroup);
    return (result.kinds ?? []).map((kind, index) => ({
        id: `kind-${index + 1}`,
        name: kind.name,
        memberRepresents: kind.memberRepresents,
        description: kind.description,
        count: kind.count,
        pattern: kind.pathPattern,
        ...(kind.format ? { format: kind.format } : {}),
    }));
}

/** What varies across the dataset, from whichever field the snapshot carries it in. */
export function profileDimensions(result: DataProfileResult): ProfileDimensionView[] {
    if (result.dimensions) {
        return result.dimensions.map((dimension) => ({
            label: dimension.label,
            cardinalities: cardinalitiesOf(dimension),
            exampleValues: examplesOf(dimension),
            ...(dimension.description ? { description: dimension.description } : {}),
        }));
    }
    return (result.axes ?? []).map((axis) => ({
        label: axis.label,
        cardinalities: [axis.cardinality],
        exampleValues: axis.exampleValues ?? [],
        ...(axis.description ? { description: axis.description } : {}),
    }));
}

/**
 * The files the profile describes individually.
 *
 * On a groups-era row those are the members the agent annotated, which ride on the group
 * they belong to; on an older row they are the `files` list. Either way this is a handful
 * of notable inputs, never the dataset.
 */
export function profileFileRecords(result: DataProfileResult): DataProfileFile[] {
    if (result.groups) {
        return result.groups.flatMap((group) =>
            (group.memberAnnotations ?? []).map((annotation) => ({
                path: annotation.path,
                description: annotation.note,
                ...(group.formats.length === 1 ? { format: group.formats[0]!.format } : {}),
            })),
        );
    }
    return result.files ?? [];
}

/**
 * How many files the dataset holds, as far as the snapshot can establish it.
 *
 * The partition is the authority where present — it is a census, not an estimate. Older
 * rows fall back to coverage, then to summed kind counts, then to `null`: reporting the
 * described-file count would be a dataset size the row cannot support.
 */
export function profileDatasetFileCount(result: DataProfileResult): number | null {
    if (result.partition) return result.partition.keptFiles;
    if (result.coverage) return result.coverage.total;
    if (result.kinds && result.kinds.length > 0) return result.kinds.reduce((sum, kind) => sum + kind.count, 0);
    return null;
}

/** Dataset-wide findings the agent wrote, from whichever field the snapshot carries them in. */
export function profileCaveats(result: DataProfileResult): string[] {
    return result.caveats ?? result.qualityAssessment?.concerns ?? [];
}
