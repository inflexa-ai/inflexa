/**
 * The shared parts of the dense scatter figures: the volcano, the MA plot, the Manhattan plot, and the QQ plot.
 *
 * Each of these figures draws one point for each row of a table of many thousand rows. Thus each one builds
 * its points through the composition machinery of the context, and the points read the shared payload past
 * the inline bound. The figure then styles the series of the composition output and sets its axes. It never
 * puts a series before that output, because the page fills the leading series from their descriptors.
 */

import { err, ok, type Result } from "neverthrow";

import { channelColumn, channelTransform, type ChartChannel, type ChartEncoding, type ChartType } from "../../contracts/report-blocks.js";
import type { ChartRow, EchartOption } from "../chart.js";
import { SIZED_SERIES_MEMBER, type SizedSeries } from "../chart-renderers.js";
import { CHART_EXPORT_SIZES, CHART_INK } from "../design.js";
import { formatNumberCell } from "../number-format.js";
import type { RenderProblem } from "../types.js";
import { chartProblem, toNumber, transformColumn } from "./common.js";
import { EXPORT_PLOT_FRAMES, PAGE_PLOT_FRAME, type LeaderName, type NamedPoint, type NameFrame } from "./label-room.js";

/**
 * The symbol sizes in pixels of a dense figure: a signal point, and a point that states no finding.
 *
 * A dense cloud reads by its shape, and a large symbol fills the plot with ink. The null points draw smaller,
 * thus the signal points read first.
 */
export const DENSE_SIGNAL_SYMBOL_PX = 5;
export const DENSE_NULL_SYMBOL_PX = 3;

/** The opacity of a signal point and of a null point. A null cloud of thousands of points recedes. */
export const DENSE_SIGNAL_OPACITY = 0.85;
export const DENSE_NULL_OPACITY = 0.45;

/**
 * The drawing order of a null layer. The runtime draws a scatter at the order 2, thus a null layer at 1 draws
 * under the signal points whatever its place in the series list.
 */
export const DENSE_NULL_Z = 1;

/**
 * The symbol and the size in pixels of a point whose stored p is 0.
 *
 * A stored zero states that the true p sits under the resolution of the test, and `neg_log10` gives it no value.
 * The figure draws such a point at the top of the plotted range, and the upward triangle tells it apart from a
 * point at its true height.
 */
export const BELOW_RESOLUTION_SYMBOL = "triangle";
export const BELOW_RESOLUTION_SYMBOL_PX = 7;

/** The name and the tooltip of a series of stored zeros, where the figure gives the series no name of its own. */
export const BELOW_RESOLUTION_NAME = "p = 0";
export const BELOW_RESOLUTION_TOOLTIP: EchartOption = { formatter: "{b}<br/>{a}: p = 0" };

/**
 * The rows whose stored p is 0 and whose other coordinate draws. `others` gives the plotted value of the other
 * axis for each row.
 */
export function belowResolutionRows(rows: readonly ChartRow[], pColumn: string, others: readonly (number | null)[]): number[] {
    const found: number[] = [];
    for (let index = 0; index < rows.length; index += 1) {
        if (toNumber(rows[index][pColumn]) === 0 && others[index] !== null) found.push(index);
    }
    return found;
}

/**
 * The drawn height of a stored zero: the largest finite transformed p of the table, where it passes the line
 * of the figure, else one unit over the line. Thus a stored zero always reads as significant.
 */
export function belowResolutionHeight(peak: number | undefined, line: number): number {
    return peak !== undefined && peak > line ? peak : line + 1;
}

/** The name of the series that carries the point names of a dense figure. */
export const POINT_NAMES = "Point names";

/** The stroke width in pixels of the leader line between a point and its name. */
const LEADER_LINE_WIDTH_PX = 0.5;

/**
 * The series of the point names of a dense figure: one point with no symbol at the anchor of each name, with the
 * name as its label, and a leader line from each named point to its anchor. A name with no place draws nothing.
 *
 * The derivation places each name, because the chart runtime moves no label that sits on its point. The series
 * follows the points in the series list and keeps its rows inline, thus the points still read the shared
 * payload, and the names draw over them.
 *
 * The page frame reads a window 1280 pixels wide. On a narrower window the plot is smaller than its frame and the
 * text keeps its size, thus the runtime also hides a name that overlaps another.
 */
export function pointNameSeries(names: readonly NamedPoint[], placed: readonly (LeaderName | undefined)[]): EchartOption[] {
    const items: EchartOption[] = [];
    const leaders: Array<[EchartOption, EchartOption]> = [];
    for (const [index, name] of names.entries()) {
        const anchor = placed[index];
        if (anchor === undefined) continue;
        items.push({ name: name.text, value: [anchor.x, anchor.y], label: { position: anchor.side } });
        leaders.push([{ coord: [name.x, name.y] }, { coord: [anchor.x, anchor.y] }]);
    }
    if (items.length === 0) return [];
    return [
        {
            type: "scatter",
            name: POINT_NAMES,
            silent: true,
            symbolSize: 0,
            tooltip: { show: false },
            label: { show: true, distance: 0, color: CHART_INK, formatter: "{b}" },
            labelLayout: { hideOverlap: true },
            data: items,
            markLine: {
                silent: true,
                symbol: "none",
                label: { show: false },
                lineStyle: { color: CHART_INK, width: LEADER_LINE_WIDTH_PX, type: "solid" },
                data: leaders,
            },
        },
    ];
}

/**
 * The series of the text that a figure places itself, for the page and for each export.
 *
 * `build` places the text in one frame and gives the series that carry it. The page takes the series of the page
 * frame, and each export takes the series of the frame of its size, under its width in the member that
 * `exportOption` reads. `names` are the names of the series that `build` can give, thus an export drops each page
 * series of those names, and a size where no text finds a place draws none.
 */
export function sizedSeries(
    names: readonly string[],
    build: (frame: NameFrame) => EchartOption[],
): { readonly page: EchartOption[]; readonly member: EchartOption } {
    const widths: Record<string, EchartOption[]> = {};
    for (const [kind, size] of Object.entries(CHART_EXPORT_SIZES)) {
        widths[String(size.widthPx)] = build(EXPORT_PLOT_FRAMES[kind as keyof typeof CHART_EXPORT_SIZES]);
    }
    const sized: SizedSeries = { names, widths };
    return { page: build(PAGE_PLOT_FRAME), member: { [SIZED_SERIES_MEMBER]: sized } };
}

/** The channel of the quick path that a dense figure demands. An absent channel refuses. */
export function demandedChannel(
    blockId: string,
    chartType: ChartType,
    encoding: ChartEncoding,
    channel: "x" | "y" | "group",
): Result<ChartChannel, RenderProblem> {
    const declared = encoding[channel];
    if (declared === undefined) {
        return err(chartProblem(blockId, `The ${chartType} chart needs a column for the "${channel}" channel.`));
    }
    return ok(declared);
}

/**
 * The plotted value of one channel for each row: the transformed value where the channel declares a
 * transform, else the number of the cell. The composition reads the same numbers, thus a rule of the figure
 * and a point of the chart agree.
 */
export function plottedValues(rows: readonly ChartRow[], channel: ChartChannel): (number | null)[] {
    const column = channelColumn(channel);
    const transform = channelTransform(channel);
    return transform === undefined ? rows.map((row) => toNumber(row[column])) : transformColumn(rows, column, transform);
}

/** The round coefficients of an axis end, in ascending order. */
const ROUND_COEFFICIENTS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] as const;

/**
 * The smallest round number at or above a positive value: one of the round coefficients times a power of ten.
 * A value that is not positive gives one.
 *
 * A figure ends an axis here. The ladder is fine, thus the end leaves little empty room past the data.
 */
export function niceCeiling(value: number): number {
    if (!(value > 0)) return 1;
    const base = Math.pow(10, Math.floor(Math.log10(value)));
    const fraction = Number((value / base).toPrecision(12));
    const coefficient = ROUND_COEFFICIENTS.find((candidate) => candidate >= fraction) ?? 10;
    return Number((coefficient * base).toPrecision(12));
}

/**
 * The range fields of an axis symmetric around zero, with a tick at each end, at zero, and at each half.
 *
 * The runtime picks its own tick step, and a step that does not divide the end leaves the last tick short of
 * it. The half of the end always divides it, thus the two ends and zero carry a tick.
 */
export function symmetricRange(end: number): EchartOption {
    return { min: -end, max: end, interval: end / 2 };
}

/** The largest value of a list, or `undefined` for an empty list. The loop keeps a long list off the stack. */
export function largest(values: readonly number[]): number | undefined {
    let top: number | undefined;
    for (const value of values) {
        if (top === undefined || value > top) top = value;
    }
    return top;
}

/** The smallest value of a list, or `undefined` for an empty list. */
export function smallest(values: readonly number[]): number | undefined {
    let bottom: number | undefined;
    for (const value of values) {
        if (bottom === undefined || value < bottom) bottom = value;
    }
    return bottom;
}

/** The series of an option, as objects. */
export function seriesOf(option: EchartOption): EchartOption[] {
    const series = option.series;
    return Array.isArray(series) ? series.filter((entry): entry is EchartOption => typeof entry === "object" && entry !== null) : [];
}

/** The axis of an option as one object. A composition of one grid gives one object for each axis. */
export function axisOf(option: EchartOption, key: "xAxis" | "yAxis"): EchartOption {
    const axis = option[key];
    return typeof axis === "object" && axis !== null && !Array.isArray(axis) ? (axis as EchartOption) : {};
}

/** The fields of one layer of points: the fill, the opacity, the symbol size, and the drawing order. */
export function pointLayer(color: string, size: number, opacity: number, z?: number): EchartOption {
    return { itemStyle: { color, opacity }, symbolSize: size, ...(z !== undefined ? { z } : {}) };
}

/** The shown text of a count in a legend name: a whole number with a thousands separator. */
export function countText(count: number): string {
    return formatNumberCell(count, "compact").text;
}
