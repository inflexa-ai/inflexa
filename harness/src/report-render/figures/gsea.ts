/**
 * The GSEA running enrichment score figure, as the GSEA paper (Subramanian et al. 2005, figure 1) and the
 * `gseaplot2` of enrichplot draw it: three stacked panels over one shared axis of the rank in the ordered
 * gene list.
 *
 * - The top panel draws the running score of each set, a line at zero, and a dashed mark from zero to the
 *   maximum deviation of each set, which is the enrichment score of the set.
 * - The middle panel draws one thin tick at each hit of each set, one row for each set, in the color of the
 *   set.
 * - The bottom panel draws the ranked metric as a gray area, with a line at zero.
 *
 * The panel heights keep the ratio 1.5 : 0.5 : 1 of `gseaplot2`. The statistics print inside the top panel,
 * in the corner that the curve of the first set leaves empty.
 *
 * The table holds one row for each rank of each set, thus a whole ranked list gives many thousand rows. The
 * figure adds panels around the curve, thus it keeps its rows inline, and it thins the vertices that it draws
 * (`drawnVertices`). The thinning keeps each vertex where the shape of a curve changes, thus the drawn line
 * follows the table.
 */

import { err, ok, type Result } from "neverthrow";

import { channelColumn, channelOrder, channelTransform, type ChartBlock, type ChartEncoding } from "../../contracts/report-blocks.js";
import type { Cell, ChartRow, EchartOption } from "../chart.js";
import { GUIDE_LINE_WIDTH_PX, MUTED_CHART_COLOR } from "../design.js";
import type { RenderProblem } from "../types.js";
import {
    categoricalPalette,
    categoryName,
    chartProblem,
    columnPresent,
    firstAppearance,
    guideLine,
    guideMarkLine,
    statisticsGraphic,
    toNumber,
    valueAxis,
    valueAxisTitle,
} from "./common.js";
import type { FigureContext, FigureMember, FigureModule } from "./index.js";

/**
 * The count of vertices that the thinning aims at for one curve, before it adds the vertices of shape.
 *
 * A wide page draws the rank axis over about one thousand pixels, thus one vertex for each pixel keeps the
 * drawn line as the full table draws it. Three sets and the metric then stay under the coordinate bound of the
 * SVG export.
 */
export const GSEA_STRIDE_TARGET = 1000;

/** The titles of the figure where the binding declares no label: the three titles of `gseaplot2`. */
const RANK_TITLE = "Rank in ordered dataset";
const SCORE_TITLE = "Enrichment score";
const METRIC_TITLE = "Ranked metric";

/**
 * The layout of the three panels, in percent of the chart.
 *
 * The three grids share one left edge and one right edge, thus the three panels align on the rank axis. The
 * left band holds the tick labels and the turned title of the two value axes. The bottom band holds the tick
 * labels and the title of the rank axis, and the legend under them where the figure draws more than one set.
 */
const GRID_LEFT = 12;
const GRID_RIGHT = 4;
const GRID_TOP = 4;
const AXIS_BAND = 15;
const PANEL_GAP = 2;

/**
 * The legend lists one set on each line, under the rank axis. A set name is often long, and a column export
 * cannot measure it, thus a row of names would wrap into the panels. One set on each line takes one line of
 * height whatever its width, thus the band holds a fixed share for each set.
 */
const LEGEND_LINE = 5.5;
const LEGEND_GAP_PX = 4;

/** The relative heights of the top, the middle, and the bottom panel, as `gseaplot2` gives them. */
const PANEL_SHARES = [1.5, 0.5, 1] as const;

/** The inset of the statistics text from the edges of the top panel, in percent of the chart. */
const STATISTICS_INSET = 2;

/** The share of one row of the middle panel that each tick leaves free over it and under it. */
const TICK_INSET = 0.1;

/** The stroke widths of the running score, of a hit tick, and of the edge of the metric area, in pixels. */
const SCORE_LINE_PX = 1.5;
const TICK_LINE_PX = 1;
const METRIC_LINE_PX = 0.5;

/** The members of a gsea block that the figure reads. */
const GSEA_READS: ReadonlySet<FigureMember> = new Set<FigureMember>(["x", "y", "group", "hit", "metric", "statistics"]);

/** The channels that the figure demands, and the one that it reads where the block names it. */
const DEMANDED_CHANNELS = ["x", "y", "hit", "metric"] as const;
const PLAIN_CHANNELS = ["x", "y", "group", "hit", "metric"] as const;

/** The GSEA running enrichment score figure. */
export const GSEA_FIGURE: FigureModule = { reads: GSEA_READS, derive: deriveGsea };

/** The columns that the channels of one block name. */
interface GseaColumns {
    readonly rank: string;
    readonly score: string;
    readonly hit: string;
    readonly metric: string;
    readonly set?: string;
}

/** One point of a curve: a rank and the value of the curve at that rank. */
interface Vertex {
    readonly rank: number;
    readonly value: number;
}

/** One gene set: its value in the set column, its running score in rank order, and the ranks of its hits. */
interface GseaSet {
    readonly key: string;
    readonly name: string;
    readonly score: Vertex[];
    readonly hits: number[];
}

/** The sets of one table in the order of their first row, and the ranked metric that they share. */
interface GseaTable {
    readonly sets: GseaSet[];
    readonly metric: Vertex[];
}

/** Derive the three panels of one gsea block. */
function deriveGsea(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<EchartOption, RenderProblem> {
    const columns = gseaColumns(block.encoding ?? {}, rows, context);
    if (columns.isErr()) return err(columns.error);
    const table = gseaTable(rows, columns.value, context.blockId);
    if (table.isErr()) return err(table.error);
    const { sets, metric } = table.value;

    const palette = categoricalPalette(sets.length);
    const colorOf = (index: number): string => palette[index % palette.length];
    const legendLines = sets.length > 1 ? sets.length : 0;
    const grids = panelGrids(legendLines);
    const range = rankRange(sets, metric);
    const metricTitle = valueAxisTitle(context.labels, columns.value.metric, METRIC_TITLE);

    const deviations = sets.map((set) => maximumDeviation(set.score));
    const top = sets.map((set, index) => scoreSeries(set, index, colorOf(index), deviations[index]));
    const middle = sets.map((set, index) => tickSeries(set, index, colorOf(index)));
    const bottom = metricSeries(metric, metricTitle);

    const hiddenRankAxis = (gridIndex: number): EchartOption => ({
        type: "value",
        gridIndex,
        ...range,
        axisLabel: { show: false },
        axisTick: { show: false },
        axisLine: { show: false },
    });
    const firstDeviation = deviations[0];
    const corner = firstDeviation === undefined || firstDeviation.value >= 0 ? "top-right" : "bottom-left";

    return ok({
        tooltip: { trigger: "axis" },
        axisPointer: { link: [{ xAxisIndex: "all" }] },
        grid: grids,
        xAxis: [
            hiddenRankAxis(0),
            hiddenRankAxis(1),
            { ...valueAxis("x", valueAxisTitle(context.labels, columns.value.rank, RANK_TITLE), range), gridIndex: 2 },
        ],
        yAxis: [
            { ...valueAxis("y", valueAxisTitle(context.labels, columns.value.score, SCORE_TITLE)), gridIndex: 0 },
            { type: "value", gridIndex: 1, min: 0, max: Math.max(1, sets.length), inverse: true, show: false },
            { ...valueAxis("y", metricTitle), gridIndex: 2, splitNumber: 3 },
        ],
        series: [...top, ...middle, bottom],
        graphic: statisticsText(context, grids[0], corner),
        legend:
            legendLines > 0
                ? { data: sets.map((set) => set.name), orient: "vertical", left: percent(GRID_LEFT), bottom: 0, itemGap: LEGEND_GAP_PX }
                : { show: false },
    });
}

/**
 * The columns of the channels of one block. A demanded channel that the block omits refuses, and so does a
 * channel with a transform or an order, because the figure reads each channel as it stands in the table.
 */
function gseaColumns(encoding: ChartEncoding, rows: readonly ChartRow[], context: FigureContext): Result<GseaColumns, RenderProblem> {
    for (const channel of DEMANDED_CHANNELS) {
        if (encoding[channel] === undefined) {
            return err(chartProblem(context.blockId, `The gsea figure needs a column for the "${channel}" channel.`));
        }
    }
    for (const channel of PLAIN_CHANNELS) {
        const declared = encoding[channel];
        if (declared === undefined) continue;
        if (channelTransform(declared) !== undefined || channelOrder(declared) !== undefined) {
            return err(
                chartProblem(context.blockId, `The gsea figure reads the "${channel}" channel as a plain column, thus it takes no transform and no order.`),
            );
        }
        const column = channelColumn(declared);
        if (rows.length > 0 && !columnPresent(column, rows, context.columns)) {
            return err(chartProblem(context.blockId, `The column "${column}" is absent from every row.`));
        }
    }
    const column = (channel: (typeof DEMANDED_CHANNELS)[number]): string => {
        const declared = encoding[channel];
        return declared === undefined ? "" : channelColumn(declared);
    };
    return ok({
        rank: column("x"),
        score: column("y"),
        hit: column("hit"),
        metric: column("metric"),
        ...(encoding.group !== undefined ? { set: channelColumn(encoding.group) } : {}),
    });
}

/**
 * The sets and the shared metric of one table.
 *
 * A row whose rank is not numeric draws nothing, and a row whose score or metric is not numeric draws no
 * vertex on that curve. A hit is 1 or 0, and every other hit cell refuses, because a guess would move a tick.
 * The sets of one figure share one ranked list, thus two metric values at one rank refuse. A set holds one row
 * for each rank, thus a second row at one rank of one set refuses.
 */
function gseaTable(rows: readonly ChartRow[], columns: GseaColumns, blockId: string): Result<GseaTable, RenderProblem> {
    const keys = firstAppearance(rows.map((row) => setKey(row, columns)));
    const sets = new Map<string, GseaSet & { ranks: Set<number> }>();
    for (const key of keys) {
        sets.set(key, { key, name: categoryName(key), score: [], hits: [], ranks: new Set() });
    }
    const metric = new Map<number, number>();
    for (const row of rows) {
        const rank = toNumber(row[columns.rank]);
        if (rank === null) continue;
        const set = sets.get(setKey(row, columns));
        if (set === undefined) continue;
        if (set.ranks.has(rank)) {
            return err(chartProblem(blockId, `The set "${set.name}" holds two rows at rank ${rank}. A set holds one row for each rank.`));
        }
        set.ranks.add(rank);
        const hit = hitOf(row[columns.hit]);
        if (hit === undefined) {
            return err(chartProblem(blockId, `The "hit" column "${columns.hit}" holds "${String(row[columns.hit] ?? "")}" at rank ${rank}. A hit is 1 or 0.`));
        }
        if (hit) set.hits.push(rank);
        const score = toNumber(row[columns.score]);
        if (score !== null) set.score.push({ rank, value: score });
        const value = toNumber(row[columns.metric]);
        if (value === null) continue;
        const known = metric.get(rank);
        if (known !== undefined && known !== value) {
            return err(
                chartProblem(
                    blockId,
                    `The "metric" column "${columns.metric}" holds two values at rank ${rank}. The sets of one figure share one ranked list, thus each rank holds one metric value.`,
                ),
            );
        }
        metric.set(rank, value);
    }
    const byRank = (a: Vertex, b: Vertex): number => a.rank - b.rank;
    return ok({
        sets: [...sets.values()].map(({ key, name, score, hits }) => ({ key, name, score: score.sort(byRank), hits: hits.sort((a, b) => a - b) })),
        metric: [...metric.entries()].map(([rank, value]) => ({ rank, value })).sort(byRank),
    });
}

/** The set of one row. A block with no set column draws one set. */
function setKey(row: ChartRow, columns: GseaColumns): string {
    return columns.set === undefined ? "" : String(row[columns.set] ?? "");
}

/** The hit of one cell: true for 1, false for 0, and `undefined` for every other cell. */
function hitOf(cell: Cell | undefined): boolean | undefined {
    const value = toNumber(cell);
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
}

/** The range of the rank axis: the smallest and the largest rank of the table, which the three panels share. */
function rankRange(sets: readonly GseaSet[], metric: readonly Vertex[]): { min?: number; max?: number } {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const visit = (rank: number): void => {
        if (rank < min) min = rank;
        if (rank > max) max = rank;
    };
    for (const set of sets) {
        for (const vertex of set.score) visit(vertex.rank);
        for (const rank of set.hits) visit(rank);
    }
    for (const vertex of metric) visit(vertex.rank);
    return Number.isFinite(min) ? { min, max } : {};
}

/**
 * The vertex of the largest distance from zero, which is the enrichment score of the set. The first vertex
 * of that distance answers, thus a tie gives one answer.
 */
function maximumDeviation(score: readonly Vertex[]): Vertex | undefined {
    let peak: Vertex | undefined;
    for (const vertex of score) {
        if (peak === undefined || Math.abs(vertex.value) > Math.abs(peak.value)) peak = vertex;
    }
    return peak;
}

/**
 * The vertices of one curve that the figure draws.
 *
 * A curve of `GSEA_STRIDE_TARGET` vertices or fewer draws each one. A longer curve keeps these vertices, and
 * it drops each other one:
 *
 * - the first and the last vertex
 * - each vertex at a stride of `ceil(n / GSEA_STRIDE_TARGET)` places
 * - each turn, where the curve changes from a rise to a fall or from a fall to a rise
 * - each vertex beside a crossing of zero
 * - each vertex at a rank of `kept`: each hit and the maximum deviation of a running score.
 *
 * A running score falls in a straight line between two hits and rises at each hit, thus the turns and the
 * hits hold each corner of the curve, and the line between two kept vertices covers the dropped ones.
 */
function drawnVertices(curve: readonly Vertex[], kept: ReadonlySet<number>): Vertex[] {
    const count = curve.length;
    if (count <= GSEA_STRIDE_TARGET) return [...curve];
    const stride = Math.ceil(count / GSEA_STRIDE_TARGET);
    return curve.filter(
        (vertex, index) =>
            index === 0 || index === count - 1 || index % stride === 0 || kept.has(vertex.rank) || turns(curve, index) || crossesZero(curve, index),
    );
}

/** True when the curve turns at one inner vertex. */
function turns(curve: readonly Vertex[], index: number): boolean {
    const before = curve[index].value - curve[index - 1].value;
    const after = curve[index + 1].value - curve[index].value;
    return before * after < 0;
}

/** True when the sign of the curve changes between one inner vertex and a neighbor. */
function crossesZero(curve: readonly Vertex[], index: number): boolean {
    const sign = Math.sign(curve[index].value);
    return sign !== Math.sign(curve[index - 1].value) || sign !== Math.sign(curve[index + 1].value);
}

/**
 * The running score of one set in the top panel, with its dashed mark from zero to its maximum deviation. The
 * first set also carries the line at zero.
 */
function scoreSeries(set: GseaSet, index: number, color: string, deviation: Vertex | undefined): EchartOption {
    const kept = new Set(set.hits);
    if (deviation !== undefined) kept.add(deviation.rank);
    const zero = index === 0 ? [guideLine("y", 0)] : [];
    const mark =
        deviation === undefined
            ? []
            : [
                  [
                      { coord: [deviation.rank, 0], lineStyle: { color, type: "dashed", width: GUIDE_LINE_WIDTH_PX }, label: { show: false } },
                      { coord: [deviation.rank, deviation.value] },
                  ],
              ];
    return {
        type: "line",
        name: set.name,
        xAxisIndex: 0,
        yAxisIndex: 0,
        showSymbol: false,
        symbol: "none",
        itemStyle: { color },
        lineStyle: { color, width: SCORE_LINE_PX },
        emphasis: { disabled: true },
        data: drawnVertices(set.score, kept).map((vertex) => [vertex.rank, vertex.value]),
        markLine: { ...guideMarkLine(zero), data: [...zero, ...mark] },
    };
}

/**
 * The hit ticks of one set in the middle panel: one vertical segment at each hit, inside the row of the set.
 *
 * The segments share one line series, and an empty item between two segments breaks the line. Thus each tick
 * stands alone, and it scales with the panel on the page and in the export.
 */
function tickSeries(set: GseaSet, index: number, color: string): EchartOption {
    return {
        type: "line",
        name: set.name,
        xAxisIndex: 1,
        yAxisIndex: 1,
        silent: true,
        tooltip: { show: false },
        showSymbol: false,
        symbol: "none",
        connectNulls: false,
        itemStyle: { color },
        lineStyle: { color, width: TICK_LINE_PX },
        emphasis: { disabled: true },
        data: set.hits.flatMap((rank) => [
            [rank, index + TICK_INSET],
            [rank, index + 1 - TICK_INSET],
            [rank, "-"],
        ]),
    };
}

/** The ranked metric in the bottom panel: a gray area from zero, and the line at zero. */
function metricSeries(metric: readonly Vertex[], title: string): EchartOption {
    return {
        type: "line",
        name: title,
        xAxisIndex: 2,
        yAxisIndex: 2,
        showSymbol: false,
        symbol: "none",
        itemStyle: { color: MUTED_CHART_COLOR },
        lineStyle: { color: MUTED_CHART_COLOR, width: METRIC_LINE_PX },
        areaStyle: { color: MUTED_CHART_COLOR, opacity: 1 },
        emphasis: { disabled: true },
        data: drawnVertices(metric, new Set()).map((vertex) => [vertex.rank, vertex.value]),
        markLine: guideMarkLine([guideLine("y", 0)]),
    };
}

/** The three grids: one left edge and one right edge, and the heights in the shares of `gseaplot2`. */
function panelGrids(legendLines: number): EchartOption[] {
    const shares = PANEL_SHARES[0] + PANEL_SHARES[1] + PANEL_SHARES[2];
    const legendBand = legendLines > 0 ? 1 + legendLines * LEGEND_LINE : 0;
    const room = 100 - GRID_TOP - AXIS_BAND - legendBand - PANEL_GAP * (PANEL_SHARES.length - 1);
    const grids: EchartOption[] = [];
    let top = GRID_TOP;
    for (const share of PANEL_SHARES) {
        const height = (room * share) / shares;
        grids.push({ left: percent(GRID_LEFT), right: percent(GRID_RIGHT), top: percent(top), height: percent(height) });
        top += height + PANEL_GAP;
    }
    return grids;
}

/**
 * The statistics text inside the top panel. A set that peaks above zero leaves the top right of the panel
 * empty, and a set that dips under zero leaves the bottom left empty.
 */
function statisticsText(context: FigureContext, panel: EchartOption, corner: "top-right" | "bottom-left"): EchartOption[] {
    const top = Number.parseFloat(String(panel.top));
    const height = Number.parseFloat(String(panel.height));
    return statisticsGraphic(context.statistics, corner).map((element) =>
        corner === "top-right"
            ? { ...element, right: percent(GRID_RIGHT + STATISTICS_INSET), top: percent(top + STATISTICS_INSET) }
            : { ...element, left: percent(GRID_LEFT + STATISTICS_INSET), bottom: percent(100 - top - height + STATISTICS_INSET) },
    );
}

/** One layout percentage, rounded, thus a float residue of the layout never reaches the option. */
function percent(value: number): string {
    return `${Math.round(value * 1e4) / 1e4}%`;
}
