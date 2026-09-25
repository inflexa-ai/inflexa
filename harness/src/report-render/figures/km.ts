/**
 * The Kaplan-Meier figure: one step curve for each group, the confidence band as a step band, a tick at each
 * censored row, the number-at-risk table under the plot, the median lines, and the statistics text.
 *
 * The figure plots the precomputed survival of the table, and it fits no curve. It computes two lookups from
 * the rows, and each one reads the rows of one group alone:
 *
 * - The number at risk at each tick of the time axis is the risk of the first row at or after the tick, and 0
 *   past the last row of the group. A risk table that does not sit at the axis ticks misleads, thus the figure
 *   sets the ticks itself and reads the table at them.
 * - The median of a group is the time of the first row whose survival is at or under 0.5. A curve that never
 *   reaches 0.5 has no median, and it takes no median line.
 */

import { err, ok, type Result } from "neverthrow";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import type { Cell, ChartRow, EchartOption } from "../chart.js";
import { CHART_FONT_STACK, CHART_INK, CHART_PAGE_TEXT_PX } from "../design.js";
import type { RenderProblem } from "../types.js";
import {
    categoricalPalette,
    categoryAxis,
    categoryName,
    chartProblem,
    demandedColumn,
    firstAppearance,
    GUIDE_LINE_STYLE,
    plainColumn,
    statisticsGraphic,
    toNumber,
    valueAxis,
    valueAxisTitle,
    type ChannelSource,
} from "./common.js";
import type { FigureContext, FigureMember, FigureModule } from "./index.js";

/** The members of a km block that the figure reads. */
const KM_READS: ReadonlySet<FigureMember> = new Set<FigureMember>(["x", "y", "group", "low", "high", "censor", "risk", "statistics"]);

/** The Kaplan-Meier survival figure. */
export const KM_FIGURE: FigureModule = { reads: KM_READS, derive: deriveKm };

/** The survival at which the median line sits. */
const MEDIAN_SURVIVAL = 0.5;

/**
 * The most ticks of the time axis. The step of the axis is the smallest nice step at or over the last time over
 * `MAX_TIME_TICKS - 1`, thus the span from 0 to the last time holds five steps at most.
 */
const MAX_TIME_TICKS = 6;

/** The nice steps of the time axis in one decade. */
const NICE_STEPS = [1, 2, 2.5, 5] as const;

/** The opacity of a confidence band. The curve and the band of the other group stay readable through it. */
const BAND_OPACITY = 0.2;

/** The stroke width of a survival curve, in pixels. */
const CURVE_WIDTH_PX = 1.5;

/** The size of a censor tick in pixels: a thin upright bar across the curve. */
const CENSOR_TICK_PX = [1.5, 8] as const;

/**
 * The layout of the plot and of the number-at-risk table, in percent of the chart.
 *
 * The two grids share one left edge and one right edge, thus each count sits under its tick. The axis band
 * under the plot holds the tick labels and the title of the time axis, and the header band holds the title of
 * the table. Each group takes one row of the table.
 */
const PLOT_TOP = 12;
const GRID_RIGHT = 5;
const AXIS_BAND = 14;
const HEADER_BAND = 7;
const RISK_ROW = 6;
const TABLE_BOTTOM = 3;

/** The left inset of the table title, in percent of the chart. The title sits over the group names. */
const HEADER_LEFT = 1;

/** The title of the number-at-risk table. */
const TABLE_TITLE = "Number at risk";

/**
 * The gap in pixels between a group name and the plot edge of the table. A count at the first tick centers on
 * the edge, thus the gap holds half of a count of three digits.
 */
const TABLE_NAME_GAP_PX = 16;

/**
 * The left edge of both grids, in percent of the chart: the least edge, the most edge, the pad, and the share
 * of one character of a group name.
 *
 * The share and the pad read the single journal column, the narrowest place that the figure draws in: one
 * character of the export text, and the name gap with a margin. Thus the longest group name of the table fits
 * left of the plot there.
 */
const GRID_LEFT_MIN = 10;
const GRID_LEFT_MAX = 30;
const GRID_LEFT_PAD = 7;
const NAME_CHARACTER_PCT = 1.6;

/** The columns that the channels of one km block name. */
interface KmColumns {
    readonly time: string;
    readonly survival: string;
    readonly group?: string;
    readonly low?: string;
    readonly high?: string;
    readonly censor?: string;
    readonly risk?: string;
}

/** One row of one curve, with its cells read as numbers. */
interface KmPoint {
    readonly time: number;
    readonly survival: number;
    readonly low: number | null;
    readonly high: number | null;
    readonly censor: number | null;
    readonly risk: number | null;
}

/** One group of the table: its name, and its rows in time order. */
interface KmCurve {
    readonly name: string;
    readonly points: KmPoint[];
}

/** Derive the figure of one km block. */
function deriveKm(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<EchartOption, RenderProblem> {
    const columns = kmColumns(block, rows, context);
    if (columns.isErr()) return err(columns.error);
    const curves = kmCurves(rows, columns.value, context.blockId);
    if (curves.isErr()) return err(curves.error);

    const palette = categoricalPalette(curves.value.length);
    const colorOf = (index: number): string => palette[index % palette.length];
    const end = timeEnd(curves.value);
    const step = timeStep(end);
    const ticks = timeTicks(end, step);
    const table = columns.value.risk !== undefined;
    const left = gridLeft(curves.value);
    const plotBottom = table ? TABLE_BOTTOM + curves.value.length * RISK_ROW + HEADER_BAND + AXIS_BAND : AXIS_BAND;
    const legend = curves.value.length > 1;

    const series: EchartOption[] = [];
    for (const [index, curve] of curves.value.entries()) {
        series.push(...curveSeries(curve, index, colorOf(index), columns.value));
    }
    const median = medianSeries(curves.value);
    if (median !== undefined) series.push(median);
    if (table) {
        for (const [index, curve] of curves.value.entries()) series.push(riskSeries(curve, index, ticks));
    }

    // The time axis ends at the last time of the table. A label at an end that is no tick crowds the last tick, thus it hides.
    const timeAxis = {
        ...valueAxis("x", valueAxisTitle(context.labels, columns.value.time), { min: 0, max: end }),
        interval: step,
        ...(end % step === 0 ? {} : { axisLabel: { showMaxLabel: false } }),
    };
    const survivalAxis = valueAxis("y", valueAxisTitle(context.labels, columns.value.survival), { min: 0, max: 1 });
    const plotGrid = { top: pct(PLOT_TOP), bottom: pct(plotBottom), left: pct(left), right: pct(GRID_RIGHT) };
    const graphic = [...statisticsGraphic(context.statistics, "top-right"), ...(table ? [tableTitle(curves.value.length)] : [])];
    return ok({
        legend: legend ? { top: 0 } : { show: false },
        grid: table ? [plotGrid, tableGrid(curves.value.length, left)] : plotGrid,
        xAxis: table ? [timeAxis, tableTimeAxis(end, step)] : timeAxis,
        yAxis: table ? [survivalAxis, tableGroupAxis(curves.value, colorOf)] : survivalAxis,
        series,
        ...(graphic.length > 0 ? { graphic } : {}),
    });
}

/** A number in percent of the chart. */
function pct(value: number): string {
    return `${value}%`;
}

/** The columns of one km block. The time and the survival are demanded, and each other channel is optional. */
function kmColumns(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<KmColumns, RenderProblem> {
    const encoding = block.encoding ?? {};
    const source: ChannelSource = { blockId: context.blockId, rows, columns: context.columns };
    const time = demandedColumn("km", encoding, "x", source);
    if (time.isErr()) return err(time.error);
    const survival = demandedColumn("km", encoding, "y", source);
    if (survival.isErr()) return err(survival.error);
    const optional: Record<"group" | "low" | "high" | "censor" | "risk", string | undefined> = {
        group: undefined,
        low: undefined,
        high: undefined,
        censor: undefined,
        risk: undefined,
    };
    for (const channel of ["group", "low", "high", "censor", "risk"] as const) {
        const column = plainColumn("km", encoding, channel, source);
        if (column.isErr()) return err(column.error);
        optional[channel] = column.value;
    }
    return ok({
        time: time.value,
        survival: survival.value,
        ...(optional.group !== undefined ? { group: optional.group } : {}),
        ...(optional.low !== undefined ? { low: optional.low } : {}),
        ...(optional.high !== undefined ? { high: optional.high } : {}),
        ...(optional.censor !== undefined ? { censor: optional.censor } : {}),
        ...(optional.risk !== undefined ? { risk: optional.risk } : {}),
    });
}

/**
 * The curves of one table: one for each group in the order of its first row, each in time order.
 *
 * A row whose time or survival is not numeric draws nothing. A survival outside 0 to 1 is no probability,
 * thus it refuses, because the axis holds 0 to 1 and a clip would hide the fault. A bound on the wrong side of
 * the survival refuses too. The sort is stable, thus two rows at one time keep the order of the table.
 */
function kmCurves(rows: readonly ChartRow[], columns: KmColumns, blockId: string): Result<KmCurve[], RenderProblem> {
    const groupOf = (row: ChartRow): Cell => (columns.group === undefined ? "" : (row[columns.group] ?? ""));
    const names = firstAppearance(rows.map(groupOf).map(String));
    const byName = new Map<string, KmPoint[]>(names.map((name) => [name, []]));
    for (const [index, row] of rows.entries()) {
        const time = toNumber(row[columns.time]);
        const survival = toNumber(row[columns.survival]);
        if (time === null || survival === null) continue;
        if (survival < 0 || survival > 1) {
            return err(
                chartProblem(
                    blockId,
                    `The km figure reads a survival between 0 and 1, and the row ${index + 1} holds ${survival} in the "${columns.survival}" column.`,
                ),
            );
        }
        const low = columns.low === undefined ? null : toNumber(row[columns.low]);
        const high = columns.high === undefined ? null : toNumber(row[columns.high]);
        if (low !== null && high !== null && (low > survival || high < survival)) {
            return err(
                chartProblem(
                    blockId,
                    `The row ${index + 1} holds the interval from ${low} to ${high} around the survival ${survival}. ` +
                        'The "low" bound sits at or under the survival, and the "high" bound sits at or over it.',
                ),
            );
        }
        byName.get(String(groupOf(row)))?.push({
            time,
            survival,
            low,
            high,
            censor: columns.censor === undefined ? null : toNumber(row[columns.censor]),
            risk: columns.risk === undefined ? null : toNumber(row[columns.risk]),
        });
    }
    return ok(names.map((name) => ({ name, points: (byName.get(name) ?? []).sort((a, b) => a.time - b.time) })));
}

/** The last time of the table, or 1 for a table with no time past zero. */
function timeEnd(curves: readonly KmCurve[]): number {
    let end = 0;
    for (const curve of curves) {
        for (const point of curve.points) end = Math.max(end, point.time);
    }
    return end > 0 ? end : 1;
}

/** The smallest nice step of the time axis at or over the end over `MAX_TIME_TICKS - 1`. */
function timeStep(end: number): number {
    const least = end / (MAX_TIME_TICKS - 1);
    let decade = 10 ** Math.floor(Math.log10(least));
    for (;;) {
        for (const nice of NICE_STEPS) {
            if (nice * decade >= least) return nice * decade;
        }
        decade *= 10;
    }
}

/** The ticks of the time axis: each multiple of the step from 0 to the end. */
function timeTicks(end: number, step: number): number[] {
    const ticks: number[] = [];
    for (let place = 0; place * step <= end; place += 1) ticks.push(place * step);
    return ticks;
}

/** The left edge of both grids, wide enough for the longest group name in the table column. */
function gridLeft(curves: readonly KmCurve[]): number {
    let longest = 0;
    for (const curve of curves) longest = Math.max(longest, categoryName(curve.name).length);
    return Math.min(GRID_LEFT_MAX, Math.max(GRID_LEFT_MIN, Math.ceil(GRID_LEFT_PAD + longest * NAME_CHARACTER_PCT)));
}

/**
 * The series of one curve: the step line, the two halves of the step band, and the censor ticks.
 *
 * Each series carries the name of the group, thus the legend entry of the group shows and hides all of them.
 * The band and the ticks are silent, thus the legend takes its icon from the line.
 */
function curveSeries(curve: KmCurve, index: number, color: string, columns: KmColumns): EchartOption[] {
    const name = categoryName(curve.name);
    const points = curve.points;
    const line: number[][] = points.map((point) => [point.time, point.survival]);
    if (points.length === 0 || points[0].time > 0) line.unshift([0, 1]);
    const series: EchartOption[] = [
        {
            type: "line",
            name,
            step: "end",
            showSymbol: false,
            itemStyle: { color },
            lineStyle: { color, width: CURVE_WIDTH_PX },
            z: 3,
            data: line,
        },
    ];
    if (columns.low !== undefined && columns.high !== undefined) {
        const lower: number[][] = [];
        const span: number[][] = [];
        for (const point of points) {
            if (point.low === null || point.high === null) continue;
            lower.push([point.time, point.low]);
            span.push([point.time, point.high - point.low]);
        }
        const band = {
            type: "line",
            name,
            stack: `km-band-${index}`,
            step: "end",
            showSymbol: false,
            silent: true,
            tooltip: { show: false },
            lineStyle: { opacity: 0 },
        };
        series.push({ ...band, data: lower }, { ...band, areaStyle: { color, opacity: BAND_OPACITY }, data: span });
    }
    if (columns.censor !== undefined) {
        series.push({
            type: "scatter",
            name,
            symbol: "rect",
            symbolSize: [...CENSOR_TICK_PX],
            silent: true,
            itemStyle: { color },
            z: 4,
            data: points.filter((point) => point.censor !== null && point.censor > 0).map((point) => [point.time, point.survival]),
        });
    }
    return series;
}

/** The median of one curve: the time of its first row at or under 0.5, or `undefined` where none reaches it. */
function medianOf(curve: KmCurve): number | undefined {
    return curve.points.find((point) => point.survival <= MEDIAN_SURVIVAL)?.time;
}

/**
 * The median lines as one silent series: a line at 0.5 from time 0 to the latest median, and one drop from 0.5
 * to the time axis at the median of each curve that crosses 0.5. No curve that crosses gives no series.
 */
function medianSeries(curves: readonly KmCurve[]): EchartOption | undefined {
    const medians = curves.map(medianOf).filter((median): median is number => median !== undefined);
    if (medians.length === 0) return undefined;
    const latest = Math.max(...medians);
    const lines = [
        [{ coord: [0, MEDIAN_SURVIVAL] }, { coord: [latest, MEDIAN_SURVIVAL] }],
        ...medians.map((median) => [{ coord: [median, MEDIAN_SURVIVAL] }, { coord: [median, 0] }]),
    ];
    return {
        type: "line",
        silent: true,
        tooltip: { show: false },
        data: [],
        markLine: { silent: true, symbol: "none", label: { show: false }, lineStyle: { ...GUIDE_LINE_STYLE }, data: lines },
    };
}

/** The number at risk of one curve at one tick: the risk of its first row at or after the tick, else 0. */
function riskAt(curve: KmCurve, tick: number): number {
    for (const point of curve.points) {
        if (point.time >= tick && point.risk !== null) return point.risk;
    }
    return 0;
}

/** The counts of one curve in its row of the table: one text at each tick, in the ink of the chart. */
function riskSeries(curve: KmCurve, index: number, ticks: readonly number[]): EchartOption {
    return {
        type: "scatter",
        xAxisIndex: 1,
        yAxisIndex: 1,
        silent: true,
        tooltip: { show: false },
        symbolSize: 0,
        label: { show: true, position: "inside", formatter: "{b}", color: CHART_INK },
        data: ticks.map((tick) => ({ name: String(riskAt(curve, tick)), value: [tick, index] })),
    };
}

/** The grid of the table: one row for each group at the bottom of the chart, with the left edge of the plot. */
function tableGrid(groups: number, left: number): EchartOption {
    return { bottom: pct(TABLE_BOTTOM), height: pct(groups * RISK_ROW), left: pct(left), right: pct(GRID_RIGHT) };
}

/** The title of the table: one text over the group names, at the left edge of the chart. */
function tableTitle(groups: number): EchartOption {
    return {
        type: "text",
        left: pct(HEADER_LEFT),
        bottom: pct(TABLE_BOTTOM + groups * RISK_ROW + HEADER_BAND / 4),
        silent: true,
        style: { text: TABLE_TITLE, fill: CHART_INK, fontFamily: CHART_FONT_STACK, fontSize: CHART_PAGE_TEXT_PX },
    };
}

/** The time axis of the table: the range and the ticks of the plot, with no line and no label. */
function tableTimeAxis(end: number, step: number): EchartOption {
    return {
        type: "value",
        gridIndex: 1,
        min: 0,
        max: end,
        interval: step,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: { show: false },
    };
}

/** The group axis of the table: one row for each group from the top, each name in the color of its curve. */
function tableGroupAxis(curves: readonly KmCurve[], colorOf: (index: number) => string): EchartOption {
    const names = curves.map((curve, index) => ({ value: categoryName(curve.name), textStyle: { color: colorOf(index) } }));
    return {
        ...categoryAxis("y", [], { topDown: true }),
        data: names,
        gridIndex: 1,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { margin: TABLE_NAME_GAP_PX },
        splitLine: { show: false },
    };
}
