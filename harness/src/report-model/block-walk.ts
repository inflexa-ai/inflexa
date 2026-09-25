/**
 * The one walk over a block tree.
 *
 * A block kind decides where a reference sits, which text carries a free numeral or a drifted exponent
 * form, and whether the block holds children. Three consumers need that same knowledge: the mechanical
 * validator, the draft finish, and the draft operations. A switch for each consumer is a switch that a
 * ninth block kind can miss in silence, because each arm returns and none of them fails to build. Thus the
 * walk lives here one time.
 *
 * The walk reads a finished `Block` tree and a relaxed `DraftBlock` tree alike. The two differ only in the
 * section rules, and the section arm reads the children of either one.
 *
 * The walk resolves nothing and it opens no file. It reports what the tree holds, and a caller decides
 * which part it needs.
 */

import { channelColumn, channelOrder, type Block, type ChartBlock, type ChartChannel, type ChartTree } from "../contracts/report-blocks.js";
import type { Reference } from "../contracts/report-reference.js";
import { holdsADriftedExponent } from "../report-render/number-format.js";
import type { DraftBlock } from "./draft.js";

/** A block of a finished report, or a block of a draft. The atoms are the same shape in both. */
export type AnyBlock = Block | DraftBlock;

/**
 * The place of one reference inside a chart block: the binding, the track, the tree of one axis, or the
 * statistic at one index of the block, for example `statistic:0`.
 */
export type ChartSlot = "binding" | "track" | TreeSlot | `statistic:${number}`;

/** The slot of the tree of one category axis of a chart. */
export type TreeSlot = "tree:x" | "tree:y";

/** The slot of the tree of one axis. */
export function treeSlot(axis: "x" | "y"): TreeSlot {
    return `tree:${axis}`;
}

/** The slot of the statistic at one index of a chart block. */
export function statisticSlot(index: number): ChartSlot {
    return `statistic:${index}`;
}

/**
 * One reference that the walk met, tied to the block that carries it.
 *
 * `slot` is present for a `chart` only, because a chart is the one kind that binds more than one reference of
 * different roles. A failure names the block and the slot, and the resolution files each value under its slot.
 *
 * `encodingColumns` is present for the binding, the track, and each tree of a `chart`. A chart names its columns
 * as free strings, thus the names must be matched against the table that the reference resolves to. Nothing
 * else can catch a chart that plots a column which does not exist. The binding carries every column that the
 * chart grammar names, and the track and each tree carry each column that they name, thus the structural tier
 * and the value tier match the same set.
 */
export interface CollectedReference {
    blockId: string;
    reference: Reference;
    slot?: ChartSlot;
    encodingColumns?: string[];
}

/** An advisory warning about the prose of one block. The detail is the numeral that the prose carries. */
export interface FreeNumeralWarning {
    blockId: string;
    kind: "free-numeral";
    detail: string;
}

/**
 * An advisory warning about one exponent form that the prose of a block carries and the page never prints.
 * The detail is the written form.
 */
export interface ExponentFormWarning {
    blockId: string;
    kind: "exponent-form";
    detail: string;
}

/** One advisory warning about the prose of a block. */
export type ProseWarning = FreeNumeralWarning | ExponentFormWarning;

/**
 * An advisory warning about one derivation that no binding of the document names. The detail is the output
 * path of the record. The record stays, and the bytes are reproducible from the script and the sources.
 */
export interface UnusedDerivationWarning {
    kind: "unused-derivation";
    detail: string;
}

/** One advisory warning about a report. A warning never makes a report invalid. */
export type ReportWarning = ProseWarning | UnusedDerivationWarning;

/** What one walk over a block tree found. */
export interface BlockWalk {
    /** Each reference, in document order, tied to the block that carries it. */
    references: CollectedReference[];
    /** Each id that more than one block holds, named one time, in sorted order. */
    repeatedIds: string[];
    /** Each free numeral and each drifted exponent form that prose carries. */
    warnings: ProseWarning[];
}

/**
 * A free-standing token that looks like a number, with an optional decimal part and an optional percent
 * sign.
 *
 * The left boundary keeps the digits of a name out of the warnings. The domain prose is dense with a
 * symbol such as `TP53`, `CD8`, or `IL6`, and without the boundary each one warns for its digits and
 * buries the real free figures.
 *
 * The check is advisory only. A natural-language numeral is brittle to police, because a numeral in prose
 * can be a real free-standing figure or a harmless part of a name. Thus a hit warns, and it never fails
 * the report.
 */
const NUMERAL_PATTERN = /(?<![A-Za-z0-9])-?\d+(?:\.\d+)?%?/g;

/**
 * A free-standing token that states a number in an exponent form, for example `4.3e-05`.
 *
 * The left boundary is the one of the numeral scan, thus a token inside a name never matches. The exponent
 * itself carries an optional sign, because a written form gives one and a shown form never does.
 */
const EXPONENT_PATTERN = /(?<![A-Za-z0-9])-?\d+(?:\.\d+)?[eE][+-]?\d+/g;

/** Warn for each free-standing numeral that the prose of one block carries. */
export function numeralWarnings(blockId: string, prose: string): FreeNumeralWarning[] {
    const warnings: FreeNumeralWarning[] = [];
    for (const match of prose.matchAll(NUMERAL_PATTERN)) {
        warnings.push({ blockId, kind: "free-numeral", detail: match[0] });
    }
    return warnings;
}

/**
 * Warn for each exponent form of one block that the page never prints.
 *
 * The page owns the notation of a value. Thus a sentence that writes a second notation of the same number
 * disagrees with the card beside it. The renderer answers which forms it prints, thus this scan states no
 * rule of its own.
 *
 * The check is advisory, exactly as the numeral scan is. A prose exponent can be a quoted threshold that no
 * cell carries, thus a hit warns and it never fails the report.
 */
export function exponentWarnings(blockId: string, prose: string): ExponentFormWarning[] {
    const warnings: ExponentFormWarning[] = [];
    for (const match of prose.matchAll(EXPONENT_PATTERN)) {
        if (holdsADriftedExponent(match[0])) {
            warnings.push({ blockId, kind: "exponent-form", detail: match[0] });
        }
    }
    return warnings;
}

/** Each advisory warning that the prose of one block carries. */
function proseWarnings(blockId: string, prose: string): ProseWarning[] {
    return [...numeralWarnings(blockId, prose), ...exponentWarnings(blockId, prose)];
}

/**
 * Each column that the grammar of one chart names.
 *
 * The quick path names its channels and its label. A composition names the channels of each series, the
 * lower bound of a band, the label of each series, the column of each rank rule, and its facet. A transform
 * rides beside its column, thus a transformed channel names the same column as a plain one. A channel that
 * sorts its categories names its sort column right after its own column.
 *
 * A name comes back one time, in the order that the grammar states it. Thus a refusal names each absent
 * column one time.
 */
function chartColumns(block: ChartBlock): string[] {
    const columns: string[] = [];
    const add = (column: string | undefined): void => {
        if (column !== undefined && !columns.includes(column)) columns.push(column);
    };
    const addChannel = (channel: ChartChannel | undefined): void => {
        if (channel === undefined) return;
        add(channelColumn(channel));
        add(channelOrder(channel)?.by);
    };

    const encoding = block.encoding;
    if (encoding !== undefined) {
        addChannel(encoding.x);
        addChannel(encoding.y);
        addChannel(encoding.group);
        addChannel(encoding.value);
        add(encoding.label);
        addChannel(encoding.color);
        addChannel(encoding.size);
        addChannel(encoding.low);
        addChannel(encoding.high);
        addChannel(encoding.facet);
        addChannel(encoding.shape);
        addChannel(encoding.p);
        addChannel(encoding.censor);
        addChannel(encoding.risk);
        addChannel(encoding.hit);
        addChannel(encoding.metric);
        for (const column of encoding.tracks ?? []) add(column);
    }

    const composition = block.composition;
    if (composition !== undefined) {
        for (const series of composition.series) {
            addChannel(series.encoding.x);
            addChannel(series.encoding.y);
            addChannel(series.encoding.y0);
            addChannel(series.encoding.group);
            add(series.encoding.label);
            addChannel(series.encoding.color);
            addChannel(series.encoding.size);
            addChannel(series.encoding.low);
            addChannel(series.encoding.high);
        }
        for (const annotation of composition.annotations ?? []) {
            if (annotation.kind === "point-labels") add(annotation.column);
        }
        addChannel(composition.facet);
    }
    return columns;
}

/** Each column of its own table that the track of a chart names: the start, the end, the label, and the length. */
function trackColumns(track: NonNullable<ChartBlock["track"]>): string[] {
    return [track.start, track.end, track.label, ...(track.length !== undefined ? [track.length] : [])];
}

/** Each column of its own table that the tree of one axis names: the parent, the child, and the height. */
function treeColumns(tree: ChartTree): string[] {
    return [tree.parent, tree.child, tree.height];
}

/**
 * The references of one chart block, in the order of the block: the binding, the track, the tree of `x`, the
 * tree of `y`, and each statistic. Each one carries its slot.
 */
function chartReferences(block: ChartBlock): CollectedReference[] {
    const references: CollectedReference[] = [{ blockId: block.id, reference: block.binding, slot: "binding", encodingColumns: chartColumns(block) }];
    if (block.track !== undefined) {
        references.push({ blockId: block.id, reference: block.track.binding, slot: "track", encodingColumns: trackColumns(block.track) });
    }
    for (const axis of ["x", "y"] as const) {
        const tree = block.trees?.[axis];
        if (tree !== undefined) {
            references.push({ blockId: block.id, reference: tree.binding, slot: treeSlot(axis), encodingColumns: treeColumns(tree) });
        }
    }
    for (const [index, statistic] of (block.statistics ?? []).entries()) {
        references.push({ blockId: block.id, reference: statistic.value, slot: statisticSlot(index) });
    }
    return references;
}

/**
 * Walk a block tree, and report each reference, each repeated id, and each free numeral.
 *
 * An id is what makes a block addressable, thus an amend by id is well defined only while each id belongs
 * to one block. The walk is pre-order, thus the references follow the document order.
 */
export function walkBlocks(blocks: readonly AnyBlock[]): BlockWalk {
    const references: CollectedReference[] = [];
    const warnings: ProseWarning[] = [];
    const seenIds = new Set<string>();
    const repeated = new Set<string>();

    const visit = (block: AnyBlock): void => {
        if (seenIds.has(block.id)) {
            repeated.add(block.id);
        } else {
            seenIds.add(block.id);
        }
        switch (block.kind) {
            case "section":
                for (const child of block.blocks) {
                    visit(child);
                }
                return;
            case "text":
                warnings.push(...proseWarnings(block.id, block.content.prose));
                // An item of a list states a point, the same as a sentence of the prose. Thus a free
                // figure inside an item carries the same honesty concern, and the walk reads both.
                for (const item of block.content.list?.items ?? []) {
                    warnings.push(...proseWarnings(block.id, item));
                }
                return;
            case "claim":
                warnings.push(...proseWarnings(block.id, block.content.prose));
                for (const binding of block.bindings) {
                    references.push({ blockId: block.id, reference: binding });
                }
                return;
            case "metric":
                references.push({ blockId: block.id, reference: block.value });
                return;
            case "chart":
                references.push(...chartReferences(block));
                return;
            case "table":
            case "figure":
            case "citation":
                references.push({ blockId: block.id, reference: block.binding });
                return;
        }
    };

    for (const block of blocks) {
        visit(block);
    }

    return { references, repeatedIds: [...repeated].sort(), warnings };
}

/**
 * Each artifact path that a set of collected references names.
 *
 * An artifact binding names one path. A derivation reference computes over two inputs, thus it names the
 * path of each input and a table that feeds a derived scalar counts as named. A citation names no path.
 *
 * The set answers one question: which files does this document use. The finish reads it against the
 * derivations of the session, and the record reads it again over the recorded document.
 */
export function referencedPaths(references: readonly CollectedReference[]): Set<string> {
    const paths = new Set<string>();
    for (const entry of references) {
        const reference = entry.reference;
        if (reference.kind === "citation") {
            continue;
        }
        if (reference.kind === "derivation") {
            for (const input of reference.inputs) {
                paths.add(input.path);
            }
            continue;
        }
        paths.add(reference.path);
    }
    return paths;
}
