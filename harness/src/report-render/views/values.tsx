/**
 * The value markup: the metric card, the data table, the figure, and the inline citation.
 *
 * The caller resolves each value, and it narrows the value to the shape that the block needs. The runtime
 * escapes every interpolated string, thus a hostile label, a hostile cell, a hostile caption, or a
 * hostile source reaches the page as text. The `title` attribute takes the same escape as every other
 * attribute value, thus the full digits cannot break out of their slot.
 *
 * A number reaches the page through the number format. The name that stands over the number selects the
 * kind: the label of a metric, and the column name of a table cell.
 *
 * A table card also carries the markup of the page enhancer: the raw value of each cell, the sortable
 * header, the filter input, and the row cap with its toggle. The markup alone is a complete plain table,
 * thus the enhancer adds behavior over it and it never supplies a value.
 *
 * Each data card carries the `corner-accents` class. Thus the card keeps square corners with the L-shaped
 * accents, which is the geometric identity of the report.
 */

import { raw } from "hono/html";

import type { CitationBlock, FigureBlock, MetricBlock, TableBlock } from "../../contracts/report-blocks.js";
import { Marker } from "./references-view.js";
import { formatNumberCell, selectNumberKind } from "../number-format.js";
import type { ReferenceLedger } from "../references.js";
import type { RenderValue } from "../types.js";

/**
 * The count of table rows that the page shows before the toggle.
 *
 * The cap is a renderer constant, thus a block carries no field for it and the column subset stays the one
 * content-level choice. The page enhancer reads the same constant, thus the markup and the script bound the
 * table at one number.
 */
export const TABLE_ROW_CAP = 20;

/** The delimiter of an encoded set name, for example `HALLMARK_HYPOXIA%MSigDB%M5891`. */
const NAME_DELIMITER = "%";

/** The count of segments that an encoded set name holds: the name, the collection, and the accession. */
const NAME_SEGMENTS = 3;

/** One whitespace character. A segment of an encoded name holds none. */
const WHITESPACE = /\s/;

/**
 * The collapsed label of the row-cap toggle.
 *
 * The view composes the label at render, and the enhancer composes it again from the count that the filter
 * keeps. Both read this one prefix, thus the two labels cannot drift apart.
 */
export const SHOW_ALL_PREFIX = "Show all ";

/** The scalar value that a metric renders from. */
type ScalarValue = Extract<RenderValue, { type: "scalar" }>;

/** The table value that a table renders from. */
type TableValue = Extract<RenderValue, { type: "table" }>;

/** The figure value that a figure renders from. */
type FigureValue = Extract<RenderValue, { type: "figure" }>;

/**
 * Render a metric block as a stat card with the mono value and the mono label.
 *
 * The label names the value, thus it selects the number kind. The full digits ride the `title` attribute
 * when the shown form hides one, and no attribute appears at any other time.
 */
export function renderMetric(block: MetricBlock, value: ScalarValue): string {
    const shown = formatNumberCell(value.value, selectNumberKind(block.label, value.value));
    return String(
        <div class="stat-card corner-accents">
            <div class="stat-card-value" title={shown.full}>
                {shown.text}
            </div>
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
 * The first segment of a delimited name, or `undefined` when the text carries no delimited name.
 *
 * An enrichment tool joins the name of a set, its collection, and its accession with a percent sign. The
 * name alone identifies the row, thus the rest is noise inside a narrow column.
 *
 * Such a name holds three or more segments, each segment holds a character, and no segment holds a
 * whitespace character. Every other text keeps its whole form. Thus `95%` stays whole, and a sentence such
 * as `up 20% vs control` stays whole.
 */
function firstNameSegment(text: string): string | undefined {
    const segments = text.split(NAME_DELIMITER);
    if (segments.length < NAME_SEGMENTS) {
        return undefined;
    }
    const encoded = segments.every((segment) => segment.length > 0 && !WHITESPACE.test(segment));
    return encoded ? segments[0] : undefined;
}

/**
 * One body cell of a table.
 *
 * The column name selects the number kind, thus a p-value column reads in the scientific form. The full
 * digits ride the `title` attribute when the shown form hides one. An absent cell renders as an empty
 * cell, thus a ragged row keeps its shape.
 *
 * Each cell carries its raw value in the `data-value` attribute. The page enhancer sorts on that value, thus
 * the shown text stays presentation and a rounded number still sorts by its full magnitude.
 *
 * A delimited name shows its first segment, and the whole name rides the `title` attribute. Such a name
 * holds no finite number, thus the number format passed it through and this trim reads the text that the
 * format gave.
 */
function Cell({ column, cell }: { column: string; cell: string | number | undefined }) {
    if (cell === undefined) {
        return <td data-value=""></td>;
    }
    const shown = formatNumberCell(cell, selectNumberKind(column, cell));
    const segment = firstNameSegment(shown.text);
    if (segment !== undefined) {
        return (
            <td data-value={String(cell)} title={shown.text}>
                {segment}
            </td>
        );
    }
    return (
        <td data-value={String(cell)} title={shown.full}>
            {shown.text}
        </td>
    );
}

/**
 * Render a table block. The header holds one cell for each column, and the body holds one row for each
 * resolved row. A zero-row table renders the header alone. The title and the caption render only when the
 * block carries one.
 *
 * Each header cell stays a plain `th`. It carries the sort class and the index of its column, thus the
 * enhancer reads the column of a click and a browser with no script keeps a plain header. The header also
 * takes the tab order, thus a reader sorts the table from the keyboard.
 *
 * The body holds every resolved row. A row past the cap carries the hidden class, and the card then carries
 * the toggle that names the total count. A table at the cap or under it carries no hidden row and no toggle.
 * The hidden class hides a row under the live marker of the enhancer alone, thus a browser with no script
 * shows every row. The label of the toggle names the total, and the enhancer composes the same label again
 * from the count that the filter keeps.
 */
export function renderTable(block: TableBlock, value: TableValue): string {
    const columns = tableColumns(value);
    const total = value.rows.length;
    return String(
        <div class="report-table">
            {block.title !== undefined ? <div class="report-table-title">{block.title}</div> : null}
            <div class="corner-accents">
                <div class="report-table-controls">
                    <input class="report-table-filter" type="text" placeholder="Filter rows" aria-label="Filter rows" />
                </div>
                <div class="data-table-scroll">
                    <table class="data-table">
                        <thead>
                            <tr>
                                {columns.map((column, index) => (
                                    <th class="data-table-sort" data-sort-index={String(index)} tabindex={0}>
                                        {column}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {value.rows.map((row, index) => (
                                <tr class={index < TABLE_ROW_CAP ? "report-row" : "report-row report-row-hidden"}>
                                    {columns.map((column) => (
                                        <Cell column={column} cell={row[column]} />
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
                {total > TABLE_ROW_CAP ? <button type="button" class="report-table-toggle">{`${SHOW_ALL_PREFIX}${total}`}</button> : null}
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
