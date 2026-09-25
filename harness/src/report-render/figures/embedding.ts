/**
 * The embedding of cells: a UMAP or a t-SNE, one point for each cell.
 *
 * The canonical figure is the scanpy `pl.umap` and the Seurat `DimPlot` of a single-cell study. The two
 * coordinates carry no unit that a reader reads, thus the axes hide, and a small key at the bottom left corner
 * names the two dimensions. One unit on x equals one unit on y, because the embedding places near cells near.
 * The point size follows the cell count by the scanpy rule, and the points draw with a light opacity, thus a
 * dense cluster reads by its shape.
 *
 * A `group` colors the cells by category, and each category name draws on the data at the median place of its
 * cells, as scanpy `legend_loc="on data"` does. No legend draws beside the names. A `color` colors the cells on
 * a continuous scale: a zero draws in a light gray ground, the scale clips at the 99th percentile, and the high
 * values draw on top. A `facet` splits the cells into panels of one shared range.
 *
 * The points build through the composition machinery, thus a dense table reads the shared payload of its
 * artifact. The names of the categories draw as a small series after the points, and it keeps its rows inline.
 */

import { err, ok, type Result } from "neverthrow";

import { channelColumn, channelOrder, channelTransform, type ChartBlock, type ChartChannel, type ChartComposition } from "../../contracts/report-blocks.js";
import { declaredForColumn, type ColumnMeaning } from "../../contracts/report-reference.js";
import type { Cell, ChartRow, EchartOption } from "../chart.js";
import { CHART_INK, CHART_PAGE_TEXT_PX, DIVERGING_RAMP, SEQUENTIAL_RAMP } from "../design.js";
import type { RenderProblem } from "../types.js";
import { categoricalPalette, categoryName, chartProblem, colorScale, firstAppearance, toNumber, transformColumn, valueAxisTitle } from "./common.js";
import { equalRanges, squareLayout } from "./equal-units.js";
import { nameAnchors } from "./label-room.js";
import type { FigureContext, FigureModule } from "./index.js";

/** The scanpy point area of one cell, in square points, for each cell of the plot: 120000 / n. */
export const SCANPY_AREA_PT2 = 120_000;

/** The bounds of the point diameter of an embedding, in pixels. */
export const EMBEDDING_POINT_MIN_PX = 1;
export const EMBEDDING_POINT_MAX_PX = 6;

/** The opacity of a point of an embedding. An overlap of cells reads darker than a lone cell. */
export const EMBEDDING_OPACITY = 0.6;

/** The ground color of a cell whose continuous value is zero: the light gray of the Seurat `FeaturePlot`. */
export const EMBEDDING_GROUND = "#d3d3d3";

/** The percentile at which the continuous scale of an embedding clips, as scanpy `vmax="p99"` does. */
export const EMBEDDING_CLIP_QUANTILE = 0.99;

/** The share of the longer span that pads each side of an embedding. */
const EMBEDDING_PAD = 0.03;

/**
 * The margins of the squares of an embedding, in pixels: the panel name over each square, and the corner key
 * under and beside the first square.
 */
const EMBEDDING_MARGINS = { top: 22, bottom: 22, left: 22, right: 8 } as const;

/**
 * The smallest width of the band of the color scale at the right of the squares, in pixels. A longer scale
 * title widens the band to its own width, thus the narrowed page body never cuts it.
 */
const EMBEDDING_SCALE_BAND_PX = 96;

/** The width of one character of the scale title, as a share of the page text size, and the pad of the band. */
const SCALE_CHARACTER_SHARE = 0.6;
const SCALE_BAND_PAD_PX = 8;

/** The arrow of the corner key. It points along the axis that its dimension names. */
const KEY_ARROW = " →";

/** The width of the white outline of a category name on the data, in pixels, as scanpy `legend_fontoutline=2`. */
const NAME_OUTLINE_PX = 2;

/**
 * The cell count from which the points draw on the large path of the runtime. The large path draws a square
 * for each point, thus a smaller embedding draws round points as scanpy does.
 */
const EMBEDDING_LARGE_CELLS = 50_000;

/** The drawing order of the category names, over each point. */
const NAME_Z = 10;

/** The axis parts that an embedding hides: the line, the ticks, the tick labels, and the grid lines. */
const HIDDEN_AXIS_PARTS: EchartOption = {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { show: false },
    splitLine: { show: false },
};

/** The embedding of cells. */
export const EMBEDDING_FIGURE: FigureModule = {
    reads: new Set(["x", "y", "group", "color", "facet", "label"]),
    derive: deriveEmbedding,
};

/**
 * The point diameter of an embedding of `cells` cells, in pixels: the scanpy area 120000 / n in square points,
 * as a diameter at 96 pixels for each inch, bounded to the embedding range.
 */
export function embeddingPointPx(cells: number): number {
    const areaPt2 = SCANPY_AREA_PT2 / Math.max(1, cells);
    const diameterPx = 2 * Math.sqrt(areaPt2 / Math.PI) * (96 / 72);
    return Math.round(Math.min(EMBEDDING_POINT_MAX_PX, Math.max(EMBEDDING_POINT_MIN_PX, diameterPx)) * 10) / 10;
}

/** The value of one channel in each row: the transformed number where the channel declares a transform. */
function channelValues(rows: readonly ChartRow[], channel: ChartChannel): readonly (Cell | null)[] {
    const column = channelColumn(channel);
    const transform = channelTransform(channel);
    return transform === undefined ? rows.map((row) => row[column] ?? null) : transformColumn(rows, column, transform);
}

/** The axis name of one channel: the column, with its transform where it declares one. */
function channelName(channel: ChartChannel): string {
    const transform = channelTransform(channel);
    return transform === undefined ? channelColumn(channel) : `${transform}(${channelColumn(channel)})`;
}

/** One drawn cell: its pair, its panel, its category, and its continuous value. */
interface EmbeddedCell {
    readonly x: number;
    readonly y: number;
    readonly panel: number;
    readonly group?: string;
    readonly color?: number;
}

function deriveEmbedding(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<EchartOption, RenderProblem> {
    const encoding = block.encoding ?? {};
    const { x, y, group, color, facet, label } = encoding;
    if (x === undefined || y === undefined) {
        return err(chartProblem(block.id, `The embedding chart needs a column for the "${x === undefined ? "x" : "y"}" channel.`));
    }
    if (group === undefined && color === undefined) {
        return err(chartProblem(block.id, 'The embedding colors its cells by a "group" channel or by a "color" channel. Name one of the two.'));
    }
    if (group !== undefined && color !== undefined) {
        return err(chartProblem(block.id, 'A "color" channel beside a "group" channel is a fault, because one chart colors by one channel.'));
    }
    for (const [member, channel] of [
        ["x", x],
        ["y", y],
    ] as const) {
        if (channelOrder(channel) !== undefined) {
            return err(chartProblem(block.id, `The "${member}" channel of the embedding draws a hidden value axis, thus it takes no "orderBy".`));
        }
    }
    const composition: ChartComposition = {
        series: [
            {
                form: "scatter",
                encoding: {
                    x,
                    y,
                    ...(group !== undefined ? { group } : {}),
                    ...(color !== undefined ? { color } : {}),
                    ...(label !== undefined ? { label } : {}),
                },
            },
        ],
        ...(facet !== undefined ? { facet } : {}),
    };
    const composed = context.compose(composition, color !== undefined ? { colorOnTop: true } : {});
    if (composed.isErr()) return err(composed.error);

    const xs = channelValues(rows, x);
    const ys = channelValues(rows, y);
    const groups = group === undefined ? undefined : channelValues(rows, group);
    const colors = color === undefined ? undefined : channelValues(rows, color);
    const facets = facet === undefined ? undefined : rows.map((row) => row[channelColumn(facet)] ?? null);
    const panelNames =
        facets === undefined ? [] : firstAppearance(facets.filter((cell): cell is Cell => cell !== null).map((cell) => `${typeof cell}:${String(cell)}`));
    const panelOf = new Map(panelNames.map((key, place) => [key, place]));

    const cells: EmbeddedCell[] = [];
    for (let index = 0; index < rows.length; index += 1) {
        const px = toNumber(xs[index]);
        const py = toNumber(ys[index]);
        if (px === null || py === null) continue;
        const cellGroup = groups?.[index] ?? null;
        if (groups !== undefined && cellGroup === null) continue;
        const cellColor = colors === undefined ? null : toNumber(colors[index]);
        if (colors !== undefined && cellColor === null) continue;
        const facetCell = facets?.[index] ?? null;
        if (facets !== undefined && facetCell === null) continue;
        cells.push({
            x: px,
            y: py,
            panel: facetCell === null ? 0 : (panelOf.get(`${typeof facetCell}:${String(facetCell)}`) ?? 0),
            ...(cellGroup !== null ? { group: categoryName(cellGroup) } : {}),
            ...(cellColor !== null ? { color: cellColor } : {}),
        });
    }

    const option = composed.value;
    const panels = Math.max(1, panelNames.length);
    const pointPx = embeddingPointPx(cells.length);
    const series = (Array.isArray(option.series) ? (option.series as EchartOption[]) : []).map((entry) => ({
        ...entry,
        large: cells.length >= EMBEDDING_LARGE_CELLS,
        symbolSize: pointPx,
        itemStyle: {
            ...(typeof entry.itemStyle === "object" && entry.itemStyle !== null ? (entry.itemStyle as EchartOption) : {}),
            opacity: EMBEDDING_OPACITY,
        },
    }));

    const ranges = equalRanges(
        cells.map((cell) => cell.x),
        cells.map((cell) => cell.y),
        { pad: EMBEDDING_PAD, round: false },
    );
    const scaleTitle = color !== undefined ? valueAxisTitle(context.labels, channelName(color)) : "";
    const scaleBand = Math.max(EMBEDDING_SCALE_BAND_PX, Math.ceil(scaleTitle.length * CHART_PAGE_TEXT_PX * SCALE_CHARACTER_SHARE) + SCALE_BAND_PAD_PX);
    const layout = squareLayout({
        panels,
        margins: EMBEDDING_MARGINS,
        side: color !== undefined ? scaleBand : 0,
        visualMaps: color !== undefined ? 1 : 0,
        points: { series: series.length, px: pointPx },
    });

    const xAxes: EchartOption[] = [];
    const yAxes: EchartOption[] = [];
    const keyStyle = { color: CHART_INK, align: "left" };
    for (let panel = 0; panel < panels; panel += 1) {
        const key = panel === 0;
        xAxes.push({
            type: "value",
            gridIndex: panel,
            ...ranges.x,
            ...HIDDEN_AXIS_PARTS,
            ...(key
                ? {
                      name: `${valueAxisTitle(context.labels, channelName(x))}${KEY_ARROW}`,
                      nameLocation: "start",
                      nameGap: 0,
                      nameTextStyle: { ...keyStyle, verticalAlign: "top" },
                  }
                : {}),
        });
        yAxes.push({
            type: "value",
            gridIndex: panel,
            ...ranges.y,
            ...HIDDEN_AXIS_PARTS,
            ...(key
                ? {
                      name: `${valueAxisTitle(context.labels, channelName(y))}${KEY_ARROW}`,
                      nameLocation: "start",
                      nameRotate: 90,
                      nameGap: 0,
                      nameTextStyle: { ...keyStyle, verticalAlign: "bottom" },
                  }
                : {}),
        });
    }
    // Each panel names its facet value on an axis of no series over its square, thus the name moves with the square.
    for (const [panel, name] of panelNames.entries()) {
        xAxes.push({
            type: "value",
            gridIndex: panel,
            position: "top",
            ...HIDDEN_AXIS_PARTS,
            name: categoryName(name.slice(name.indexOf(":") + 1)),
            nameLocation: "start",
            nameGap: 0,
            nameTextStyle: { color: CHART_INK, align: "left", verticalAlign: "bottom", fontWeight: "bold" },
        });
    }

    const out: EchartOption = {
        ...(option.tooltip !== undefined ? { tooltip: option.tooltip } : {}),
        grid: layout.grid,
        xAxis: xAxes,
        yAxis: yAxes,
        series,
        legend: { show: false },
        media: layout.media,
    };
    if (group !== undefined) {
        const names = firstAppearance(cells.flatMap((cell) => (cell.group === undefined ? [] : [cell.group])));
        return ok({
            ...out,
            color: [...categoricalPalette(names.length)],
            series: [...series, ...nameSeries(cells, names, panels, ranges.x.max - ranges.x.min)],
        });
    }
    const colorChannel = color as ChartChannel;
    const map = clippedScale(
        cells.flatMap((cell) => (cell.color === undefined ? [] : [cell.color])),
        scaleTitle,
        channelName(colorChannel),
        declaredForColumn(context.meanings, channelColumn(colorChannel)),
    );
    const composedMaps = Array.isArray(option.visualMap) ? (option.visualMap as EchartOption[]) : [];
    const seriesIndex = composedMaps.find((entry) => entry.dimension === 2)?.seriesIndex ?? series.map((_entry, index) => index);
    const place = layout.visualMap?.[0] ?? {};
    return ok({ ...out, visualMap: [{ type: "continuous", seriesIndex, dimension: 2, ...map, ...place }] });
}

/**
 * The continuous scale of an embedding, clipped at the 99th percentile of its values.
 *
 * A column of no negative value takes the sequential ramp from zero to the percentile. A zero lies outside the
 * selected range, thus it draws in the gray ground, and a value past the percentile draws in the top color. A
 * column that crosses zero takes the diverging ramp, symmetric at the percentile of the absolute values, and it
 * draws no ground, because its zero is the middle of the scale.
 */
function clippedScale(values: readonly number[], title: string, column: string, meaning: ColumnMeaning | undefined): EchartOption {
    const sorted = [...values].sort((a, b) => a - b);
    const negative = sorted.length > 0 && sorted[0] < 0;
    if (negative) {
        const reach = quantile(
            values.map((value) => Math.abs(value)).sort((a, b) => a - b),
            EMBEDDING_CLIP_QUANTILE,
        );
        const end = reach > 0 ? reach : 1;
        return withoutRight(colorScale({ min: -end, max: end, ramp: DIVERGING_RAMP }, title, column, meaning));
    }
    const positive = sorted.find((value) => value > 0);
    const clip = quantile(sorted, EMBEDDING_CLIP_QUANTILE);
    const top = clip > 0 ? clip : (sorted[sorted.length - 1] ?? 0) > 0 ? sorted[sorted.length - 1] : 1;
    const low = positive === undefined ? top : Math.min(positive, top);
    return {
        ...withoutRight(colorScale({ min: 0, max: top, ramp: SEQUENTIAL_RAMP }, title, column, meaning)),
        range: [low, top],
        outOfRange: { color: EMBEDDING_GROUND },
    };
}

/** A color scale with no right edge. The layout places the scale by its left edge in the band. */
function withoutRight(map: EchartOption): EchartOption {
    const { right: _right, ...rest } = map;
    return rest;
}

/**
 * The linear quantile of sorted values, as numpy and R type 7 give it. An empty list gives zero.
 */
function quantile(sorted: readonly number[], p: number): number {
    if (sorted.length === 0) return 0;
    const place = (sorted.length - 1) * p;
    const low = Math.floor(place);
    const high = Math.ceil(place);
    return sorted[low] + (sorted[high] - sorted[low]) * (place - low);
}

/**
 * The series of the category names on the data: one name for each category of each panel, at the median x and
 * the median y of its cells.
 *
 * The median is the computed summary of this figure. It sits inside the cloud of a curved cluster, where a mean
 * can fall between two arms. The names draw in the ink with a white outline, over every point. A name that
 * would cover the name of a larger category moves along y by whole lines.
 */
function nameSeries(cells: readonly EmbeddedCell[], names: readonly string[], panels: number, length: number): EchartOption[] {
    const out: EchartOption[] = [];
    for (let panel = 0; panel < panels; panel += 1) {
        const byName = new Map<string, { xs: number[]; ys: number[] }>();
        for (const cell of cells) {
            if (cell.panel !== panel || cell.group === undefined) continue;
            let entry = byName.get(cell.group);
            if (entry === undefined) {
                entry = { xs: [], ys: [] };
                byName.set(cell.group, entry);
            }
            entry.xs.push(cell.x);
            entry.ys.push(cell.y);
        }
        const present = names.filter((name) => byName.has(name));
        const anchors = nameAnchors(
            present.map((name) => {
                const entry = byName.get(name) ?? { xs: [], ys: [] };
                return { x: median(entry.xs), y: median(entry.ys), text: name };
            }),
            present.map((name) => byName.get(name)?.xs.length ?? 0),
            length,
        );
        const data = present.map((name, place) => ({ value: [anchors[place].x, anchors[place].y], name }));
        out.push({
            type: "scatter",
            name: "Category names",
            silent: true,
            symbolSize: 0,
            z: NAME_Z,
            xAxisIndex: panel,
            yAxisIndex: panel,
            tooltip: { show: false },
            label: {
                show: true,
                formatter: "{b}",
                position: "inside",
                color: CHART_INK,
                fontWeight: "bold",
                textBorderColor: "#ffffff",
                textBorderWidth: NAME_OUTLINE_PX,
            },
            data,
        });
    }
    return out;
}

/** The median of some values, read after one sort. */
function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return Number(quantile(sorted, 0.5).toPrecision(12));
}
