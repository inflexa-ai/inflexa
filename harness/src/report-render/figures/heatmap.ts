/**
 * The heatmap: a matrix of one value over the pairs of two category columns, with annotation strips.
 *
 * The canonical expression heatmap is the pheatmap and ComplexHeatmap figure: the genes down the y axis in the
 * order of the run, the samples along x, a z-score on a diverging ramp symmetric at zero, and one strip of
 * category colors over the matrix for each covariate of the samples, with a legend for each strip. The cells
 * stand apart by a thin white gap, and the axes draw no line. A matrix of many samples hides its sample names,
 * and the axis title states the count of samples in their place.
 *
 * A distance matrix draws on the sequential ramp, whose dark end is the low value. Thus the diagonal of zero
 * distance draws dark, and two far samples draw light, as the DESeq2 sample-distance figure draws them.
 *
 * The run gives the order of each axis through the `orderBy` of its channel, for example the leaf order of a
 * clustering. The figure draws no dendrogram.
 *
 * A pair of categories holds one value. A repeated pair is a refusal, and never a silent sum. A track column
 * holds one value for each x category, and a category with two values is a refusal.
 *
 * pheatmap names each row. Thus a matrix of more rows than the default body holds at one line of text each
 * states a taller body, up to the largest body. A taller body grows the column exports in the same ratio.
 * Past the largest body, and in a column export whose rows are shorter than a line of text, a row name that
 * overlaps its neighbor hides.
 */

import { err, ok, type Result } from "neverthrow";

import { channelColumn, channelOrder, channelTransform, type ChartBlock, type ChartChannel } from "../../contracts/report-blocks.js";
import { declaredForColumn } from "../../contracts/report-reference.js";
import type { Cell, ChartRow, EchartOption } from "../chart.js";
import { CHART_BODY_PX, CHART_BODY_MAX_PX, CHART_PAGE_TEXT_PX, CHART_SLOT_LIMIT, COLOR_SCALE_BAND_PCT } from "../design.js";
import type { RenderProblem } from "../types.js";
import {
    axisNameFields,
    categoricalPalette,
    categoryAxisTitle,
    categoryName,
    chartProblem,
    colorScale,
    columnPresent,
    continuousScale,
    orderQuickCategories,
    toNumber,
    transformColumn,
    valueAxisTitle,
    withFigureBody,
} from "./common.js";
import type { FigureContext, FigureModule } from "./index.js";

/** The count of x categories past which the matrix hides the x labels and states the count in the axis title. */
export const HEATMAP_LABEL_LIMIT = 40;

/** The white gap between two cells, in pixels. */
export const HEATMAP_CELL_GAP_PX = 1;

/** The height of one annotation strip, in pixels. */
export const HEATMAP_STRIP_PX = 12;

/** The height of one line of the strip legends, and the gap between the band of the legends and the strips, in pixels. */
export const TRACK_LEGEND_LINE_PX = 24;
export const TRACK_BAND_GAP_PX = 14;

/** The gap over the legends, and between the strips and the matrix, in pixels. */
const TRACK_GAP_PX = 6;

/** The height of one matrix row on the page, in pixels: one line of the page text with a gap. */
export const HEATMAP_ROW_PX = 16;

/** The top margin of a matrix with no strip, in pixels: the top margin of the layout discipline on the default body. */
const PLAIN_TOP_PX = 32;

/**
 * The band under a matrix in a taller body, in pixels: the axis title and its gap, and one line of level
 * labels. A turned label adds its turned length.
 */
const TITLE_BAND_PX = 44;
const LEVEL_LABEL_PX = 18;

/** The count of x categories past which the layout discipline turns the x labels 45 degrees, and past which 90. */
const TURN_45_COUNT = 10;
const TURN_90_COUNT = 20;

/** The right margin of the grid beside the color scale. */
const COLOR_SCALE_GRID_RIGHT = `${COLOR_SCALE_BAND_PCT}%`;

/**
 * The width of one character of a row label, as a share of the text size. The left margin of a matrix with
 * strips holds its longest row label, thus the strips and the matrix start at one edge.
 */
const LABEL_CHARACTER_SHARE = 0.6;
const LABEL_MARGIN_MIN_PX = 40;
const LABEL_MARGIN_PAD_PX = 16;

/** The size of one entry of a strip legend, in pixels. */
const TRACK_LEGEND_ITEM_PX = 10;

/** The axis parts that the matrix hides: the line and the ticks. */
const LINELESS_AXIS: EchartOption = { axisLine: { show: false }, axisTick: { show: false } };

/** The heatmap. */
export const HEATMAP_FIGURE: FigureModule = {
    reads: new Set(["x", "y", "value", "tracks"]),
    derive: deriveHeatmap,
};

/** The plain column of one category channel of the matrix. A transform would make its categories numbers, thus it refuses. */
function categoryColumn(
    block: ChartBlock,
    rows: readonly ChartRow[],
    context: FigureContext,
    member: "x" | "y",
    channel: ChartChannel,
): Result<string, RenderProblem> {
    if (channelTransform(channel) !== undefined) {
        return err(chartProblem(block.id, `The "${member}" channel of the heatmap names categories, thus it takes no transform.`));
    }
    return present(block.id, rows, context, channelColumn(channel));
}

/** The column, where one row at least holds it. A table with no row holds each column. */
function present(blockId: string, rows: readonly ChartRow[], context: FigureContext, column: string): Result<string, RenderProblem> {
    if (rows.length > 0 && !columnPresent(column, rows, context.columns)) {
        return err(chartProblem(blockId, `The column "${column}" is absent from every row.`));
    }
    return ok(column);
}

/** The key of one pair. The key carries the type of each cell, thus the number `1` and the text `"1"` stay two categories. */
function pairKey(xCell: Cell, yCell: Cell): string {
    return `${cellKey(xCell)} ${cellKey(yCell)}`;
}

/** The key of one cell. */
function cellKey(cell: Cell): string {
    return `${typeof cell}:${String(cell)}`;
}

function deriveHeatmap(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<EchartOption, RenderProblem> {
    const encoding = block.encoding ?? {};
    for (const member of ["x", "y", "value"] as const) {
        if (encoding[member] === undefined) {
            return err(chartProblem(block.id, `The heatmap chart needs a column for the "${member}" channel.`));
        }
    }
    const xChannel = encoding.x as ChartChannel;
    const yChannel = encoding.y as ChartChannel;
    const valueChannel = encoding.value as ChartChannel;
    if (channelOrder(valueChannel) !== undefined) {
        return err(chartProblem(block.id, 'The "value" channel draws no category axis, thus it takes no "orderBy".'));
    }
    const x = categoryColumn(block, rows, context, "x", xChannel);
    if (x.isErr()) return err(x.error);
    const y = categoryColumn(block, rows, context, "y", yChannel);
    if (y.isErr()) return err(y.error);
    const valueColumn = present(block.id, rows, context, channelColumn(valueChannel));
    if (valueColumn.isErr()) return err(valueColumn.error);
    const transform = channelTransform(valueChannel);
    const valueName = transform === undefined ? valueColumn.value : `${transform}(${valueColumn.value})`;
    const values = transform === undefined ? rows.map((row) => toNumber(row[valueColumn.value])) : transformColumn(rows, valueColumn.value, transform);

    const xOrdered = orderQuickCategories(block.id, rows, x.value, channelOrder(xChannel));
    if (xOrdered.isErr()) return err(xOrdered.error);
    const yOrdered = orderQuickCategories(block.id, rows, y.value, channelOrder(yChannel));
    if (yOrdered.isErr()) return err(yOrdered.error);
    const xCategories = xOrdered.value;
    const yCategories = yOrdered.value;
    const slots = xCategories.length * yCategories.length;
    if (slots > CHART_SLOT_LIMIT) {
        return err(
            chartProblem(
                block.id,
                `The chart holds ${xCategories.length} categories and ${yCategories.length} groups, thus ${slots} slots. A chart holds ${CHART_SLOT_LIMIT} slots at most, thus a table of fewer categories or fewer groups serves the reader.`,
            ),
        );
    }

    const cells = new Map<string, number | null>();
    for (const [index, row] of rows.entries()) {
        const key = pairKey(row[x.value], row[y.value]);
        if (cells.has(key)) {
            return err(chartProblem(block.id, `The heatmap holds the pair (${String(row[x.value])}, ${String(row[y.value])}) more than one time.`));
        }
        cells.set(key, values[index]);
    }
    const data: (number | null)[][] = [];
    const finite: number[] = [];
    for (let xi = 0; xi < xCategories.length; xi++) {
        for (let yi = 0; yi < yCategories.length; yi++) {
            const value = cells.get(pairKey(xCategories[xi], yCategories[yi])) ?? null;
            data.push([xi, yi, value]);
            if (value !== null) finite.push(value);
        }
    }

    const hidden = xCategories.length > HEATMAP_LABEL_LIMIT;
    const xTitle = hidden
        ? `${categoryAxisTitle(context.labels, x.value) ?? categoryName(x.value)} (n = ${xCategories.length})`
        : categoryAxisTitle(context.labels, x.value);
    const xAxis: EchartOption = {
        type: "category",
        data: xCategories.map(String),
        ...axisNameFields("x", xTitle),
        ...LINELESS_AXIS,
        ...(hidden ? { axisLabel: { show: false } } : {}),
    };
    const yAxis: EchartOption = {
        type: "category",
        // The runtime draws the first category of a y axis at the origin. The inverted axis puts the first row
        // of the order at the top, thus the matrix reads down as the run ordered it.
        inverse: true,
        data: yCategories.map(String),
        ...axisNameFields("y", categoryAxisTitle(context.labels, y.value)),
        ...LINELESS_AXIS,
        // A matrix of many rows holds more names than its height fits. The runtime then shows each name that
        // clears its neighbor, and never draws two names over each other.
        axisLabel: { hideOverlap: true },
    };
    const scaleMap: EchartOption = {
        type: "continuous",
        ...colorScale(continuousScale(finite), valueAxisTitle(context.labels, valueName), valueName, declaredForColumn(context.meanings, valueColumn.value)),
    };
    const matrix: EchartOption = { type: "heatmap", itemStyle: { borderColor: "#ffffff", borderWidth: HEATMAP_CELL_GAP_PX }, data };

    const tracks = encoding.tracks ?? [];
    const band = underBand(xCategories, hidden);
    if (tracks.length === 0) {
        const body = PLAIN_TOP_PX + yCategories.length * HEATMAP_ROW_PX + band;
        if (body <= CHART_BODY_PX) {
            return ok({ xAxis, yAxis, visualMap: scaleMap, series: [matrix], grid: { right: COLOR_SCALE_GRID_RIGHT } });
        }
        return ok(
            withFigureBody(
                {
                    xAxis,
                    yAxis,
                    visualMap: scaleMap,
                    series: [matrix],
                    grid: { right: COLOR_SCALE_GRID_RIGHT, top: PLAIN_TOP_PX, bottom: bandShare(band, body) },
                },
                body,
            ),
        );
    }
    const strips = trackStrips(block, rows, context, x.value, xCategories, tracks);
    if (strips.isErr()) return err(strips.error);

    const titles = strips.value.map((strip) => strip.title);
    let longest = 0;
    for (const name of [...yCategories.map(String), ...titles]) longest = Math.max(longest, name.length);
    const left = Math.max(LABEL_MARGIN_MIN_PX, Math.round(longest * CHART_PAGE_TEXT_PX * LABEL_CHARACTER_SHARE) + LABEL_MARGIN_PAD_PX);
    const stripTop = TRACK_GAP_PX + tracks.length * TRACK_LEGEND_LINE_PX + TRACK_BAND_GAP_PX;
    const matrixTop = stripTop + tracks.length * HEATMAP_STRIP_PX + TRACK_GAP_PX;
    const body = matrixTop + yCategories.length * HEATMAP_ROW_PX + band;
    const tall = body > CHART_BODY_PX;
    const bottom = tall ? bandShare(band, body) : hidden ? "12%" : xCategories.length > TURN_45_COUNT ? "25%" : "20%";
    const palette = categoricalPalette(strips.value.reduce((sum, strip) => sum + strip.values.length, 0));

    const stripSeries: EchartOption[] = [];
    const legends: EchartOption[] = [];
    let offset = 0;
    for (const [place, strip] of strips.value.entries()) {
        stripSeries.push({
            type: "heatmap",
            name: strip.title,
            xAxisIndex: 1,
            yAxisIndex: 1,
            itemStyle: { borderColor: "#ffffff", borderWidth: HEATMAP_CELL_GAP_PX },
            data: strip.codes.flatMap((code, xi) => (code === null ? [] : [[xi, place, code]])),
        });
        legends.push({
            type: "piecewise",
            seriesIndex: 1 + place,
            dimension: 2,
            orient: "horizontal",
            left,
            top: TRACK_GAP_PX + place * TRACK_LEGEND_LINE_PX,
            itemWidth: TRACK_LEGEND_ITEM_PX,
            itemHeight: TRACK_LEGEND_ITEM_PX,
            selectedMode: false,
            showLabel: true,
            text: [strip.title],
            pieces: strip.values.map((value, code) => ({ value: code, label: categoryName(value), color: palette[offset + code] })),
        });
        offset += strip.values.length;
    }
    const tracked: EchartOption = {
        grid: [
            { left, right: COLOR_SCALE_GRID_RIGHT, top: matrixTop, bottom },
            { left, right: COLOR_SCALE_GRID_RIGHT, top: stripTop, height: tracks.length * HEATMAP_STRIP_PX },
        ],
        xAxis: [xAxis, { type: "category", gridIndex: 1, data: xCategories.map(String), ...LINELESS_AXIS, axisLabel: { show: false } }],
        yAxis: [yAxis, { type: "category", gridIndex: 1, inverse: true, data: titles, ...LINELESS_AXIS }],
        visualMap: [{ ...scaleMap, seriesIndex: 0 }, ...legends],
        series: [matrix, ...stripSeries],
        legend: { show: false },
    };
    return ok(tall ? withFigureBody(tracked, body) : tracked);
}

/**
 * The band under the matrix of a taller body, in pixels: the axis title, and the x labels as the layout
 * discipline turns them. A hidden label takes no room.
 */
function underBand(xCategories: readonly Cell[], hidden: boolean): number {
    if (hidden) return TITLE_BAND_PX;
    if (xCategories.length <= TURN_45_COUNT) return TITLE_BAND_PX + LEVEL_LABEL_PX;
    let longest = 0;
    for (const category of xCategories) longest = Math.max(longest, String(category).length);
    const length = longest * CHART_PAGE_TEXT_PX * LABEL_CHARACTER_SHARE;
    return TITLE_BAND_PX + Math.ceil(xCategories.length <= TURN_90_COUNT ? length * Math.SQRT1_2 : length);
}

/** The band under the matrix as a share of the body, which stops at the largest body. */
function bandShare(band: number, body: number): string {
    return `${Math.round((band / Math.min(body, CHART_BODY_MAX_PX)) * 1e6) / 1e4}%`;
}

/** One annotation strip: its title, its categories in order, and the place of the category of each x category. */
interface TrackStrip {
    readonly title: string;
    readonly values: readonly Cell[];
    readonly codes: readonly (number | null)[];
}

/**
 * The strip of each track column. The categories of a strip take the order in which the x axis meets them.
 * An x category that no row gives a value draws no cell in the strip.
 */
function trackStrips(
    block: ChartBlock,
    rows: readonly ChartRow[],
    context: FigureContext,
    xColumn: string,
    xCategories: readonly Cell[],
    tracks: readonly string[],
): Result<TrackStrip[], RenderProblem> {
    const strips: TrackStrip[] = [];
    for (const track of tracks) {
        const column = present(block.id, rows, context, track);
        if (column.isErr()) return err(column.error);
        const held = new Map<string, Cell>();
        for (const row of rows) {
            const category = row[xColumn];
            const value = row[track];
            if (category === undefined || value === undefined || value === "") continue;
            const key = cellKey(category);
            const prior = held.get(key);
            if (prior !== undefined && cellKey(prior) !== cellKey(value)) {
                return err(
                    chartProblem(
                        block.id,
                        `The track column "${track}" holds two values, "${String(prior)}" and "${String(value)}", for the x category "${String(category)}". A track holds one value for each x category.`,
                    ),
                );
            }
            held.set(key, value);
        }
        const along = xCategories.map((category) => held.get(cellKey(category)) ?? null);
        const values: Cell[] = [];
        const codeOf = new Map<string, number>();
        for (const value of along) {
            if (value === null || codeOf.has(cellKey(value))) continue;
            codeOf.set(cellKey(value), values.length);
            values.push(value);
        }
        strips.push({
            title: declaredForColumn(context.labels, track) ?? categoryName(track),
            values,
            codes: along.map((value) => (value === null ? null : (codeOf.get(cellKey(value)) ?? null))),
        });
    }
    return ok(strips);
}
