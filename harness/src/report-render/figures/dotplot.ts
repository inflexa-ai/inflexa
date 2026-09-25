/**
 * The dot plot: a marker dot plot of a single-cell study, or the enrichment dot plot of a gene-set test.
 *
 * The canonical marker dot plot is the scanpy `pl.dotplot` and the Seurat `DotPlot`: the clusters down the y
 * axis, the genes along x, the fraction of expressing cells as the dot size, and the mean expression as the
 * dot color. The canonical enrichment dot plot is the enrichplot `dotplot`: the terms down the y axis, the gene
 * ratio along x, the gene count as the dot size, and the adjusted p as the dot color. Each plot shows two
 * keys: a size legend of three reference circles, and a sequential color scale with its two ends.
 *
 * The y axis reads top-down in the order of its channel, thus a table that sorts its terms by their ratio
 * reads from the first term down. The x axis draws categories where its column holds text, and values where
 * it holds numbers.
 *
 * The dots build through the composition machinery. The figure moves each dot onto the place of its category,
 * and the page builds no such move, thus the rows stay inline whatever their count.
 */

import { err, ok, type Result } from "neverthrow";

import { channelColumn, channelOrder, channelTransform, type ChartBlock, type ChartChannel, type ChartComposition } from "../../contracts/report-blocks.js";
import { declaredForColumn, type ColumnMeaning } from "../../contracts/report-reference.js";
import type { Cell, ChartRow, EchartOption } from "../chart.js";
import { CHART_BODY_PX, SEQUENTIAL_RAMP } from "../design.js";
import type { RenderProblem } from "../types.js";
import {
    categoryAxis,
    categoryAxisTitle,
    chartProblem,
    colorScale,
    orderQuickCategories,
    sizeLegend,
    toNumber,
    transformedTitle,
    withFigureBody,
    type ColumnLabels,
} from "./common.js";
import type { FigureContext, FigureModule } from "./index.js";

/** The band at the right of the plot that holds the color scale and the size legend, in percent of the width. */
const DOTPLOT_KEY_BAND = "28%";

/** The top of the color scale, and its length in pixels. The size legend sits under it. */
const DOTPLOT_SCALE_TOP = "8%";
const DOTPLOT_SCALE_LENGTH_PX = 100;

/** The place of the size legend: at the bottom right corner, under the color scale. */
const DOTPLOT_SIZE_PLACE: EchartOption = { right: 8, bottom: 8 };

/**
 * The room at each end of a value axis of dots, as a share of the axis. The largest dot sits at an end of the
 * data, and the room keeps it inside the plot.
 */
const DOTPLOT_VALUE_ROOM = ["6%", "6%"];

/**
 * The longest category name that a y label draws on one line, in characters. enrichplot wraps a term at 30
 * characters, thus a long term takes two lines and the plot keeps its width.
 */
const DOTPLOT_WRAP_CHARACTERS = 30;

/** The most lines of one term. A longer term ends its last line with an ellipsis. */
const DOTPLOT_TERM_LINES = 2;

/** The height of one line of a y label, and the gap between two terms, in pixels at the page text size. */
export const DOTPLOT_LINE_PX = 14;
export const DOTPLOT_ROW_GAP_PX = 6;

/**
 * The share of the body that the plot takes at least: the layout discipline gives the top margin and the band
 * of the turned x labels and the x title.
 */
const DOTPLOT_PLOT_SHARE = 2 / 3;

/**
 * One term wrapped at its spaces into lines of 30 characters at most, two lines at most. A term past two lines
 * ends its second line with an ellipsis, thus two terms never run into each other. A word longer than a line
 * stays whole.
 */
export function wrappedTerm(term: string): string {
    const lines: string[] = [];
    let line = "";
    for (const word of term.split(" ")) {
        if (line === "") line = word;
        else if (line.length + 1 + word.length <= DOTPLOT_WRAP_CHARACTERS) line = `${line} ${word}`;
        else {
            lines.push(line);
            line = word;
        }
    }
    if (line !== "") lines.push(line);
    if (lines.length <= DOTPLOT_TERM_LINES) return lines.join("\n");
    const kept = lines.slice(0, DOTPLOT_TERM_LINES);
    const last = kept[DOTPLOT_TERM_LINES - 1].split(" ");
    while (last.length > 1 && `${last.join(" ")}…`.length > DOTPLOT_WRAP_CHARACTERS) last.pop();
    kept[DOTPLOT_TERM_LINES - 1] = `${last.join(" ")}…`;
    return kept.join("\n");
}

/**
 * The column name that formats the ends of a transformed scale. A transform gives a number that is no p-value
 * and no count, thus its ends format as a plain number whatever the source column.
 */
const TRANSFORMED_COLUMN = "value";

/** The dot plot. */
export const DOTPLOT_FIGURE: FigureModule = {
    reads: new Set(["x", "y", "size", "color", "label"]),
    derive: deriveDotplot,
};

/** The title of a scale over one channel: the declared label or the column, inside its transform. */
function scaleTitle(labels: ColumnLabels, channel: ChartChannel): string {
    const column = channelColumn(channel);
    const base = declaredForColumn(labels, column) ?? column;
    const transform = channelTransform(channel);
    return transform === undefined ? base : transformedTitle(transform, base);
}

/**
 * The column name and the meaning that format the ends of a scale over one channel. A transformed channel
 * formats as a plain number, because its value is no p-value and no count of the source column.
 */
function formatSource(context: FigureContext, channel: ChartChannel): [string, ColumnMeaning | undefined] {
    if (channelTransform(channel) !== undefined) return [TRANSFORMED_COLUMN, undefined];
    const column = channelColumn(channel);
    return [column, declaredForColumn(context.meanings, column)];
}

/** The members of one item: the array form, or the value of the object form. */
function itemValue(item: unknown): unknown[] | undefined {
    if (Array.isArray(item)) return item;
    if (typeof item === "object" && item !== null && Array.isArray((item as EchartOption).value)) return (item as EchartOption).value as unknown[];
    return undefined;
}

/** One item with its y member set to the place of its category. */
function placedItem(item: unknown, place: number): unknown {
    const value = itemValue(item);
    if (value === undefined) return item;
    const moved = [value[0], place, ...value.slice(2)];
    return Array.isArray(item) ? moved : { ...(item as EchartOption), value: moved };
}

function deriveDotplot(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<EchartOption, RenderProblem> {
    const encoding = block.encoding ?? {};
    const { x, y, size, color, label } = encoding;
    if (x === undefined || y === undefined) {
        return err(chartProblem(block.id, `The dotplot chart needs a column for the "${x === undefined ? "x" : "y"}" channel.`));
    }
    if (size === undefined && color === undefined) {
        return err(
            chartProblem(block.id, 'The dotplot sizes its dots by a "size" channel and colors them by a "color" channel. Name one of the two at least.'),
        );
    }
    if (channelTransform(y) !== undefined) {
        return err(chartProblem(block.id, 'The "y" channel of the dotplot names categories, thus it takes no transform.'));
    }
    const yColumn = channelColumn(y);
    const categories = orderQuickCategories(block.id, rows, yColumn, channelOrder(y));
    if (categories.isErr()) return err(categories.error);

    const composition: ChartComposition = {
        series: [
            {
                form: "scatter",
                encoding: {
                    x,
                    // The figure orders the y categories itself, thus the composition reads the plain column.
                    y: yColumn,
                    ...(size !== undefined ? { size } : {}),
                    ...(color !== undefined ? { color } : {}),
                    ...(label !== undefined ? { label } : {}),
                },
            },
        ],
    };
    // The figure moves each dot onto the place of its term, thus the rows stay inline.
    const composed = context.compose(composition, { keepsRowsInline: true });
    if (composed.isErr()) return err(composed.error);
    const option = composed.value;

    const places = new Map(categories.value.map((category, place) => [String(category), place]));
    const series = (Array.isArray(option.series) ? (option.series as EchartOption[]) : []).map((entry) => ({
        ...entry,
        data: (Array.isArray(entry.data) ? entry.data : []).flatMap((item) => {
            const place = places.get(String(itemValue(item)?.[1] as Cell));
            return place === undefined ? [] : [placedItem(item, place)];
        }),
    }));

    const wraps = categories.value.some((category) => String(category).length > DOTPLOT_WRAP_CHARACTERS);
    // The series place each dot by the index of its term, thus the axis can show the wrapped text of a term.
    const terms = wraps ? categories.value.map((category) => wrappedTerm(String(category))) : undefined;
    const yAxis = {
        ...categoryAxis("y", terms ?? categories.value, { title: categoryAxisTitle(context.labels, yColumn), topDown: true }),
        ...(wraps ? { axisLabel: { lineHeight: DOTPLOT_LINE_PX } } : {}),
    };
    const lines = terms === undefined ? 1 : highestOf(terms.map((term) => term.split("\n").length));
    const body = (categories.value.length * (lines * DOTPLOT_LINE_PX + DOTPLOT_ROW_GAP_PX)) / DOTPLOT_PLOT_SHARE;

    const maps = Array.isArray(option.visualMap) ? (option.visualMap as EchartOption[]) : [];
    const keys: EchartOption[] = [];
    const graphic: EchartOption[] = [];
    const colorMap = maps.find((entry) => entry.show !== false);
    if (color !== undefined && colorMap !== undefined) {
        const values = drawnMembers(series, 2);
        const scale = { min: lowestOf(values), max: highestOf(values), ramp: SEQUENTIAL_RAMP };
        const { right: _right, top: _top, ...scaled } = colorScale(scale, scaleTitle(context.labels, color), ...formatSource(context, color));
        keys.push({ ...colorMap, ...scaled, right: 0, top: DOTPLOT_SCALE_TOP, itemHeight: DOTPLOT_SCALE_LENGTH_PX });
    }
    const sizeMaps = maps.filter((entry) => entry.show === false);
    keys.push(...sizeMaps);
    if (size !== undefined && sizeMaps.length > 0) {
        const range = { min: toNumber(sizeMaps[0].min as Cell) ?? 0, max: toNumber(sizeMaps[0].max as Cell) ?? 0 };
        graphic.push(sizeLegend(range, scaleTitle(context.labels, size), formatSource(context, size)[0], DOTPLOT_SIZE_PLACE, formatSource(context, size)[1]));
    }

    const composedX = typeof option.xAxis === "object" && option.xAxis !== null ? (option.xAxis as EchartOption) : {};
    const xAxis =
        composedX.type === "value"
            ? { ...composedX, boundaryGap: [...DOTPLOT_VALUE_ROOM], axisLabel: { ...(composedX.axisLabel as EchartOption | undefined), hideOverlap: true } }
            : composedX;
    const drawn: EchartOption = {
        ...option,
        series,
        xAxis,
        yAxis,
        visualMap: keys,
        ...(graphic.length > 0 ? { graphic } : {}),
        legend: { show: false },
        // The grid holds its labels and its titles inside the chart, as the runtime does by default.
        grid: { right: DOTPLOT_KEY_BAND },
    };
    return ok(body > CHART_BODY_PX ? withFigureBody(drawn, body) : drawn);
}

/** The members at one dimension of each item of some series. */
function drawnMembers(series: readonly EchartOption[], dimension: number): number[] {
    const members: number[] = [];
    for (const entry of series) {
        for (const item of Array.isArray(entry.data) ? entry.data : []) {
            const member = toNumber(itemValue(item)?.[dimension] as Cell | undefined);
            if (member !== null) members.push(member);
        }
    }
    return members;
}

/** The smallest of some values, or zero for none. */
function lowestOf(values: readonly number[]): number {
    let low = values.length > 0 ? values[0] : 0;
    for (const value of values) if (value < low) low = value;
    return low;
}

/** The largest of some values, or one for none. */
function highestOf(values: readonly number[]): number {
    let high = values.length > 0 ? values[0] : 1;
    for (const value of values) if (value > high) high = value;
    return high;
}
