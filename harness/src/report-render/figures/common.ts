/**
 * The shared parts of each chart: the axis builders, the guide lines, the statistics text, the color scale,
 * the size legend, the categorical palette, and the legend icons.
 *
 * The shared chart path of `chart.ts` and each figure module read these helpers, and no figure writes an axis
 * style of its own. Thus each rule of a publication figure holds in one place, and each chart of a page obeys
 * it:
 *
 * - The y title turns 90 degrees and sits in the middle beside its axis. The x title sits in the middle under
 *   its axis.
 * - A category axis shows a title only where the block declares one. A value axis always shows a title.
 * - A guide line is thin, gray, and dashed. Its label sits inside the plot at the far end of the line, thus it
 *   never covers a tick label.
 * - A continuous color scale prints its title and its two ends as static text, and it shows no drag control.
 * - Eight categories or fewer take the Okabe-Ito palette, and more take the wide palette.
 * - A legend icon matches the form of its series.
 *
 * Each helper gives plain data, because the option rides to the page as inline JSON.
 */

import { err, ok, type Result } from "neverthrow";

import { channelColumn, channelOrder, channelTransform, type ChannelOrder, type ChartEncoding, type ChartTransform } from "../../contracts/report-blocks.js";
import { declaredForColumn, type ArtifactTableReference, type ColumnMeaning } from "../../contracts/report-reference.js";
import type { Cell, ChartRow, EchartOption } from "../chart.js";
import {
    CHART_BODY_MAX_PX,
    CHART_FONT_STACK,
    CHART_INK,
    CHART_PAGE_TEXT_PX,
    CHART_PALETTE,
    CHART_WIDE_PALETTE,
    DIVERGING_RAMP,
    GUIDE_LINE_COLOR,
    GUIDE_LINE_WIDTH_PX,
    MUTED_CHART_COLOR,
    SEQUENTIAL_RAMP,
    SIZE_CHANNEL_RANGE_PX,
} from "../design.js";
import { formatNumberCell, selectNumberKind, typographicExponent } from "../number-format.js";
import { STEM_RENDERER } from "../chart-renderers.js";
import type { RenderProblem } from "../types.js";

/** The display labels that a bound table declares, keyed by the raw column name. */
export type ColumnLabels = ArtifactTableReference["columnLabels"];

/** The column meanings that a bound table declares, keyed by the raw column name. */
export type ColumnMeanings = ArtifactTableReference["columnMeanings"];

// ── The cells ───────────────────────────────────────────────────────────────

/** A typed `invalid-chart-input` problem that names the block and the cause. */
export function chartProblem(blockId: string, detail: string): RenderProblem {
    return { blockId, kind: "invalid-chart-input", detail };
}

/** Convert one cell to a finite number, or `null` when it is absent or not numeric. */
export function toNumber(cell: Cell | null | undefined): number | null {
    if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
    if (typeof cell === "string") {
        const trimmed = cell.trim();
        if (trimmed === "") return null;
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

/**
 * The legend text of one category value: the value with each underscore as a space.
 *
 * An analysis column carries a machine category such as `up_in_nonresponders`, and a legend reads for a
 * person. The replacement reads no locale, thus the same value gives the same text on every host. The raw
 * value stays in the data rows, thus the provenance loses nothing.
 */
export function categoryName(value: Cell): string {
    return String(value).replaceAll("_", " ");
}

/** The distinct values in first-appearance order. */
export function firstAppearance<T>(values: readonly T[]): T[] {
    const seen = new Set<T>();
    const order: T[] = [];
    for (const value of values) {
        if (!seen.has(value)) {
            seen.add(value);
            order.push(value);
        }
    }
    return order;
}

/** True when the column exists in the declared header, or in one row at least. */
export function columnPresent(column: string, rows: readonly Record<string, Cell>[], columns: readonly string[] | undefined): boolean {
    if (columns !== undefined && columns.includes(column)) return true;
    for (const row of rows) {
        if (Object.prototype.hasOwnProperty.call(row, column)) return true;
    }
    return false;
}

/**
 * Compare two cells for a sort by x, and for a rank rule.
 *
 * A pair that both hold a finite number compares by that number. A text-backed table gives each cell as a
 * string, thus a code-unit order would put `"10"` between `"1"` and `"2"` and a time axis would run out of
 * order. Any other pair compares by the code-unit order of the string form.
 *
 * The comparison never calls `localeCompare`, thus the order stays the same on every host.
 */
export function compareCell(a: Cell, b: Cell): number {
    const leftNumber = toNumber(a);
    const rightNumber = toNumber(b);
    if (leftNumber !== null && rightNumber !== null) {
        return leftNumber - rightNumber;
    }
    const left = String(a);
    const right = String(b);
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

/**
 * Sort the categories of one channel by the value of its order column.
 *
 * The key of a category is the cell of the order column in each row of that category, and it must be one
 * value across those rows. A category whose rows disagree has no one place, thus it refuses and names the
 * category. The compare of the sort reads two numbers as numbers and anything else as text. The sort is
 * stable and a descending order negates the compare, thus a tie keeps the first appearance in both
 * directions.
 *
 * `categoryAt` gives the category of one row, or no value for a row that draws none, and `keyAt` gives the
 * cell of the order column of one row. The categories and the rows match by their text, thus a category list
 * of strings and a column of numbers still meet. A row that lacks the order cell gives its category no place,
 * thus it refuses.
 */
export function orderCategories<T extends Cell>(
    blockId: string,
    rowCount: number,
    categoryAt: (index: number) => Cell | null | undefined,
    categories: readonly T[],
    order: ChannelOrder | undefined,
    keyAt: (index: number) => Cell | undefined,
): Result<T[], RenderProblem> {
    if (order === undefined) {
        return ok([...categories]);
    }
    const keys = new Map<string, Cell>();
    for (let index = 0; index < rowCount; index += 1) {
        const category = categoryAt(index);
        if (category === null || category === undefined) continue;
        const key = keyAt(index);
        if (key === undefined) {
            return err(
                chartProblem(
                    blockId,
                    `The category "${categoryName(category)}" holds no value in the "${order.by}" column, thus it has no place in the order.`,
                ),
            );
        }
        const held = keys.get(String(category));
        if (held === undefined) {
            keys.set(String(category), key);
        } else if (compareCell(held, key) !== 0) {
            return err(
                chartProblem(
                    blockId,
                    `The category "${categoryName(category)}" holds two values in the "${order.by}" column, thus it has no one place in the order.`,
                ),
            );
        }
    }
    const direction = order.order === "desc" ? -1 : 1;
    return ok(
        categories
            .map((category, place) => ({ category, place, key: keys.get(String(category)) ?? "" }))
            .sort((a, b) => direction * compareCell(a.key, b.key) || a.place - b.place)
            .map((entry) => entry.category),
    );
}

/**
 * Sort the categories of one quick-path channel that reads a plain column, by the order of that channel.
 * The row of each category reads the category column and the order column of the same row.
 */
export function orderQuickCategories(
    blockId: string,
    rows: readonly ChartRow[],
    column: string,
    order: ChannelOrder | undefined,
): Result<Cell[], RenderProblem> {
    return orderCategories(
        blockId,
        rows.length,
        (index) => rows[index][column],
        firstAppearance(rows.map((row) => row[column])),
        order,
        (index) => (order === undefined ? undefined : rows[index][order.by]),
    );
}

/** One channel of the quick-path encoding that names one column. */
export type ColumnChannel = Exclude<keyof ChartEncoding, "label" | "tracks">;

/** The table that a figure reads a channel from: the block, the rows, and the declared column order. */
export interface ChannelSource {
    readonly blockId: string;
    readonly rows: readonly ChartRow[];
    readonly columns?: readonly string[];
}

/**
 * The column of one channel that a figure reads as a plain column, or `undefined` where the block names no
 * such channel.
 *
 * A figure reads the cells of such a channel as they are. Thus a transform or an order on the channel would
 * do nothing, and it refuses. A column that no row holds refuses, as it does on every other chart.
 */
export function plainColumn(figure: string, encoding: ChartEncoding, channel: ColumnChannel, source: ChannelSource): Result<string | undefined, RenderProblem> {
    const declared = encoding[channel];
    if (declared === undefined) return ok(undefined);
    if (channelTransform(declared) !== undefined || channelOrder(declared) !== undefined) {
        return err(
            chartProblem(source.blockId, `The ${figure} figure reads the "${channel}" channel as a plain column, thus it takes no transform and no order.`),
        );
    }
    const column = channelColumn(declared);
    if (source.rows.length > 0 && !columnPresent(column, source.rows, source.columns)) {
        return err(chartProblem(source.blockId, `The column "${column}" is absent from every row.`));
    }
    return ok(column);
}

/** The column of one channel that a figure demands, read as a plain column. An absent channel refuses. */
export function demandedColumn(figure: string, encoding: ChartEncoding, channel: ColumnChannel, source: ChannelSource): Result<string, RenderProblem> {
    return plainColumn(figure, encoding, channel, source).andThen((column) =>
        column === undefined ? err(chartProblem(source.blockId, `The ${figure} figure needs a column for the "${channel}" channel.`)) : ok(column),
    );
}

/**
 * The transformed value of one column, one entry for each row. A row with no usable cell gives `null`.
 *
 * The page-side series build holds the twin of this function, because a chart that reads the payload
 * transforms its columns in the browser. A shared test vector runs the two over one set of cells, thus the
 * two cannot give different numbers in silence.
 */
export function transformColumn(rows: readonly ChartRow[], column: string, transform: ChartTransform): (number | null)[] {
    if (transform === "rank") {
        return rankColumn(rows, column);
    }
    return rows.map((row) => applyTransform(toNumber(row[column]), transform));
}

/**
 * One per-row transform.
 *
 * `log10` and `neg_log10` give no value for a cell that is not positive, thus the point drops. No
 * substitute value ever appears in its place.
 */
function applyTransform(value: number | null, transform: Exclude<ChartTransform, "rank">): number | null {
    if (value === null) return null;
    switch (transform) {
        case "log10":
            return value > 0 ? Math.log10(value) : null;
        case "neg_log10":
            return value > 0 ? -Math.log10(value) : null;
        case "abs":
            return Math.abs(value);
    }
}

/**
 * The competition rank of each cell of one column, over the ascending order of the column.
 *
 * The smallest value takes the place 1, and a tie shares its place. Thus the place after a tie of two
 * skips one number, which is what a competition rank states. A cell with no number takes no place, and
 * its point drops. The rank reads the column alone, thus the same rows give the same places.
 */
function rankColumn(rows: readonly ChartRow[], column: string): (number | null)[] {
    const values = rows.map((row) => toNumber(row[column]));
    const counts = new Map<number, number>();
    for (const value of values) {
        if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const places = new Map<number, number>();
    let place = 1;
    for (const value of [...counts.keys()].sort((a, b) => a - b)) {
        places.set(value, place);
        place += counts.get(value) ?? 0;
    }
    return values.map((value) => (value === null ? null : (places.get(value) ?? null)));
}

// ── The axes ────────────────────────────────────────────────────────────────

/**
 * The distance in pixels between the x axis line and its name.
 *
 * The name sits under the middle of the axis, thus the gap must clear the axis labels below the line. The
 * value is a fixed constant, thus the derivation stays deterministic.
 */
export const X_AXIS_NAME_GAP = 34;

/**
 * The distance in pixels between the tick labels of the y axis and its name.
 *
 * The chart runtime moves a name that overlaps the tick labels past them, and the gap then counts from the
 * labels. Thus a long tick label never runs under the title.
 */
export const Y_AXIS_NAME_GAP = 10;

/**
 * The name fields of one axis, or no field where the axis carries no title.
 *
 * The x title sits under the middle of the axis. The y title turns 90 degrees and sits in the middle beside
 * the axis, thus it reads along the axis and it takes no width from the plot.
 */
export function axisNameFields(axis: "x" | "y", title: string | undefined): EchartOption {
    if (title === undefined) return {};
    if (axis === "x") return { name: title, nameLocation: "middle", nameGap: X_AXIS_NAME_GAP };
    return { name: title, nameLocation: "middle", nameRotate: 90, nameGap: Y_AXIS_NAME_GAP };
}

/**
 * The title of a quantity under one per-row transform, for example `log10(Normalized count)` or
 * `−log10(Adjusted p-value)`. The minus sign is the character, not a hyphen.
 */
export function transformedTitle(transform: ChartTransform, base: string): string {
    switch (transform) {
        case "log10":
            return `log10(${base})`;
        case "neg_log10":
            return `−log10(${base})`;
        case "abs":
            return `|${base}|`;
        case "rank":
            return `rank of ${base}`;
    }
}

/**
 * The labels of a bound table with one more entry for each transformed channel whose column declares a label.
 * The derived name of the channel maps to the label inside the transform, thus an axis over the channel reads
 * `log10(Normalized count)` and never `log10(normalized_count)`. A derived name that the table declares itself
 * keeps its own label, and a column with no label keeps the derived name.
 */
export function withTransformedLabels(
    labels: ColumnLabels,
    channels: ReadonlyArray<{ readonly name: string; readonly column: string; readonly transform?: ChartTransform }>,
): ColumnLabels {
    let out = labels;
    for (const channel of channels) {
        if (channel.transform === undefined || declaredForColumn(out, channel.name) !== undefined) continue;
        const label = declaredForColumn(labels, channel.column);
        if (label !== undefined) out = { ...out, [channel.name]: transformedTitle(channel.transform, label) };
    }
    return out;
}

/**
 * The title of a value axis that reads one column, most specific first: the declared label of the column, the
 * semantic title of the preset, then the raw column name.
 *
 * A declared label answers for this one column of this one artifact, and a preset title answers for every
 * chart of its kind. Thus the label outranks the preset. The caller resolves an agent axes title over this
 * whole chain, because that title names this one axis of this one block.
 */
export function valueAxisTitle(labels: ColumnLabels, column: string, preset?: string): string {
    return declaredForColumn(labels, column) ?? preset ?? column;
}

/**
 * The title of a category axis, or `undefined` where the block declares none.
 *
 * The category names already state what the axis holds, and a raw column name such as `cluster` or `sample`
 * repeats them in machine text. Thus a category axis carries a title only where the author declared one: an
 * axes title of the block, or the label of the column.
 */
export function categoryAxisTitle(labels: ColumnLabels, column: string, declared?: string): string | undefined {
    return declared ?? declaredForColumn(labels, column);
}

/**
 * One value axis: the axis type, a fitted range where the chart asks for one, and the name fields.
 *
 * `scale` fits the range to the data, and a bar leaves it out because a bar measures from zero. `log` gives
 * the logarithmic axis type.
 */
export function valueAxis(axis: "x" | "y", title: string, fields: { scale?: boolean; log?: boolean; min?: number; max?: number } = {}): EchartOption {
    return {
        type: fields.log === true ? "log" : "value",
        ...(fields.scale === true ? { scale: true } : {}),
        ...(fields.min !== undefined ? { min: fields.min } : {}),
        ...(fields.max !== undefined ? { max: fields.max } : {}),
        ...axisNameFields(axis, title),
    };
}

/**
 * One category axis: the categories in their order, the direction, and the declared title alone.
 *
 * `topDown` inverts a y axis. The chart runtime draws the first category of a y axis at the origin, thus a
 * table that reads top-down needs the inverted axis to put its first row at the top.
 */
export function categoryAxis(axis: "x" | "y", categories: readonly Cell[], fields: { title?: string; topDown?: boolean } = {}): EchartOption {
    return {
        type: "category",
        ...(axis === "y" && fields.topDown === true ? { inverse: true } : {}),
        data: [...categories],
        ...axisNameFields(axis, fields.title),
    };
}

// ── The guide lines ─────────────────────────────────────────────────────────

/** The stroke of each guide line. */
export const GUIDE_LINE_STYLE: EchartOption = { color: GUIDE_LINE_COLOR, width: GUIDE_LINE_WIDTH_PX, type: "dashed" };

/**
 * The label place of each guide line: inside the plot, at the far end of the line.
 *
 * A vertical line ends at the top of the plot and a horizontal line ends at the right edge. Both ends lie away
 * from the tick labels, thus a guide label never covers a tick.
 */
export const GUIDE_LABEL_POSITION = "insideEndTop";

/**
 * One guide line of a mark member: a constant on one axis, and its label.
 *
 * A guide with no text shows no label. The runtime would print the constant there, and a bare number beside a
 * line reads as a plotted value.
 */
export function guideLine(axis: "x" | "y", value: number, label?: string): EchartOption {
    return {
        [axis === "x" ? "xAxis" : "yAxis"]: value,
        label: label !== undefined ? { show: true, position: GUIDE_LABEL_POSITION, formatter: label, color: CHART_INK } : { show: false },
    };
}

/** The mark member of some guide lines, in the one guide style. */
export function guideMarkLine(lines: readonly EchartOption[]): EchartOption {
    return { silent: true, symbol: "none", lineStyle: { ...GUIDE_LINE_STYLE }, data: [...lines] };
}

// ── The statistics ──────────────────────────────────────────────────────────

/**
 * One statistic that a figure prints: the label of the block, the resolved value, and the shown text of the
 * value.
 */
export interface FigureStatistic {
    readonly label: string;
    readonly value: string | number;
    readonly text: string;
}

/**
 * The shown text of one statistic, in the number format of its column, with the power of ten of a figure, and
 * the unit of its reference after it.
 *
 * The kind follows the column of the locator, as a table cell does. Thus a p-value prints in the scientific
 * form, for example `1.3 × 10⁻³`, and a stored zero of a p-value prints the below-resolution form and never a
 * bare zero. A percent sign joins its value, for example `27.5%`, and every other unit follows a space, for
 * example `426 days`.
 */
export function statisticText(value: string | number, column: string, unit?: string): string {
    const text = typographicExponent(formatNumberCell(value, selectNumberKind(column, value)).text);
    if (unit === undefined || unit.trim() === "") return text;
    return unit === "%" ? `${text}%` : `${text} ${unit}`;
}

/** The four corners of a plot where a figure prints its statistics. */
export type PlotCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** The two edges of the chart that each corner reads. */
const CORNER_SIDES: Readonly<Record<PlotCorner, { vertical: "top" | "bottom"; horizontal: "left" | "right" }>> = {
    "top-left": { vertical: "top", horizontal: "left" },
    "top-right": { vertical: "top", horizontal: "right" },
    "bottom-left": { vertical: "bottom", horizontal: "left" },
    "bottom-right": { vertical: "bottom", horizontal: "right" },
};

/**
 * The inset of a statistics text from the edge of the chart, in percent of the chart. The inset clears the
 * grid margins that the layout discipline gives, thus the text sits inside the plot.
 */
const STATISTICS_INSET: Readonly<Record<"left" | "right" | "top" | "bottom", string>> = { left: "12%", right: "7%", top: "12%", bottom: "24%" };

/**
 * The statistics of a figure as one text element inside the plot: one line for each statistic, in block
 * order, in the form `label = value`.
 *
 * A `graphic` element sits at a place of the chart and reads no data coordinate, thus the figure names the
 * corner that its field uses. A figure with no statistic gives no element.
 */
export function statisticsGraphic(statistics: readonly FigureStatistic[], corner: PlotCorner): EchartOption[] {
    if (statistics.length === 0) return [];
    const { vertical, horizontal } = CORNER_SIDES[corner];
    return [
        {
            type: "text",
            [horizontal]: STATISTICS_INSET[horizontal],
            [vertical]: STATISTICS_INSET[vertical],
            z: 100,
            silent: true,
            style: {
                text: statistics.map((statistic) => `${statistic.label} = ${statistic.text}`).join("\n"),
                fill: CHART_INK,
                fontFamily: CHART_FONT_STACK,
                fontSize: CHART_PAGE_TEXT_PX,
                align: horizontal,
            },
        },
    ];
}

/** The inset of a statistics text from its data corner, in pixels. */
export const STATISTICS_POINT_INSET_PX = 8;

/**
 * The statistics of a figure as the label of one point of no size at a corner of the data: one line for each
 * statistic, in block order, in the form `label = value`.
 *
 * A `graphic` element sits at a place of the container, and a plot whose size follows the container moves
 * away from it. A point sits in the data, thus its label stays at the corner of the plot in every container
 * and in every export. The corner names the side of the point that the text takes. The label reads the text
 * from the name of the point, thus no character of a statistic reads as a template of the chart runtime. A
 * figure with no statistic gives no series.
 */
export function statisticsSeries(statistics: readonly FigureStatistic[], point: readonly [number, number], corner: PlotCorner): EchartOption[] {
    if (statistics.length === 0) return [];
    const { vertical, horizontal } = CORNER_SIDES[corner];
    const inset = STATISTICS_POINT_INSET_PX;
    return [
        {
            type: "scatter",
            silent: true,
            symbolSize: 0,
            z: 100,
            tooltip: { show: false },
            label: {
                show: true,
                position: [0, 0],
                formatter: "{b}",
                align: horizontal,
                verticalAlign: vertical,
                offset: [horizontal === "left" ? inset : -inset, vertical === "top" ? inset : -inset],
                color: CHART_INK,
            },
            data: [{ value: [...point], name: statistics.map((statistic) => `${statistic.label} = ${statistic.text}`).join("\n") }],
        },
    ];
}

// ── The continuous color ────────────────────────────────────────────────────

/** The range and the ramp of one continuous color. */
export interface ContinuousScale {
    readonly min: number;
    readonly max: number;
    readonly ramp: readonly string[];
}

/**
 * The scale of one continuous color over its values.
 *
 * A column whose values cross zero takes the diverging ramp, centered on zero, thus a negative value and a
 * positive value of one size read as two colors of one strength. Every other column takes the sequential
 * ramp over its own range. The extent reads the values in one pass, thus a large column never spreads onto
 * the call stack.
 */
export function continuousScale(values: readonly number[]): ContinuousScale {
    if (values.length === 0) {
        return { min: 0, max: 1, ramp: SEQUENTIAL_RAMP };
    }
    let min = values[0];
    let max = values[0];
    for (const value of values) {
        if (value < min) min = value;
        if (value > max) max = value;
    }
    if (min < 0 && max > 0) {
        const reach = Math.max(-min, max);
        return { min: -reach, max: reach, ramp: DIVERGING_RAMP };
    }
    return { min, max, ramp: SEQUENTIAL_RAMP };
}

/** The shown text of one end of a scale over one column, in the number format of that column, with the power of ten of a figure. */
export function scaleEndText(end: number, column: string, meaning?: ColumnMeaning): string {
    return typographicExponent(formatNumberCell(end, selectNumberKind(column, end, meaning)).text);
}

/**
 * The members of one continuous color map: the range, the place at the right edge of the plot, the title and
 * the two ends as static text, and the ramp.
 *
 * The map shows no drag control, because a figure is a still image and a handle would print its own raw
 * value. The number helper formats each end, thus the scale and a table cell of one column read alike. The
 * title and the upper end share the top text, one line each, and the lower end sits under the bar.
 */
export function colorScale(scale: ContinuousScale, title: string, column: string, meaning?: ColumnMeaning): EchartOption {
    return {
        min: scale.min,
        max: scale.max,
        calculable: false,
        orient: "vertical",
        right: 0,
        top: "middle",
        text: [`${title}\n${scaleEndText(scale.max, column, meaning)}`, scaleEndText(scale.min, column, meaning)],
        inRange: { color: [...scale.ramp] },
    };
}

// ── The size legend ─────────────────────────────────────────────────────────

/** The gap in pixels between two reference circles of a size legend, and between a circle and its text. */
const SIZE_LEGEND_GAP_PX = 6;

/**
 * The size legend of a size channel: the title, and three reference circles with their values.
 *
 * The circles show the smallest value, the middle of the range, and the largest value, at the symbol size
 * that the size map gives each one. The number helper formats each value. The legend is one `graphic` group,
 * thus a figure places it where its field puts it. A range of one value gives one circle.
 */
export function sizeLegend(
    range: { readonly min: number; readonly max: number },
    title: string,
    column: string,
    place: EchartOption,
    meaning?: ColumnMeaning,
): EchartOption {
    const [small, large] = SIZE_CHANNEL_RANGE_PX;
    const values = range.max > range.min ? [range.min, (range.min + range.max) / 2, range.max] : [range.min];
    const children: EchartOption[] = [
        { type: "text", x: 0, y: 0, style: { text: title, fill: CHART_INK, fontFamily: CHART_FONT_STACK, fontSize: CHART_PAGE_TEXT_PX } },
    ];
    let y = CHART_PAGE_TEXT_PX + SIZE_LEGEND_GAP_PX;
    for (const value of values) {
        const diameter = range.max > range.min ? small + ((value - range.min) / (range.max - range.min)) * (large - small) : small;
        const radius = diameter / 2;
        children.push({ type: "circle", shape: { cx: large / 2, cy: y + radius, r: radius }, style: { fill: MUTED_CHART_COLOR } });
        children.push({
            type: "text",
            x: large + SIZE_LEGEND_GAP_PX,
            y: y + radius,
            style: {
                text: scaleEndText(value, column, meaning),
                fill: CHART_INK,
                fontFamily: CHART_FONT_STACK,
                fontSize: CHART_PAGE_TEXT_PX,
                verticalAlign: "middle",
            },
        });
        y += diameter + SIZE_LEGEND_GAP_PX;
    }
    return { type: "group", ...place, children };
}

// ── The palette and the legend ──────────────────────────────────────────────

/** The categorical palette of a chart that draws `count` categories. */
export function categoricalPalette(count: number): readonly string[] {
    return count <= CHART_PALETTE.length ? CHART_PALETTE : CHART_WIDE_PALETTE;
}

/** The width of one character of the chart text, and the line pitch of a legend, as a share of the text size. */
const LEGEND_CHARACTER_SHARE = 0.6;
const LEGEND_LINE_SHARE = 1.25;

/** The item gap of the legend in the theme, and the gap between an icon and its text, in pixels. */
const LEGEND_ITEM_GAP_PX = 16;
const LEGEND_ICON_GAP_PX = 5;

/**
 * The count of lines that the entries of a horizontal legend fill at one width, at one text size. An entry is
 * the icon of the text size, the gap to its text, and the text. The entries fill each line in order, one item
 * gap apart. The export estimates the lines of a legend with the same rule.
 */
export function legendLineCount(entries: readonly string[], widthPx: number, textPx: number): number {
    let lines = entries.length === 0 ? 0 : 1;
    let used = 0;
    for (const name of entries) {
        const entry = textPx + LEGEND_ICON_GAP_PX + name.length * textPx * LEGEND_CHARACTER_SHARE;
        if (used > 0 && used + LEGEND_ITEM_GAP_PX + entry > widthPx) {
            lines += 1;
            used = entry;
        } else {
            used = used > 0 ? used + LEGEND_ITEM_GAP_PX + entry : entry;
        }
    }
    return lines;
}

/** The height of one line of a legend at one text size, in pixels: the text and the item gap under it. */
export function legendLinePx(textPx: number, itemGapPx: number = LEGEND_ITEM_GAP_PX): number {
    return textPx * LEGEND_LINE_SHARE + itemGapPx;
}

/**
 * The legend icon of a line and of a step: a flat bar of eight units by one. The legend keeps the aspect of
 * the path, thus the icon draws as a short line at the width of one legend item.
 */
export const LINE_LEGEND_ICON = "path://M0,0H8V1H0Z";

/** The legend icon of a bar, an area, a box, and a shape: a filled square. */
export const AREA_LEGEND_ICON = "rect";

/** The legend icon of a point. */
export const POINT_LEGEND_ICON = "circle";

/** The legend icon of one runtime series, by its form. */
export function legendIconOf(series: EchartOption): string {
    switch (series.type) {
        case "line":
            return series.areaStyle !== undefined ? AREA_LEGEND_ICON : LINE_LEGEND_ICON;
        case "scatter":
        case "effectScatter":
            return POINT_LEGEND_ICON;
        case "custom":
            return series.renderItem === STEM_RENDERER ? POINT_LEGEND_ICON : AREA_LEGEND_ICON;
        default:
            return AREA_LEGEND_ICON;
    }
}

/** The series of an option, as objects. */
function seriesOf(option: EchartOption): EchartOption[] {
    const series = option.series;
    if (!Array.isArray(series)) return [];
    return series.filter((entry): entry is EchartOption => typeof entry === "object" && entry !== null);
}

/**
 * The icon of each series name: the form of the first series of that name that draws the data.
 *
 * A silent series of a name draws beside a series of the same name, for example the lower half of a band or
 * the interval over a bar. Thus a name takes its icon from its first series that is not silent, and from its
 * first series where every series of the name is silent.
 */
function iconsByName(option: EchartOption): Map<string, string> {
    const icons = new Map<string, string>();
    const fallback = new Map<string, string>();
    for (const series of seriesOf(option)) {
        if (typeof series.name !== "string") continue;
        if (!fallback.has(series.name)) fallback.set(series.name, legendIconOf(series));
        if (series.silent !== true && !icons.has(series.name)) icons.set(series.name, legendIconOf(series));
    }
    for (const [name, icon] of fallback) {
        if (!icons.has(name)) icons.set(name, icon);
    }
    return icons;
}

/**
 * The legend of an option with an icon on each entry that names a series.
 *
 * A legend that shows states its entries. An entry that names a series takes the icon of that series, and an
 * entry that names a data item keeps the default of the runtime. An entry that states its own icon keeps it,
 * for example the symbol of a shape beside the circle of a group. A legend that states no entries lists the
 * series names in order, as the runtime does.
 */
function iconLegend(option: EchartOption): EchartOption | undefined {
    const legend = option.legend;
    if (typeof legend !== "object" || legend === null || Array.isArray(legend)) return undefined;
    const fields = legend as EchartOption;
    if (fields.show === false) return undefined;
    const icons = iconsByName(option);
    if (icons.size === 0) return undefined;
    const declared = Array.isArray(fields.data) ? (fields.data as unknown[]) : [...icons.keys()];
    const data = declared.map((entry) => {
        if (typeof entry === "object" && entry !== null && typeof (entry as EchartOption).icon === "string") return entry;
        const name = typeof entry === "string" ? entry : typeof entry === "object" && entry !== null ? (entry as EchartOption).name : undefined;
        const icon = typeof name === "string" ? icons.get(name) : undefined;
        if (icon === undefined || typeof name !== "string") return entry;
        return typeof entry === "object" && entry !== null ? { ...(entry as EchartOption), icon } : { name, icon };
    });
    return { ...fields, data };
}

/**
 * The count of palette slots that an option draws.
 *
 * The runtime gives a series its palette color by its name, thus series of one name share one slot. A pie
 * and a radar give each data item its own slot.
 */
function paletteSlots(option: EchartOption): number {
    const names = new Set<string>();
    let items = 0;
    for (const series of seriesOf(option)) {
        if (series.type === "pie" || series.type === "radar") {
            items = Math.max(items, Array.isArray(series.data) ? series.data.length : 0);
            continue;
        }
        if (typeof series.name === "string") names.add(series.name);
    }
    return Math.max(items, names.size);
}

/**
 * One axis with its title moved off its labels, where it carries a title.
 *
 * The chart runtime moves the title of an axis past the labels that it would cover, and it measures the drawn
 * labels to do so. A grid that contains its labels turns the move off by default, thus a long category label
 * of such a grid runs under the title. The rule states the move on each titled axis of such an option, thus
 * the title clears the labels on the page and in each export.
 */
function movedTitle(axis: unknown): unknown {
    if (typeof axis !== "object" || axis === null) return axis;
    const fields = axis as EchartOption;
    return typeof fields.name === "string" && fields.name !== "" ? { ...fields, nameMoveOverlap: true } : axis;
}

/** True when a grid, or one grid of a list, contains its labels. */
function containsLabels(grid: unknown): boolean {
    const grids = Array.isArray(grid) ? grid : [grid];
    return grids.some((entry) => typeof entry === "object" && entry !== null && (entry as EchartOption).containLabel === true);
}

/** Each axis of one axis member with its title moved off its labels. */
function movedTitles(axes: unknown): unknown {
    return Array.isArray(axes) ? axes.map(movedTitle) : movedTitle(axes);
}

/**
 * The figure rules that read the whole option: the wide palette past eight categories, the icon of each
 * legend entry, and the title of each axis off its labels.
 *
 * The derivation and each figure module give an option, and this pass runs on it after the layout discipline.
 * An option that states its own palette keeps it.
 */
export function applyFigureRules(option: EchartOption): EchartOption {
    const out: EchartOption = { ...option };
    if (out.color === undefined && paletteSlots(option) > CHART_PALETTE.length) {
        out.color = [...CHART_WIDE_PALETTE];
    }
    const legend = iconLegend(option);
    if (legend !== undefined) out.legend = legend;
    if (containsLabels(out.grid)) {
        if (out.xAxis !== undefined) out.xAxis = movedTitles(out.xAxis);
        if (out.yAxis !== undefined) out.yAxis = movedTitles(out.yAxis);
    }
    return out;
}

// ── The chart body ──────────────────────────────────────────────────────────

/**
 * The option member in which a figure states the height of the page chart body that it needs, in pixels.
 *
 * A figure of many rows, for example a heatmap of many genes, needs a body taller than the default body to
 * print each row name. The chart runtime reads no such field, and the render takes the member off the option
 * before the option reaches the page or the export.
 */
export const FIGURE_BODY_MEMBER = "reportFigureBodyPx";

/** One option with the height of the chart body that its figure needs, bounded by the largest body. */
export function withFigureBody(option: EchartOption, bodyPx: number): EchartOption {
    return { ...option, [FIGURE_BODY_MEMBER]: Math.min(CHART_BODY_MAX_PX, Math.ceil(bodyPx)) };
}
