/**
 * The value bridge: a resolved value maps onto a render value, keyed by block id.
 *
 * The resolver gives one `ResolvedValue` for each reference. The renderer takes a `RenderValues` map. The
 * two models agree on a scalar, a table, and a citation, but they part on a figure. A `ResolvedValue`
 * file echo carries a path and a hash, and a page needs a source string. Thus the bridge takes a
 * caller-supplied policy that turns a file echo into a `src` string. The preview tool gives the concrete
 * policy, because the page directory and its asset access are a session concern.
 *
 * The bridge is pure. It reads no file, it resolves no reference, and it imports nothing from the state
 * layer or the tool layer. A block kind that carries no render value maps to no entry. A block kind whose
 * resolved value has the wrong type becomes one typed mismatch. The bridge collects every mismatch, thus
 * one call reports each fault at one time.
 */

import { err, ok, type Result } from "neverthrow";

import type { Block } from "../contracts/report-blocks.js";
import { statisticSlot, treeSlot, type ChartSlot } from "../report-model/block-walk.js";
import type { ResolvedValue } from "../report-model/reference-resolver.js";
import type { RenderStatistic, RenderTrack, RenderTrees, RenderValue, RenderValues } from "./types.js";

/** The block kinds that carry no render value. Each one renders from the block and the ledger alone. */
type NoValueKind = "text" | "claim" | "citation" | "section";

/** The block kinds that carry one render value under the block id in the map. */
type ValueBearingKind = "metric" | "table" | "chart" | "figure";

/** A helper that holds only when its argument is `never`. */
type AssertNever<T extends never> = T;

/**
 * A compile guard that the two kind sets together cover every block kind. A ninth block kind lands in
 * `Block` and it breaks this alias, thus the bridge cannot drop a new kind in silence.
 */
type _AllKindsCovered = AssertNever<Exclude<Block["kind"], NoValueKind | ValueBearingKind>>;

/** The file echo that a figure binding resolves to: a whole-file pin of a path and a hash. */
export type ResolvedFile = Extract<ResolvedValue, { type: "file" }>;

/** The policy that turns a resolved file echo into a figure `src` string. The caller owns the policy. */
export type FigureSourcePolicy = (file: ResolvedFile) => string;

/** One resolved statistic of a chart: the label of the block, and the resolved value of its cell. */
export interface StatisticResolution {
    label: string;
    resolved: ResolvedValue;
}

/**
 * The resolution result of one block: the block id, the block kind, and the resolved value of its binding.
 *
 * A value-bearing kind carries the resolved value. A no-value kind carries none, thus a text block with
 * no binding is representable and a value on it is not. A chart also carries the resolved track, the resolved
 * tree of each axis, and each resolved statistic, in block order, where the block declares them.
 */
export type BlockResolution =
    | { blockId: string; kind: NoValueKind }
    | { blockId: string; kind: Exclude<ValueBearingKind, "chart">; resolved: ResolvedValue }
    | {
          blockId: string;
          kind: "chart";
          resolved: ResolvedValue;
          track?: ResolvedValue;
          trees?: { x?: ResolvedValue; y?: ResolvedValue };
          statistics?: StatisticResolution[];
      };

/**
 * One typed mismatch between a block kind and a resolved value type. `blockId` names the block, and
 * `blockKind` names the kind that sets the expectation. `expected` names the resolved type that the kind
 * needs, and `actual` names the resolved type that arrived. `slot` names the track or the statistic of a
 * chart whose value has the wrong type.
 */
export interface BridgeMismatch {
    blockId: string;
    blockKind: ValueBearingKind;
    slot?: ChartSlot;
    expected: ResolvedValue["type"];
    actual: ResolvedValue["type"];
}

/**
 * Map the resolved values of the blocks onto a `RenderValues` map.
 *
 * The bridge walks each resolution in order. A no-value kind adds no entry. A value-bearing kind whose
 * resolved type matches adds one entry. A value-bearing kind whose resolved type does not match adds one
 * mismatch. A run with a mismatch returns the mismatch list and no map. A run with no mismatch returns the
 * complete map.
 */
export function bridgeValues(resolutions: readonly BlockResolution[], figureSrc: FigureSourcePolicy): Result<RenderValues, BridgeMismatch[]> {
    const values: RenderValues = {};
    const mismatches: BridgeMismatch[] = [];

    for (const resolution of resolutions) {
        switch (resolution.kind) {
            case "text":
            case "claim":
            case "citation":
            case "section":
                break;
            case "metric": {
                const value = resolution.resolved;
                if (value.type !== "scalar") {
                    mismatches.push(mismatch(resolution.blockId, "metric", "scalar", value.type));
                    break;
                }
                values[resolution.blockId] = { type: "scalar", value: value.value };
                break;
            }
            case "table": {
                const value = resolution.resolved;
                if (value.type !== "table") {
                    mismatches.push(mismatch(resolution.blockId, "table", "table", value.type));
                    break;
                }
                values[resolution.blockId] = tableValue(value);
                break;
            }
            case "chart": {
                const chart = chartValue(resolution);
                if (chart.isErr()) {
                    mismatches.push(...chart.error);
                    break;
                }
                values[resolution.blockId] = chart.value;
                break;
            }
            case "figure": {
                const value = resolution.resolved;
                if (value.type !== "file") {
                    mismatches.push(mismatch(resolution.blockId, "figure", "file", value.type));
                    break;
                }
                values[resolution.blockId] = { type: "figure", src: figureSrc(value) };
                break;
            }
        }
    }

    if (mismatches.length > 0) {
        return err(mismatches);
    }
    return ok(values);
}

/**
 * Pair each block with the resolved value of its binding, in document order.
 *
 * A value-bearing kind carries the resolved value of its binding, looked up by the block id from the map
 * that the resolution pass filled. A chart also carries the value of its track, of each tree, and of each statistic, looked
 * up by the block id and the slot. The label of a statistic comes from the block, because the render value
 * prints it. A no-value kind carries none. Where a reference sits in a block is the knowledge of
 * `block-walk.ts`, thus this walk reads the slots that the walk names and never a binding field.
 *
 * The switch is exhaustive over the eight block kinds. A ninth kind reaches the end with no return, and
 * the declared return type fails the build. Thus the walk cannot drop a kind in silence. A value-bearing
 * block reaches here only when its reference resolved, because an unresolved reference short-circuits
 * before this walk.
 */
export function collectResolutions(
    blocks: readonly Block[],
    resolvedByBlock: ReadonlyMap<string, ResolvedValue>,
    resolvedBySlot: ReadonlyMap<string, ReadonlyMap<ChartSlot, ResolvedValue>>,
): BlockResolution[] {
    const resolutions: BlockResolution[] = [];
    const visit = (block: Block): void => {
        switch (block.kind) {
            case "section":
                resolutions.push({ blockId: block.id, kind: "section" });
                for (const child of block.blocks) {
                    visit(child);
                }
                return;
            case "text":
            case "claim":
            case "citation":
                resolutions.push({ blockId: block.id, kind: block.kind });
                return;
            case "metric":
            case "table":
            case "figure": {
                const resolved = resolvedByBlock.get(block.id);
                if (resolved !== undefined) {
                    resolutions.push({ blockId: block.id, kind: block.kind, resolved });
                }
                return;
            }
            case "chart": {
                const resolved = resolvedByBlock.get(block.id);
                if (resolved === undefined) {
                    return;
                }
                const slots = resolvedBySlot.get(block.id);
                const track = slots?.get("track");
                const treeX = slots?.get(treeSlot("x"));
                const treeY = slots?.get(treeSlot("y"));
                const statistics = (block.statistics ?? []).flatMap((statistic, index) => {
                    const value = slots?.get(statisticSlot(index));
                    return value === undefined ? [] : [{ label: statistic.label, resolved: value }];
                });
                resolutions.push({
                    blockId: block.id,
                    kind: "chart",
                    resolved,
                    ...(track !== undefined ? { track } : {}),
                    ...(treeX !== undefined || treeY !== undefined
                        ? { trees: { ...(treeX !== undefined ? { x: treeX } : {}), ...(treeY !== undefined ? { y: treeY } : {}) } }
                        : {}),
                    ...(statistics.length > 0 ? { statistics } : {}),
                });
                return;
            }
        }
    };
    for (const block of blocks) {
        visit(block);
    }
    return resolutions;
}

/**
 * Map the resolutions of one chart onto its render value: the table of the binding, the rows of the track and
 * of each tree, and the value of each statistic in block order. The binding, the track, and each tree resolve
 * to a table, and each statistic resolves to a scalar. Each part of another type is one mismatch that names
 * its slot.
 */
function chartValue(resolution: Extract<BlockResolution, { kind: "chart" }>): Result<RenderValue, BridgeMismatch[]> {
    const mismatches: BridgeMismatch[] = [];
    const binding = resolution.resolved;
    if (binding.type !== "table") {
        mismatches.push(mismatch(resolution.blockId, "chart", "table", binding.type));
    }
    const track = resolution.track;
    if (track !== undefined && track.type !== "table") {
        mismatches.push(mismatch(resolution.blockId, "chart", "table", track.type, "track"));
    }
    const trees: RenderTrees = {};
    for (const axis of ["x", "y"] as const) {
        const tree = resolution.trees?.[axis];
        if (tree === undefined) continue;
        if (tree.type !== "table") {
            mismatches.push(mismatch(resolution.blockId, "chart", "table", tree.type, treeSlot(axis)));
            continue;
        }
        trees[axis] = secondTable(tree);
    }
    const statistics: RenderStatistic[] = [];
    for (const [index, statistic] of (resolution.statistics ?? []).entries()) {
        if (statistic.resolved.type !== "scalar") {
            mismatches.push(mismatch(resolution.blockId, "chart", "scalar", statistic.resolved.type, statisticSlot(index)));
            continue;
        }
        statistics.push({ label: statistic.label, value: statistic.resolved.value });
    }
    if (mismatches.length > 0 || binding.type !== "table") {
        return err(mismatches);
    }
    return ok({
        ...tableValue(binding),
        ...(statistics.length > 0 ? { statistics } : {}),
        ...(track !== undefined && track.type === "table" ? { track: secondTable(track) } : {}),
        ...(trees.x !== undefined || trees.y !== undefined ? { trees } : {}),
    });
}

/** The rows of a second table of a chart, a track or a tree, with its column order where the resolution gives one. */
function secondTable(value: Extract<ResolvedValue, { type: "table" }>): RenderTrack {
    return value.columns !== undefined ? { rows: value.rows, columns: value.columns } : { rows: value.rows };
}

/**
 * Map a resolved table onto a render table. The explicit column order carries through when it is present,
 * and it stays absent otherwise, thus the renderer keeps its first-row order as the default.
 *
 * The pre-bound total carries through the same way. The resolution is the one step that reads the whole
 * artifact, thus the renderer takes that count and never counts again.
 */
function tableValue(value: Extract<ResolvedValue, { type: "table" }>): Extract<RenderValue, { type: "table" }> {
    const total = value.total === undefined ? {} : { total: value.total };
    if (value.columns !== undefined) {
        return { type: "table", rows: value.rows, columns: value.columns, ...total };
    }
    return { type: "table", rows: value.rows, ...total };
}

/**
 * Make one mismatch that names the block, its kind, the resolved type that it needs, and the type that
 * arrived. A mismatch of a chart track, tree, or statistic names its slot.
 */
function mismatch(
    blockId: string,
    blockKind: ValueBearingKind,
    expected: ResolvedValue["type"],
    actual: ResolvedValue["type"],
    slot?: ChartSlot,
): BridgeMismatch {
    return { blockId, blockKind, ...(slot !== undefined ? { slot } : {}), expected, actual };
}
