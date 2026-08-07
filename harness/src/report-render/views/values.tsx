/**
 * The value markup: the metric card, the data table, the figure, and the inline citation.
 *
 * The caller resolves each value, and it narrows the value to the shape that the block needs. The runtime
 * escapes every interpolated string, thus a hostile label, a hostile cell, a hostile caption, or a
 * hostile source reaches the page as text.
 */

import type { CitationBlock, FigureBlock, MetricBlock, TableBlock } from "../../contracts/report-blocks.js";
import { Marker } from "./references-view.js";
import type { ReferenceLedger } from "../references.js";
import type { RenderValue } from "../types.js";

/** The scalar value that a metric renders from. */
type ScalarValue = Extract<RenderValue, { type: "scalar" }>;

/** The table value that a table renders from. */
type TableValue = Extract<RenderValue, { type: "table" }>;

/** The figure value that a figure renders from. */
type FigureValue = Extract<RenderValue, { type: "figure" }>;

/** Render a metric block as a stat card with the label and the scalar value. */
export function renderMetric(block: MetricBlock, value: ScalarValue): string {
    return String(
        <div class="corner-accents border border-slate-200 bg-white p-6">
            <div class="font-mono text-3xl font-bold" style="color: #576dea;">
                {value.value}
            </div>
            <div class="font-mono text-xs font-medium text-slate-500 mt-2 uppercase tracking-wider">{block.label}</div>
        </div>,
    );
}

/**
 * The column order of a table. The value columns win when they are present. The keys of the first row
 * give the order otherwise, in first-appearance order.
 */
function tableColumns(value: TableValue): string[] {
    if (value.columns !== undefined) {
        return value.columns;
    }
    const first = value.rows[0];
    return first !== undefined ? Object.keys(first) : [];
}

/**
 * Render a table block. The header holds one cell for each column, and the body holds one row for each
 * resolved row. A zero-row table renders the header alone. The title and the caption render only when the
 * block carries one. An absent cell renders as an empty cell, thus a ragged row keeps its shape.
 */
export function renderTable(block: TableBlock, value: TableValue): string {
    const columns = tableColumns(value);
    return String(
        <div class="report-table mb-8">
            {block.title !== undefined ? (
                <div class="font-mono text-xs font-semibold uppercase tracking-widest text-primary-500 mb-3">{block.title}</div>
            ) : null}
            <div class="corner-accents border border-slate-200 bg-white overflow-hidden">
                <div class="overflow-x-auto">
                    <table class="w-full text-sm">
                        <thead>
                            <tr class="border-b border-slate-200 bg-slate-50">
                                {columns.map((column) => (
                                    <th class="px-4 py-3 text-left font-mono text-[11px] font-semibold text-slate-500 uppercase tracking-wider">{column}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {value.rows.map((row) => (
                                <tr class="report-row border-b border-slate-100 last:border-b-0">
                                    {columns.map((column) => (
                                        <td class="px-4 py-2.5 text-slate-700">{row[column]}</td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
            {block.caption !== undefined ? <p class="text-sm text-slate-400 mt-2">{block.caption}</p> : null}
        </div>,
    );
}

/**
 * Render a figure block. The source rides the `src` attribute, and the caption renders below the image.
 * The caption also fills the `alt` attribute, thus the escape keeps a hostile source and a hostile caption
 * inside their slots.
 */
export function renderFigure(block: FigureBlock, value: FigureValue): string {
    const caption = block.caption;
    return String(
        <figure class="report-figure mb-8">
            <img src={value.src} alt={caption !== undefined ? caption : ""} class="max-w-full h-auto border border-slate-200" />
            {caption !== undefined ? <figcaption class="text-sm text-slate-400 mt-2">{caption}</figcaption> : null}
        </figure>,
    );
}

/**
 * Render a citation block as a short line. The binding joins the ledger like a claim binding, thus one
 * shared source keeps one number. The optional note renders after the marker.
 */
export function renderCitation(block: CitationBlock, ledger: ReferenceLedger): string {
    const n = ledger.mark(block.binding);
    return String(
        <p class="report-citation text-sm text-slate-500">
            <Marker n={n} />
            {block.note !== undefined ? (
                <>
                    {" "}
                    <span class="text-slate-600">{block.note}</span>
                </>
            ) : null}
        </p>,
    );
}
