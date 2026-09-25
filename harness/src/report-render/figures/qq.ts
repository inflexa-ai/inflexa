/**
 * The QQ figure of a GWAS, as qqman and the GWAS quality-control tools draw it: the expected −log10(p) on x,
 * the observed −log10(p) on y, and the diagonal where the two agree under the null.
 *
 * - The points draw small, in the ink of the page.
 * - The band between the `low` and the `high` columns draws in light gray under the points. It states the
 *   confidence band of the null expectation that the run computed.
 * - An identity line runs from zero to the largest expected value, where the null expectation ends.
 * - Each axis spans from zero to its own round end, as qqman draws it: x to the largest expected value, and y
 *   to the largest observed value. A strong signal can reach a hundred times the expected range, and one
 *   shared range would squeeze the points into a thin strip at the left edge.
 * - The statistics, for example the genomic inflation λ, print in the top left corner.
 * - Where the y channel transforms a p column, a stored zero draws an upward triangle at the top of the observed
 *   range.
 *
 * The points come from the composition machinery, thus a table of many thousand p-values reads the shared
 * payload. The band draws after the points in the series list, and it keeps its rows inline: its upper half
 * holds the width of the band, which no cell gives. The band reads at most `QQ_BAND_POINTS` rows, spaced
 * along the x axis, thus it stays small beside a payload of any size.
 */

import { err, ok, type Result } from "neverthrow";

import { channelColumn, channelTransform, type ChartBlock, type ChartComposition } from "../../contracts/report-blocks.js";
import type { ChartRow, EchartOption } from "../chart.js";
import { CHART_INK, GUIDE_LINE_COLOR, GUIDE_LINE_WIDTH_PX, MUTED_CHART_COLOR } from "../design.js";
import type { RenderProblem } from "../types.js";
import { statisticsGraphic, toNumber } from "./common.js";
import {
    axisOf,
    BELOW_RESOLUTION_NAME,
    BELOW_RESOLUTION_SYMBOL,
    BELOW_RESOLUTION_SYMBOL_PX,
    BELOW_RESOLUTION_TOOLTIP,
    belowResolutionHeight,
    belowResolutionRows,
    demandedChannel,
    largest,
    niceCeiling,
    plottedValues,
    seriesOf,
} from "./dense.js";
import type { FigureContext, FigureMember, FigureModule } from "./index.js";

/** The symbol size in pixels of a QQ point. */
export const QQ_POINT_PX = 3;

/**
 * The largest count of rows that the band reads. One row for each two pixels of a wide plot keeps the drawn
 * edge of the band as the full table draws it.
 */
export const QQ_BAND_POINTS = 400;

/** The fill of the band: the muted gray, light. */
const BAND_OPACITY = 0.3;

/** The drawing order of the band. The runtime draws a scatter at the order 2, thus the band sits under it. */
const BAND_Z = 1;

/** The titles of the two axes where the binding declares no label. The minus sign is the character. */
const EXPECTED_TITLE = "Expected −log10(p)";
const OBSERVED_TITLE = "Observed −log10(p)";

/** The name of the two band series. The legend of the figure hides, thus the name rides the tooltip alone. */
const BAND_NAME = "Null band";

/** The members of a QQ block that the figure reads. */
const READS: ReadonlySet<FigureMember> = new Set(["x", "y", "low", "high", "statistics"]);

/** One row of the band: the expected value and its two bounds. */
interface BandRow {
    readonly x: number;
    readonly low: number;
    readonly high: number;
    readonly index: number;
}

/**
 * The rows that the band reads: each row with a number in the three columns, in ascending order of x, thinned
 * to at most `QQ_BAND_POINTS` rows spaced along the x axis. The first and the last row always stay, thus the
 * band spans the whole axis.
 */
function bandRows(rows: readonly ChartRow[], xs: readonly (number | null)[], lowColumn: string, highColumn: string): BandRow[] {
    const complete: BandRow[] = [];
    for (let index = 0; index < rows.length; index += 1) {
        const x = xs[index];
        const low = toNumber(rows[index][lowColumn]);
        const high = toNumber(rows[index][highColumn]);
        if (x !== null && low !== null && high !== null) complete.push({ x, low, high, index });
    }
    complete.sort((a, b) => a.x - b.x || a.index - b.index);
    if (complete.length <= QQ_BAND_POINTS) return complete;
    const last = complete[complete.length - 1];
    // The kept rows sit at least one step apart, and a kept row between the ends sits at least one step before
    // the last row. Thus the span holds at most `QQ_BAND_POINTS - 1` steps, and the band at most
    // `QQ_BAND_POINTS` rows.
    const step = (last.x - complete[0].x) / (QQ_BAND_POINTS - 1);
    const kept: BandRow[] = [complete[0]];
    for (let place = 1; place < complete.length - 1; place += 1) {
        const row = complete[place];
        if (row.x - kept[kept.length - 1].x >= step && last.x - row.x >= step) kept.push(row);
    }
    kept.push(last);
    return kept;
}

/**
 * The two series of the band: a lower series that carries the lower bound with no ink, and an upper series
 * that stacks the width of the band on it and fills the area between.
 */
function bandSeries(band: readonly BandRow[]): EchartOption[] {
    const shared = { type: "line", name: BAND_NAME, stack: "qq-band", showSymbol: false, silent: true, tooltip: { show: false }, z: BAND_Z };
    return [
        { ...shared, lineStyle: { opacity: 0 }, data: band.map((row) => [row.x, row.low]) },
        {
            ...shared,
            lineStyle: { opacity: 0 },
            areaStyle: { color: MUTED_CHART_COLOR, opacity: BAND_OPACITY },
            data: band.map((row) => [row.x, row.high - row.low]),
        },
    ];
}

function deriveQq(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<EchartOption, RenderProblem> {
    const encoding = block.encoding ?? {};
    const x = demandedChannel(context.blockId, "qq", encoding, "x");
    if (x.isErr()) return err(x.error);
    const y = demandedChannel(context.blockId, "qq", encoding, "y");
    if (y.isErr()) return err(y.error);
    const composition: ChartComposition = { series: [{ form: "scatter", encoding: { x: x.value, y: y.value } }] };
    const composed = context.compose(composition, { preset: { x: EXPECTED_TITLE, y: OBSERVED_TITLE } });
    if (composed.isErr()) return err(composed.error);

    const xs = plottedValues(rows, x.value);
    const ys = plottedValues(rows, y.value);
    const band = encoding.low !== undefined && encoding.high !== undefined ? bandRows(rows, xs, channelColumn(encoding.low), channelColumn(encoding.high)) : [];
    const expectedValues: number[] = [];
    const observedValues: number[] = [];
    for (let index = 0; index < rows.length; index += 1) {
        const expected = xs[index];
        const observed = ys[index];
        if (expected === null || observed === null) continue;
        expectedValues.push(expected);
        observedValues.push(observed);
    }
    const top = largest(expectedValues) ?? 0;
    const peak = largest(observedValues);
    // A stored zero of a p that the channel transforms draws at the top of the observed range.
    const zeroRows = channelTransform(y.value) === "neg_log10" ? belowResolutionRows(rows, channelColumn(y.value), xs) : [];
    const zeroY = belowResolutionHeight(peak, 0);
    const xEnd = niceCeiling(Math.max(top, largest(band.map((row) => row.x)) ?? 0));
    // The y range holds the identity line and the band as well as the points.
    const yEnd = niceCeiling(Math.max(peak ?? 0, top, largest(band.map((row) => row.high)) ?? 0, zeroRows.length > 0 ? zeroY : 0));
    const identity = {
        silent: true,
        symbol: "none",
        lineStyle: { color: GUIDE_LINE_COLOR, width: GUIDE_LINE_WIDTH_PX, type: "solid" },
        label: { show: false },
        data: [[{ coord: [0, 0] }, { coord: [top, top] }]],
    };
    const option = composed.value;
    const statistics = statisticsGraphic(context.statistics, "top-left");
    return ok({
        ...option,
        legend: { show: false },
        xAxis: { ...axisOf(option, "xAxis"), min: 0, max: xEnd },
        yAxis: { ...axisOf(option, "yAxis"), min: 0, max: yEnd },
        series: [
            ...seriesOf(option).map((series) => ({ ...series, symbolSize: QQ_POINT_PX, itemStyle: { color: CHART_INK }, markLine: identity })),
            ...(band.length > 0 ? bandSeries(band) : []),
            ...(zeroRows.length > 0
                ? [
                      {
                          type: "scatter",
                          name: BELOW_RESOLUTION_NAME,
                          symbol: BELOW_RESOLUTION_SYMBOL,
                          symbolSize: BELOW_RESOLUTION_SYMBOL_PX,
                          itemStyle: { color: CHART_INK },
                          tooltip: BELOW_RESOLUTION_TOOLTIP,
                          data: zeroRows.map((index) => [xs[index] ?? 0, zeroY]),
                      },
                  ]
                : []),
        ],
        ...(statistics.length > 0 ? { graphic: statistics } : {}),
    });
}

/** The QQ figure module. */
export const QQ_FIGURE: FigureModule = { reads: READS, derive: deriveQq };
