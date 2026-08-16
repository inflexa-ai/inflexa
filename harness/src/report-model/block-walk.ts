/**
 * The one walk over a block tree.
 *
 * A block kind decides where a reference sits, which text carries a free numeral, and whether the block
 * holds children. Three consumers need that same knowledge: the mechanical validator, the draft finish,
 * and the draft operations. A switch for each consumer is a switch that a ninth block kind can miss in
 * silence, because each arm returns and none of them fails to build. Thus the walk lives here one time.
 *
 * The walk reads a finished `Block` tree and a relaxed `DraftBlock` tree alike. The two differ only in the
 * section rules, and the section arm reads the children of either one.
 *
 * The walk resolves nothing and it opens no file. It reports what the tree holds, and a caller decides
 * which part it needs.
 */

import { channelColumn, type Block, type ChartBlock, type ChartChannel } from "../contracts/report-blocks.js";
import type { Reference } from "../contracts/report-reference.js";
import type { DraftBlock } from "./draft.js";

/** A block of a finished report, or a block of a draft. The atoms are the same shape in both. */
export type AnyBlock = Block | DraftBlock;

/**
 * One reference that the walk met, tied to the block that carries it.
 *
 * `encodingColumns` is present for a `chart` only. A chart names its columns as free strings, thus the
 * names must be matched against the table that the binding resolves to. Nothing else can catch a chart
 * that plots a column which does not exist. The field carries every column that the chart grammar names,
 * thus the structural tier and the value tier match the same set.
 */
export interface CollectedReference {
    blockId: string;
    reference: Reference;
    encodingColumns?: string[];
}

/** An advisory warning about the content of one block. A warning never makes a report invalid. */
export interface ReportWarning {
    blockId: string;
    kind: "free-numeral";
    detail: string;
}

/** What one walk over a block tree found. */
export interface BlockWalk {
    /** Each reference, in document order, tied to the block that carries it. */
    references: CollectedReference[];
    /** Each id that more than one block holds, named one time, in sorted order. */
    repeatedIds: string[];
    /** Each free numeral that prose carries. */
    warnings: ReportWarning[];
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

/** Warn for each free-standing numeral that the prose of one block carries. */
export function numeralWarnings(blockId: string, prose: string): ReportWarning[] {
    const warnings: ReportWarning[] = [];
    for (const match of prose.matchAll(NUMERAL_PATTERN)) {
        warnings.push({ blockId, kind: "free-numeral", detail: match[0] });
    }
    return warnings;
}

/**
 * Each column that the grammar of one chart names.
 *
 * The quick path names its four channels and its label. A composition names the channels of each series,
 * the lower bound of a band, the label of each series, and the column of each rank rule. A transform rides
 * beside its column, thus a transformed channel names the same column as a plain one.
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
        if (channel !== undefined) add(channelColumn(channel));
    };

    const encoding = block.encoding;
    if (encoding !== undefined) {
        addChannel(encoding.x);
        addChannel(encoding.y);
        addChannel(encoding.group);
        addChannel(encoding.value);
        add(encoding.label);
    }

    const composition = block.composition;
    if (composition !== undefined) {
        for (const series of composition.series) {
            addChannel(series.encoding.x);
            addChannel(series.encoding.y);
            addChannel(series.encoding.y0);
            addChannel(series.encoding.group);
            add(series.encoding.label);
        }
        for (const annotation of composition.annotations ?? []) {
            if (annotation.kind === "point-labels") add(annotation.column);
        }
    }
    return columns;
}

/**
 * Walk a block tree, and report each reference, each repeated id, and each free numeral.
 *
 * An id is what makes a block addressable, thus an amend by id is well defined only while each id belongs
 * to one block. The walk is pre-order, thus the references follow the document order.
 */
export function walkBlocks(blocks: readonly AnyBlock[]): BlockWalk {
    const references: CollectedReference[] = [];
    const warnings: ReportWarning[] = [];
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
                warnings.push(...numeralWarnings(block.id, block.content.prose));
                // An item of a list states a point, the same as a sentence of the prose. Thus a free
                // figure inside an item carries the same honesty concern, and the walk reads both.
                for (const item of block.content.list?.items ?? []) {
                    warnings.push(...numeralWarnings(block.id, item));
                }
                return;
            case "claim":
                warnings.push(...numeralWarnings(block.id, block.content.prose));
                for (const binding of block.bindings) {
                    references.push({ blockId: block.id, reference: binding });
                }
                return;
            case "metric":
                references.push({ blockId: block.id, reference: block.value });
                return;
            case "chart":
                references.push({ blockId: block.id, reference: block.binding, encodingColumns: chartColumns(block) });
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
