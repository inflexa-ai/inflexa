/**
 * The value markup: the metric card, the data table, the figure, and the citation card.
 *
 * The citation card is the bibliography entry of its source. It carries the one link of the page body,
 * which is a navigation to PubMed, thus the page loads nothing from a remote host.
 *
 * The caller resolves each value, and it narrows the value to the shape that the block needs. The runtime
 * escapes every interpolated string, thus a hostile label, a hostile cell, a hostile caption, or a
 * hostile source reaches the page as text. The `title` attribute takes the same escape as every other
 * attribute value, thus the full digits cannot break out of their slot.
 *
 * A number reaches the page through the number format. A table cell takes the meaning that the binding
 * declares for its column, and the column name answers for a column that declares none. A metric takes its
 * label, because a value locator declares no column-wide meaning.
 *
 * A table card carries the grid mount and the download of the raw pinned bytes. The rows and the display of
 * each column ride a data asset beside the page, and the page script builds the grid over them. Thus the
 * markup carries no row, and `tableDisplay` gives the page what the server resolved for each column.
 *
 * Each card marks its binding in the shared ledger, thus every evidentiary block carries a marker and an
 * appendix entry. A reference that two blocks share keeps one number and one entry.
 *
 * Each data card carries the `corner-accents` class. Thus the card keeps square corners with the L-shaped
 * accents, which is the geometric identity of the report.
 */

import { raw } from "hono/html";

import type { CitationBlock, FigureBlock, MetricBlock, TableBlock } from "../../contracts/report-blocks.js";
import { declaredForColumn } from "../../contracts/report-reference.js";
import type { CitationRecord } from "../../report-model/reference-resolver.js";
import { stagedSource, tableSidecarName } from "../assets.js";
import { LadderMarker } from "./references-view.js";
import { formatNumberCell, formatTableCell, holdsANumber, selectColumnKind, selectNumberKind, smallestPositiveValue } from "../number-format.js";
import { citationKeyOf, type ReferenceLedger } from "../references.js";
import type { ColumnDisplay, ColumnFilter } from "../table-data.js";
import type { RenderValue } from "../types.js";

/**
 * The attribute that marks the grid mount of a table card, and that names the block of its data.
 *
 * The page script reads the same attribute, thus the card and the boot cannot disagree over a rename.
 */
export const GRID_MOUNT_ATTRIBUTE = "data-report-grid";

/**
 * The class of the print note of a table card.
 *
 * The note is empty on the screen. The page script writes the bound of a truncated print form into it at
 * print time, and it clears the text after. The page script reads the same class, thus the card and the
 * boot cannot disagree over a rename.
 */
export const GRID_NOTE_CLASS = "report-grid-note";

/**
 * The class of the row count of a table card.
 *
 * The renderer writes the count of the resolved rows, and the page script writes it again after each filter.
 * The page script reads the same class, thus the card and the boot cannot disagree over a rename.
 */
export const GRID_COUNT_CLASS = "report-table-count";

/** The word that follows a row count, in the status line of the card and in the print note alike. */
export const GRID_ROWS_WORD = "rows";

/** The label of the download button of a table card, without the format of the file. */
const DOWNLOAD_LABEL = "Download";

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
 *
 * A metric reads one cell and it has no column, thus no neighbor bounds a zero here. A zero under a
 * p-value label reads as the near-zero form.
 *
 * The value binding joins the provenance ladder, thus the label line carries the marker and the appendix
 * names the cell. The marker sits on the label and never on the value, because the value line is the one
 * figure that a reader takes from the card.
 */
export function renderMetric(block: MetricBlock, ledger: ReferenceLedger, value: ScalarValue): string {
    const mark = ledger.mark(block.value);
    const shown = formatNumberCell(value.value, selectNumberKind(block.label, value.value));
    return String(
        <div class="stat-card corner-accents">
            <div class="stat-card-value" title={shown.full}>
                {shown.text}
            </div>
            <div class="stat-card-label">
                {block.label}
                <LadderMarker mark={mark} />
            </div>
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
 *
 * The header of the card and the payload of the data asset both read this order. Thus the position of a
 * cell in an encoded row names the column of its header.
 */
export function tableColumns(value: TableValue): string[] {
    if (value.columns !== undefined) {
        return value.columns;
    }
    const first = value.rows[0];
    return first !== undefined ? Object.keys(first) : [];
}

/**
 * The header label of one column.
 *
 * A declared label names what the column measures. A column with no label prettifies, thus an underscore
 * reads as a space. The page compares the label against the raw name, and it puts the raw name on the
 * header hover where the two differ.
 */
function columnLabel(column: string, labels: TableBlock["binding"]["columnLabels"]): string {
    return declaredForColumn(labels, column) ?? column.replaceAll("_", " ");
}

/**
 * The display of each column of a table, in the column order of the header.
 *
 * The renderer resolves the label, the number kind, the filter, and the bound of a stored zero one time for
 * each column, and the data asset ships them. Thus the page formats a cell with no read of a declaration
 * and no second pass over a column.
 *
 * The filter reads the cells and not the kind. A column of gene names carries no number, thus it takes the
 * text filter and a reader finds a gene by its name. A column where one cell parses takes the number filter.
 *
 * A probability column carries the smallest positive value of its own rows as the bound. A column with no
 * positive value takes no bound, and its zero then reads as the near-zero form.
 */
export function tableDisplay(block: TableBlock, value: TableValue, columns: readonly string[]): ColumnDisplay[] {
    const binding = block.binding;
    return columns.map((column) => {
        // One pass over the column serves the filter and the bound alike, thus a wide table reads no column
        // twice.
        const cells = value.rows.map((row) => row[column]);
        const kind = selectColumnKind(column, declaredForColumn(binding.columnMeanings, column));
        const label = columnLabel(column, binding.columnLabels);
        const filter: ColumnFilter = holdsANumber(cells) ? "number" : "text";
        if (kind !== "scientific") {
            return { label, kind, filter };
        }
        const bound = smallestPositiveValue(cells);
        return bound === undefined ? { label, kind, filter } : { label, kind, filter, bound };
    });
}

/**
 * The label of the download button: the word and the format of the pinned file, for example `Download CSV`.
 *
 * The extension of the path names the format, thus the label states what the reader gets. A path with no
 * extension gives the word alone, because a made-up format would be a claim about bytes that nobody read.
 */
function downloadLabel(path: string): string {
    const base = path.slice(path.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    const format = dot > 0 ? base.slice(dot + 1).toUpperCase() : "";
    return format === "" ? DOWNLOAD_LABEL : `${DOWNLOAD_LABEL} ${format}`;
}

/**
 * The row bound of a binding as text, for example `top 20 by padj`, or `undefined` where the binding carries
 * none.
 *
 * The bound is what the resolution kept, thus the status line states it beside the count and a reader never
 * reads a cut table as the whole artifact. The rank direction names the end that the bound kept.
 */
function boundText(binding: TableBlock["binding"]): string | undefined {
    const bound = binding.rowBound;
    if (bound === undefined) {
        return undefined;
    }
    const end = bound.order === "asc" ? "lowest" : "top";
    const count = formatTableCell(bound.count, "compact-scientific");
    return `${end} ${count} by ${columnLabel(bound.column, binding.columnLabels)}`;
}

/**
 * Render a table block as the grid mount and the download of its raw bytes.
 *
 * The rows ride a data asset beside the page. A page that stamped 14,201 rows into its markup weighed
 * megabytes, and each row was a copy of the column names. Thus the markup holds one empty mount, and the
 * page script builds the grid over the payload that registers under the block id.
 *
 * The mount names its block in the mount attribute. A mount whose block the registry does not hold stays
 * empty, thus the card keeps its title, its status, and its download, and the page throws nothing.
 *
 * The footer holds one status line and the download button. The status states the count of the resolved
 * rows, and the row bound of the binding beside it. The page script writes the count again after each
 * filter, thus a reader of a narrowed table sees what the grid shows and what the table holds.
 *
 * The note under the status stays empty on the screen. A print of a table that passes the print bound writes
 * the bound into it, thus the paper states what it shows and what it leaves out.
 *
 * The download names the staged copy of the pinned artifact. The link is relative and the browser saves
 * the file, thus the page fetches nothing when it opens and the reader still gets the whole table.
 *
 * The whole-table binding joins the provenance ladder, thus the title line carries the marker and the
 * appendix names the artifact. Every evidentiary block ledgers this way, and a card with no title still
 * shows its marker on the same line.
 */
export function renderTable(block: TableBlock, ledger: ReferenceLedger, rowCount: number): string {
    const binding = block.binding;
    const mark = ledger.mark(binding);
    const download = tableSidecarName(binding.hash, binding.path);
    const bound = boundText(binding);
    return String(
        <div class="report-table">
            <div class="report-table-title">
                {block.title}
                <LadderMarker mark={mark} />
            </div>
            <div class="corner-accents">
                <div class="report-grid" {...{ [GRID_MOUNT_ATTRIBUTE]: block.id }}></div>
                <div class="report-table-footer">
                    <div class="report-table-footer-row">
                        <span class="report-table-status">
                            <span class={GRID_COUNT_CLASS}>{`${formatTableCell(rowCount, "compact-scientific")} ${GRID_ROWS_WORD}`}</span>
                            {bound !== undefined ? <span class="report-table-bound">{bound}</span> : null}
                        </span>
                        <a class="report-table-download" href={stagedSource(download)} download={download}>
                            {downloadLabel(binding.path)}
                        </a>
                    </div>
                    <div class={GRID_NOTE_CLASS}></div>
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
 *
 * The whole-file binding joins the provenance ladder, thus the caption line carries the marker and the
 * appendix names the image. A figure with no caption still shows its marker on that line. The marker stays
 * out of the `alt` text, because a screen reader reads the alt as the picture and not as a footnote.
 */
export function renderFigure(block: FigureBlock, ledger: ReferenceLedger, value: FigureValue): string {
    const mark = ledger.mark(block.binding);
    const caption = block.caption;
    return String(
        <figure class="report-figure corner-accents">
            <img src={value.src} alt={caption !== undefined ? caption : ""} class="report-figure-image" />
            <figcaption class="report-caption">
                {caption}
                <LadderMarker mark={mark} />
            </figcaption>
        </figure>,
    );
}

/**
 * The PubMed address of one identifier. The address is deterministic, and an anchor loads nothing, thus a
 * page with such a link still stands alone.
 */
const PUBMED_BASE = "https://pubmed.ncbi.nlm.nih.gov/";

/**
 * Render a citation block as a bibliography card. The binding joins the citation ladder like a claim
 * binding, thus one shared source keeps one bracket number. The card shows the marker, the short citation
 * of the pinned record, the optional note, and the citation key.
 *
 * The short citation of a `pmid:` record carries the PubMed link of its identifier. A key of another
 * identifier space shows the citation as text. A key with no pinned record shows the key and the note
 * alone, because absence is a normal condition and no text stands in for the paper.
 */
export function renderCitation(block: CitationBlock, ledger: ReferenceLedger, record?: CitationRecord): string {
    const mark = ledger.mark(block.binding);
    const binding = block.binding;
    const key = citationKeyOf(binding);
    return String(
        <div class="report-citation corner-accents">
            <LadderMarker mark={mark} />
            {record !== undefined ? (
                <>
                    {" "}
                    {binding.idKind === "pmid" ? (
                        <a class="report-citation-source" href={`${PUBMED_BASE}${encodeURIComponent(binding.id)}/`}>
                            {record.citation}
                        </a>
                    ) : (
                        <span class="report-citation-source">{record.citation}</span>
                    )}
                </>
            ) : null}
            {block.note !== undefined ? (
                <>
                    {" "}
                    <span class="report-citation-note">{block.note}</span>
                </>
            ) : null}{" "}
            <span class="report-citation-key">{key}</span>
        </div>,
    );
}
