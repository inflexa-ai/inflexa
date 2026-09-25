/**
 * The forest figure: one row for each term, top-down, with the estimate as a square, its interval as a line,
 * the line of no effect, and a text column at the right that prints each estimate with its interval, and a
 * second text column that prints the p value.
 *
 * A ratio reads on a log axis, thus the axis is logarithmic when each value is positive, and its line of no
 * effect sits at 1. A table with a value at or under zero holds differences, thus its axis is linear and the
 * line sits at 0. The log axis ends at the nice ratios just past the data and 1, thus it spans no empty decade.
 * An interval past the widest log axis ends at the axis with an arrow, as `forestplot` clips it, and its text
 * prints the bound of the table.
 */

import { err, ok, type Result } from "neverthrow";

import { channelColumn, channelOrder, channelTransform, type ChartBlock } from "../../contracts/report-blocks.js";
import type { Cell, ChartRow, EchartOption } from "../chart.js";
import { INTERVAL_RENDERER } from "../chart-renderers.js";
import { CHART_INK, CHART_PAGE_TEXT_PX, GUIDE_LINE_COLOR, GUIDE_LINE_WIDTH_PX } from "../design.js";
import { formatNumberCell, selectNumberKind, shownMinus, smallestPositiveValue, typographicExponent } from "../number-format.js";
import type { RenderProblem } from "../types.js";
import {
    categoryAxis,
    categoryAxisTitle,
    chartProblem,
    columnPresent,
    demandedColumn,
    orderCategories,
    plainColumn,
    toNumber,
    valueAxis,
    valueAxisTitle,
    type ChannelSource,
} from "./common.js";
import type { FigureContext, FigureMember, FigureModule } from "./index.js";

/** The members of a forest block that the figure reads. */
const FOREST_READS: ReadonlySet<FigureMember> = new Set<FigureMember>(["x", "y", "low", "high", "p", "size"]);

/** The forest figure of a table of ratios or differences. */
export const FOREST_FIGURE: FigureModule = { reads: FOREST_READS, derive: deriveForest };

/** The nice ratios of one decade. The ends of the log axis sit at one of them times a power of ten. */
const NICE_RATIOS = [1, 2, 2.5, 4, 5] as const;

/**
 * The widest span of the log axis, in decades. A separated covariate gives a Wald interval of many decades, and
 * an axis that holds it squeezes each other row into one narrow band.
 */
const LOG_AXIS_DECADES = 4;

/** The clip marks of an interval item: its low end, and its high end, at an end of the axis. */
const CLIPPED_LOW = 1;
const CLIPPED_HIGH = 2;

/** The side of a square in pixels where the block names no size, and the least and the most side of a sized square. */
const SQUARE_PX = 9;
const SQUARE_MIN_PX = 5;
const SQUARE_MAX_PX = 16;

/** The drawing levels of the interval line and of the square. The square covers the line through it. */
const INTERVAL_Z = 3;
const SQUARE_Z = 4;

/**
 * The width of one character of a text column as a share of the text size, and the gap in pixels between the
 * two columns. The p column sits past the widest text of the estimate column.
 */
const CHARACTER_SHARE = 0.6;
const COLUMN_GAP_PX = 16;

/** The gap in pixels between the plot and the estimate column. */
const TEXT_MARGIN_PX = 12;

/**
 * The characters of one line of the term column, and its most lines. A longer term breaks at a space onto the
 * next line, and a term past the last line ends with an ellipsis. The square of the row names the whole term in
 * its tooltip. The break counts characters, thus the column holds the same lines at each text size.
 */
const TERM_LINE_CHARACTERS = 18;
const TERM_LINES = 2;

/**
 * The decimals of a ratio from 0.1 up, as `forestplot` and the journals print it, and the magnitude under which
 * a row takes more decimals.
 */
const ESTIMATE_DECIMALS = 2;
const ESTIMATE_DECIMAL_FLOOR = 0.1;

/**
 * The magnitude under which a value of the estimate column prints as a power of ten, the same floor as the
 * compact-scientific form of a table cell. A separated covariate gives a bound such as `1.2e-150`, and no
 * fixed count of decimals holds it: `toFixed` refuses more than 100.
 */
const ESTIMATE_SCIENTIFIC_FLOOR = 1e-3;

/**
 * The edges of the chart in percent. The grid holds its tick labels, its axis names, and each text column
 * inside these edges, thus a long term and the p column both stay inside the chart.
 */
const CHART_EDGE = "2%";

/** The columns that the channels of one forest block name. */
interface ForestColumns {
    readonly term: string;
    readonly estimate: string;
    readonly low?: string;
    readonly high?: string;
    readonly p?: string;
    readonly size?: string;
}

/** One row of the figure: its term, its cells read as numbers, and the row of the table. */
interface ForestRow {
    readonly term: Cell;
    readonly estimate: number;
    readonly low: number | null;
    readonly high: number | null;
    readonly row: ChartRow;
}

/** Derive the figure of one forest block. */
function deriveForest(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<EchartOption, RenderProblem> {
    const columns = forestColumns(block, rows, context);
    if (columns.isErr()) return err(columns.error);
    const read = forestRows(rows, columns.value, context.blockId);
    if (read.isErr()) return err(read.error);
    const order = channelOrder(block.encoding?.y ?? columns.value.term);
    const ordered = orderCategories(
        context.blockId,
        read.value.length,
        (index) => read.value[index].term,
        read.value.map((entry) => entry.term),
        order,
        (index) => (order === undefined ? undefined : read.value[index].row[order.by]),
    );
    if (ordered.isErr()) return err(ordered.error);
    const byTerm = new Map(read.value.map((entry) => [String(entry.term), entry]));
    const forest = ordered.value.flatMap((term) => byTerm.get(String(term)) ?? []);

    const positive = forest.every((entry) => entry.estimate > 0 && (entry.low === null || entry.low > 0) && (entry.high === null || entry.high > 0));
    const reference = positive ? 1 : 0;
    const xTitle = valueAxisTitle(context.labels, columns.value.estimate);
    // A linear axis without `scale` holds zero in its range, thus the line of no effect always shows.
    const range = positive ? logRange(forest) : undefined;
    const xAxis = range !== undefined ? valueAxis("x", xTitle, { log: true, ...range }) : valueAxis("x", xTitle);

    const estimates = forest.map((entry) => estimateText(entry));
    const textAxes: EchartOption[] = [textAxis(estimates, xTitle, TEXT_MARGIN_PX)];
    if (columns.value.p !== undefined) {
        const pColumn = columns.value.p;
        const bound = smallestPositiveValue(forest.map((entry) => entry.row[pColumn]));
        const pTexts = forest.map((entry) => pText(entry.row[pColumn], pColumn, bound));
        textAxes.push(textAxis(pTexts, valueAxisTitle(context.labels, pColumn), TEXT_MARGIN_PX + widestText(estimates) + COLUMN_GAP_PX));
    }

    const series: EchartOption[] = [squareSeries(forest, columns.value.size, reference)];
    if (columns.value.low !== undefined && columns.value.high !== undefined) series.push(intervalSeries(forest, range));
    return ok({
        legend: { show: false },
        grid: { top: CHART_EDGE, bottom: CHART_EDGE, left: CHART_EDGE, right: CHART_EDGE, outerBoundsMode: "same", outerBoundsContain: "all" },
        xAxis,
        yAxis: [
            {
                ...categoryAxis(
                    "y",
                    forest.map((entry) => termLines(String(entry.term))),
                    { title: categoryAxisTitle(context.labels, columns.value.term), topDown: true },
                ),
                // A forest reads as a table of rows, thus the term column draws no axis line and no tick.
                axisLine: { show: false },
                axisTick: { show: false },
            },
            ...textAxes,
        ],
        series,
    });
}

/**
 * The columns of one forest block. The term and the estimate are demanded, and each other channel is
 * optional. The term channel can carry an order, because it draws the category axis. Every other channel
 * reads a plain column.
 */
function forestColumns(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<ForestColumns, RenderProblem> {
    const encoding = block.encoding ?? {};
    const source: ChannelSource = { blockId: context.blockId, rows, columns: context.columns };
    const term = encoding.y;
    if (term === undefined) return err(chartProblem(context.blockId, 'The forest figure needs a column for the "y" channel.'));
    if (channelTransform(term) !== undefined) {
        return err(chartProblem(context.blockId, 'The forest figure reads the "y" channel as a plain column, thus it takes no transform.'));
    }
    for (const column of [channelColumn(term), channelOrder(term)?.by]) {
        if (column !== undefined && rows.length > 0 && !columnPresent(column, rows, context.columns)) {
            return err(chartProblem(context.blockId, `The column "${column}" is absent from every row.`));
        }
    }
    const estimate = demandedColumn("forest", encoding, "x", source);
    if (estimate.isErr()) return err(estimate.error);
    const optional: Record<"low" | "high" | "p" | "size", string | undefined> = { low: undefined, high: undefined, p: undefined, size: undefined };
    for (const channel of ["low", "high", "p", "size"] as const) {
        const column = plainColumn("forest", encoding, channel, source);
        if (column.isErr()) return err(column.error);
        optional[channel] = column.value;
    }
    return ok({
        term: channelColumn(term),
        estimate: estimate.value,
        ...(optional.low !== undefined ? { low: optional.low } : {}),
        ...(optional.high !== undefined ? { high: optional.high } : {}),
        ...(optional.p !== undefined ? { p: optional.p } : {}),
        ...(optional.size !== undefined ? { size: optional.size } : {}),
    });
}

/**
 * The rows of the figure in table order.
 *
 * A row whose term is empty or whose estimate is not numeric draws nothing. A term names one row, thus a term
 * of two rows refuses, because its two squares would share one line. A bound on the wrong side of its
 * estimate refuses too.
 */
function forestRows(rows: readonly ChartRow[], columns: ForestColumns, blockId: string): Result<ForestRow[], RenderProblem> {
    const seen = new Set<string>();
    const forest: ForestRow[] = [];
    for (const [index, row] of rows.entries()) {
        const term = row[columns.term];
        const estimate = toNumber(row[columns.estimate]);
        if (term === undefined || String(term) === "" || estimate === null) continue;
        if (seen.has(String(term))) {
            return err(chartProblem(blockId, `The forest figure draws one row for each term, and the term "${String(term)}" holds two rows.`));
        }
        seen.add(String(term));
        const low = columns.low === undefined ? null : toNumber(row[columns.low]);
        const high = columns.high === undefined ? null : toNumber(row[columns.high]);
        if (low !== null && high !== null && (low > estimate || high < estimate)) {
            return err(
                chartProblem(
                    blockId,
                    `The row ${index + 1} holds the interval from ${low} to ${high} around the estimate ${estimate}. ` +
                        'The "low" bound sits at or under the estimate, and the "high" bound sits at or over it.',
                ),
            );
        }
        forest.push({ term, estimate, low, high, row });
    }
    return ok(forest);
}

/** The two ends of one axis. */
interface AxisRange {
    readonly min: number;
    readonly max: number;
}

/**
 * The ends of the log axis: the largest nice ratio at or under the smallest value, and the smallest nice ratio
 * at or over the largest value. Both ends reach 1, thus the line of no effect always shows.
 *
 * The axis spans `LOG_AXIS_DECADES` at most, and it always holds each estimate and 1. Where the bounds need a
 * wider axis, each side takes half of the free decades, and a side that needs less gives the rest to the other
 * side.
 */
function logRange(forest: readonly ForestRow[]): AxisRange {
    let least = 1;
    let most = 1;
    let lowest = 1;
    let highest = 1;
    for (const entry of forest) {
        least = Math.min(least, entry.estimate);
        most = Math.max(most, entry.estimate);
        for (const value of [entry.estimate, entry.low, entry.high]) {
            if (value === null) continue;
            lowest = Math.min(lowest, value);
            highest = Math.max(highest, value);
        }
    }
    const full = { min: niceRatio(lowest, "under"), max: niceRatio(highest, "over") };
    if (Math.log10(full.max / full.min) <= LOG_AXIS_DECADES) return full;
    const core = { min: niceRatio(least, "under"), max: niceRatio(most, "over") };
    const room = Math.max(0, LOG_AXIS_DECADES - Math.log10(core.max / core.min));
    const below = Math.log10(core.min / full.min);
    const above = Math.log10(full.max / core.max);
    const under = Math.min(below, Math.max(room / 2, room - above));
    const over = Math.min(above, room - under);
    return {
        min: under >= below ? full.min : niceRatio(core.min / 10 ** under, "over"),
        max: over >= above ? full.max : niceRatio(core.max * 10 ** over, "under"),
    };
}

/** The nearest nice ratio at or under, or at or over, one positive value. */
function niceRatio(value: number, side: "under" | "over"): number {
    const decade = Math.floor(Math.log10(value));
    const candidates: number[] = [];
    for (const power of [decade - 1, decade, decade + 1]) {
        for (const nice of NICE_RATIOS) candidates.push(roundRatio(nice * 10 ** power));
    }
    return side === "under"
        ? Math.max(...candidates.filter((candidate) => candidate <= value))
        : Math.min(...candidates.filter((candidate) => candidate >= value));
}

/** One nice ratio rounded to its own digits, thus `2.5 × 10^-1` reads `0.25` and never `0.25000000000000006`. */
function roundRatio(value: number): number {
    return Number(value.toPrecision(6));
}

/**
 * The shown text of one cell of the p column, as a power of ten, or the cell as it is where it is empty.
 *
 * The `p` channel names a p-value column whatever its name, thus the cell takes the kind of a p-value. A stored
 * zero prints the bound under the smallest positive p of the column, and never a bare zero.
 */
function pText(cell: Cell | undefined, column: string, bound: number | undefined): string {
    if (cell === undefined || cell === "") return "";
    return typographicExponent(formatNumberCell(cell, selectNumberKind(column, cell, "p-value"), bound).text);
}

/**
 * The text of one estimate with its interval, each value with the decimals of the row, for example
 * `0.53 (0.38–0.75)`. A negative bound joins the interval with the word `to`, because a dash beside a minus
 * reads as a range of the wrong sign. A row with no interval prints its estimate.
 */
function estimateText(entry: ForestRow): string {
    const bounds = entry.low !== null && entry.high !== null ? { low: entry.low, high: entry.high } : undefined;
    const decimals = rowDecimals(bounds === undefined ? [entry.estimate] : [entry.estimate, bounds.low, bounds.high]);
    const estimate = fixedText(entry.estimate, decimals);
    if (bounds === undefined) return estimate;
    const joint = bounds.low < 0 || bounds.high < 0 ? " to " : "–";
    return `${estimate} (${fixedText(bounds.low, decimals)}${joint}${fixedText(bounds.high, decimals)})`;
}

/**
 * The decimals of one row: two where each value that is not zero sits at 0.1 or more, else the decimals that
 * give two significant digits to the smallest value. Thus the estimate and its bounds read at one precision.
 * A value under `ESTIMATE_SCIENTIFIC_FLOOR` prints as a power of ten, thus it sets no decimals.
 */
function rowDecimals(values: readonly number[]): number {
    let least = Number.POSITIVE_INFINITY;
    for (const value of values) {
        if (Math.abs(value) >= ESTIMATE_SCIENTIFIC_FLOOR) least = Math.min(least, Math.abs(value));
    }
    return least < ESTIMATE_DECIMAL_FLOOR ? 1 - Math.floor(Math.log10(least)) : ESTIMATE_DECIMALS;
}

/**
 * One value at a fixed count of decimals, with the typographic minus. A value that rounds to zero prints no
 * sign, and a value under `ESTIMATE_SCIENTIFIC_FLOOR` that is not zero prints as a power of ten.
 */
function fixedText(value: number, decimals: number): string {
    if (value !== 0 && Math.abs(value) < ESTIMATE_SCIENTIFIC_FLOOR) return typographicExponent(formatNumberCell(value, "scientific").text);
    const text = value.toFixed(decimals);
    return Number(text) === 0 ? text.replace("-", "") : shownMinus(text);
}

/**
 * One term broken at its spaces into lines of `TERM_LINE_CHARACTERS` at most, and `TERM_LINES` lines at most.
 * A word longer than a line stays whole on its own line. A term that needs more lines keeps the first lines,
 * and its last line ends with an ellipsis.
 */
export function termLines(term: string): string {
    const lines: string[] = [];
    let line = "";
    for (const word of term.split(" ").filter((part) => part !== "")) {
        if (line === "") line = word;
        else if (line.length + 1 + word.length <= TERM_LINE_CHARACTERS) line = `${line} ${word}`;
        else {
            lines.push(line);
            line = word;
        }
    }
    if (line !== "") lines.push(line);
    if (lines.length <= TERM_LINES) return lines.join("\n");
    const kept = lines.slice(0, TERM_LINES);
    const last = kept[TERM_LINES - 1];
    kept[TERM_LINES - 1] = `${last.length < TERM_LINE_CHARACTERS ? last : last.slice(0, TERM_LINE_CHARACTERS - 1)}…`;
    return kept.join("\n");
}

/** The estimated width in pixels of the widest text of one column at the page text size. */
function widestText(texts: readonly string[]): number {
    let longest = 0;
    for (const text of texts) longest = Math.max(longest, text.length);
    return Math.ceil(longest * CHARACTER_SHARE * CHART_PAGE_TEXT_PX);
}

/**
 * One text column at the right of the plot: a category axis of the rows with the text of each row as its
 * label, and the column title over it. The axis draws no line and no tick, thus only the text shows.
 */
function textAxis(texts: readonly string[], title: string, offset: number): EchartOption {
    return {
        type: "category",
        position: "right",
        inverse: true,
        offset,
        data: [...texts],
        name: title,
        nameLocation: "start",
        nameTextStyle: { align: "left", fontWeight: "bold" },
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { align: "left", margin: 0 },
        splitLine: { show: false },
    };
}

/**
 * The squares of the estimates, with the line of no effect.
 *
 * A size channel sets the area of each square, thus the side grows with the square root of the value, and the
 * largest value takes the most side. A square too small to see takes the least side.
 */
function squareSeries(forest: readonly ForestRow[], sizeColumn: string | undefined, reference: number): EchartOption {
    let largest = 0;
    if (sizeColumn !== undefined) {
        for (const entry of forest) largest = Math.max(largest, toNumber(entry.row[sizeColumn]) ?? 0);
    }
    const sideOf = (entry: ForestRow): number => {
        if (sizeColumn === undefined || largest <= 0) return SQUARE_PX;
        const size = toNumber(entry.row[sizeColumn]);
        if (size === null || size <= 0) return SQUARE_MIN_PX;
        return Math.max(SQUARE_MIN_PX, Math.round(SQUARE_MAX_PX * Math.sqrt(size / largest)));
    };
    return {
        type: "scatter",
        symbol: "rect",
        itemStyle: { color: CHART_INK },
        z: SQUARE_Z,
        data: forest.map((entry, place) => ({ name: String(entry.term), value: [entry.estimate, place], symbolSize: sideOf(entry) })),
        markLine: {
            silent: true,
            symbol: "none",
            label: { show: false },
            lineStyle: { color: GUIDE_LINE_COLOR, width: GUIDE_LINE_WIDTH_PX, type: "solid" },
            data: [{ xAxis: reference }],
        },
    };
}

/**
 * The interval of each row as a line along the x axis, through the named interval renderer. A bound past an end
 * of `range` ends at that end, and the item marks the clipped end.
 */
function intervalSeries(forest: readonly ForestRow[], range: AxisRange | undefined): EchartOption {
    const items: number[][] = [];
    for (const [place, entry] of forest.entries()) {
        if (entry.low === null || entry.high === null) continue;
        const clipsLow = range !== undefined && entry.low < range.min;
        const clipsHigh = range !== undefined && entry.high > range.max;
        const low = clipsLow ? range.min : entry.low;
        const high = clipsHigh ? range.max : entry.high;
        items.push([entry.estimate, place, low, high, 0, 0, 0, (clipsLow ? CLIPPED_LOW : 0) + (clipsHigh ? CLIPPED_HIGH : 0)]);
    }
    return { type: "custom", renderItem: INTERVAL_RENDERER, silent: true, z: INTERVAL_Z, encode: { x: [0, 2, 3], y: 1 }, data: items };
}
