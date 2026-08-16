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
import type { ResolvedValue } from "../report-model/reference-resolver.js";
import type { RenderValue, RenderValues } from "./types.js";

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

/**
 * The resolution result of one block: the block id, the block kind, and the resolved value of its binding.
 *
 * A value-bearing kind carries the resolved value. A no-value kind carries none, thus a text block with
 * no binding is representable and a value on it is not.
 */
export type BlockResolution = { blockId: string; kind: NoValueKind } | { blockId: string; kind: ValueBearingKind; resolved: ResolvedValue };

/**
 * One typed mismatch between a block kind and a resolved value type. `blockId` names the block, and
 * `blockKind` names the kind that sets the expectation. `expected` names the resolved type that the kind
 * needs, and `actual` names the resolved type that arrived.
 */
export interface BridgeMismatch {
    blockId: string;
    blockKind: ValueBearingKind;
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
            case "table":
            case "chart": {
                const value = resolution.resolved;
                if (value.type !== "table") {
                    mismatches.push(mismatch(resolution.blockId, resolution.kind, "table", value.type));
                    break;
                }
                values[resolution.blockId] = tableValue(value);
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
 * Map a resolved table onto a render table. The explicit column order carries through when it is present,
 * and it stays absent otherwise, thus the renderer keeps its first-row order as the default.
 *
 * The pre-bound total carries through the same way. The resolution is the one step that reads the whole
 * artifact, thus the renderer takes that count and never counts again.
 */
function tableValue(value: Extract<ResolvedValue, { type: "table" }>): RenderValue {
    const total = value.total === undefined ? {} : { total: value.total };
    if (value.columns !== undefined) {
        return { type: "table", rows: value.rows, columns: value.columns, ...total };
    }
    return { type: "table", rows: value.rows, ...total };
}

/** Make one mismatch that names the block, its kind, the resolved type that it needs, and the type that arrived. */
function mismatch(blockId: string, blockKind: ValueBearingKind, expected: ResolvedValue["type"], actual: ResolvedValue["type"]): BridgeMismatch {
    return { blockId, blockKind, expected, actual };
}
