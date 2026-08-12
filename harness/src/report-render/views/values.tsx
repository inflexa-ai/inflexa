/**
 * The value markup: the metric card, the data table, the figure, and the inline citation.
 *
 * The caller resolves each value, and it narrows the value to the shape that the block needs. The runtime
 * escapes every interpolated string, thus a hostile label, a hostile cell, a hostile caption, or a
 * hostile source reaches the page as text.
 *
 * Each data card carries the `corner-accents` class. Thus the card keeps square corners with the L-shaped
 * accents, which is the geometric identity of the report.
 */

import { raw } from "hono/html";

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

/** Render a metric block as a stat card with the mono value and the mono label. */
export function renderMetric(block: MetricBlock, value: ScalarValue): string {
    return String(
        <div class="stat-card corner-accents">
            <div class="stat-card-value">{value.value}</div>
            <div class="stat-card-label">{block.label}</div>
        </div>,
    );
}

/**
 * Wrap a run of stat cards in one responsive grid. The caller renders each card first, and it passes the
 * markup as one already-escaped string, thus `raw()` inserts it byte for byte. The grid carries its own
 * stagger, thus the run reveals after the band around it.
 */
export function renderMetricGrid(cardsHtml: string): string {
    return String(
        <div class="report-metric-grid fade-in" data-delay="100">
            {raw(cardsHtml)}
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
        <div class="report-table">
            {block.title !== undefined ? <div class="report-table-title">{block.title}</div> : null}
            <div class="corner-accents">
                <div class="data-table-scroll">
                    <table class="data-table">
                        <thead>
                            <tr>
                                {columns.map((column) => (
                                    <th>{column}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {value.rows.map((row) => (
                                <tr class="report-row">
                                    {columns.map((column) => (
                                        <td>{row[column]}</td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
            {block.caption !== undefined ? <p class="report-caption">{block.caption}</p> : null}
        </div>,
    );
}

/**
 * Render a figure block as a corner-accent card. The source rides the `src` attribute, and the caption
 * renders below the image. The caption also fills the `alt` attribute, thus the escape keeps a hostile
 * source and a hostile caption inside their slots.
 */
export function renderFigure(block: FigureBlock, value: FigureValue): string {
    const caption = block.caption;
    return String(
        <figure class="report-figure corner-accents">
            <img src={value.src} alt={caption !== undefined ? caption : ""} class="report-figure-image" />
            {caption !== undefined ? <figcaption class="report-caption">{caption}</figcaption> : null}
        </figure>,
    );
}

/**
 * Render a citation block as a card in the reference form. The binding joins the ledger like a claim
 * binding, thus one shared source keeps one number. The optional note renders after the marker.
 */
export function renderCitation(block: CitationBlock, ledger: ReferenceLedger): string {
    const n = ledger.mark(block.binding);
    return String(
        <div class="report-citation corner-accents">
            <Marker n={n} />
            {block.note !== undefined ? (
                <>
                    {" "}
                    <span class="report-citation-note">{block.note}</span>
                </>
            ) : null}
        </div>,
    );
}
