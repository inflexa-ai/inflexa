/**
 * The PCA of samples, and the shape draw that it shares with the plain scatter.
 *
 * The canonical PCA of a bulk study is the DESeq2 `plotPCA` figure: the sample scores on two components, the
 * condition as the color, a second covariate such as the batch as the symbol, and one unit on x equal to one
 * unit on y, thus a distance between two samples reads the same in each direction. A small table names each
 * sample beside its point. The run states the variance of each component, and the declared label of each
 * column carries it to the axis title.
 *
 * The shape draw splits the rows by the pair of their group and their shape. Each split is one series, named
 * by its group, thus the palette gives the series of one group one color. Each series carries the symbol of
 * its shape. The legend names each group with a circle, and each shape with its symbol in the ink color, thus
 * the two keys read apart. A symbol is redundant coding beside the color, thus the figure survives a print in
 * gray.
 *
 * The draw keeps its rows inline. A shape reads for a small table, and a page-side build draws no symbol.
 */

import { err, ok, type Result } from "neverthrow";

import { channelColumn, channelOrder, channelTransform, type ChartBlock, type ChartChannel } from "../../contracts/report-blocks.js";
import type { Cell, ChartRow, EchartOption } from "../chart.js";
import { CHART_INK, CHART_PALETTE } from "../design.js";
import type { RenderProblem } from "../types.js";
import {
    categoricalPalette,
    categoryName,
    chartProblem,
    columnPresent,
    firstAppearance,
    POINT_LEGEND_ICON,
    toNumber,
    transformColumn,
    valueAxis,
    valueAxisTitle,
} from "./common.js";
import { equalRanges, squareLayout } from "./equal-units.js";
import { NAME_GAP_PX, pointNameSides, type NameSide } from "./label-room.js";
import type { FigureContext, FigureModule } from "./index.js";

/**
 * The symbol of each shape category, in order: the circle, the triangle, the square, the diamond, the
 * inverted triangle, and the cross. Each one keeps a clear outline at a small size, and past six a reader
 * no longer tells the symbols apart.
 */
export const SHAPE_SYMBOLS = [
    "circle",
    "triangle",
    "rect",
    "diamond",
    "path://M0,0L10,0L5,10Z",
    "path://M3.5,0H6.5V3.5H10V6.5H6.5V10H3.5V6.5H0V3.5H3.5Z",
] as const;

/** The symbol size of a point of the shape draw, in pixels. A sample of a PCA is one of few, thus it draws large. */
export const SHAPED_POINT_PX = 10;

/** The largest row count of a PCA whose points each carry their name. The DESeq2 workflow labels a small study. */
export const PCA_LABEL_ROWS = 20;

/** The share of the longer span that pads each side of a PCA, before the ends round to a tick. */
const PCA_PAD = 0.04;

/** The margins of the square of a PCA, in pixels: the tick labels and the title of each axis. */
const PCA_MARGINS = { top: 16, bottom: 56, left: 64, right: 12 } as const;

/** The width of the legend band at the right of the square of a PCA, in pixels. */
const PCA_LEGEND_BAND_PX = 120;

/** The tooltip of a point with a name, and of a point with none. `{b}` is the name and `{c}` the pair. */
const NAMED_POINT_TOOLTIP: EchartOption = { trigger: "item", formatter: "{b}<br/>{a}: {c}" };
const PLAIN_POINT_TOOLTIP: EchartOption = { trigger: "item", formatter: "{a}: {c}" };

/** The label of each named point of a small PCA. Each point states its own side, and the gap is the one of the place estimate. */
const POINT_LABEL_FIELDS: EchartOption = { label: { show: true, formatter: "{b}", position: "right", distance: NAME_GAP_PX, color: CHART_INK } };

/** The two uses of the shape draw. */
interface ShapeDraw {
    readonly figure: string;
    readonly equalUnits: boolean;
    readonly labelRows: number;
}

const PCA_DRAW: ShapeDraw = { figure: "pca", equalUnits: true, labelRows: PCA_LABEL_ROWS };
const SCATTER_DRAW: ShapeDraw = { figure: "scatter", equalUnits: false, labelRows: 0 };

/** The PCA of samples. */
export const PCA_FIGURE: FigureModule = {
    reads: new Set(["x", "y", "group", "shape", "label"]),
    derive: (block, rows, context) => deriveShapeDraw(block, rows, context, PCA_DRAW),
};

/** The members of a plain scatter that the shape draw does not read beside a shape. */
const UNSHAPED_MEMBERS = ["color", "size", "low", "high", "facet", "focus"] as const;

/**
 * The plain scatter with a `shape` channel.
 *
 * The module reads every member of a scatter, thus the refusal of a member that the shape draw cannot draw
 * names the shape as the cause, and never states that a scatter reads no such member.
 */
export const SHAPED_SCATTER_FIGURE: FigureModule = {
    reads: new Set(["x", "y", "group", "shape", "label", ...UNSHAPED_MEMBERS]),
    derive: (block, rows, context) => {
        const encoding = block.encoding ?? {};
        for (const member of UNSHAPED_MEMBERS) {
            const declared = member === "focus" ? block.focus : encoding[member];
            if (declared !== undefined) {
                const noun = member === "focus" ? "focus" : `"${member}" channel`;
                return err(
                    chartProblem(block.id, `A scatter with a "shape" channel draws x, y, group, and label alone, thus it takes no ${noun} beside the shape.`),
                );
            }
        }
        return deriveShapeDraw(block, rows, context, SCATTER_DRAW);
    },
};

/** One resolved channel of the shape draw: its axis name and its value in each row. */
interface ShapeChannel {
    readonly name: string;
    readonly values: readonly (Cell | null)[];
}

/**
 * Resolve one channel of the shape draw. A transform applies to a value channel. An order sorts no axis of
 * this draw, thus it refuses.
 */
function resolve(
    context: FigureContext,
    rows: readonly ChartRow[],
    draw: ShapeDraw,
    member: string,
    channel: ChartChannel,
    numeric: boolean,
): Result<ShapeChannel, RenderProblem> {
    const column = channelColumn(channel);
    if (channelOrder(channel) !== undefined) {
        const reason = numeric ? "draws a value axis" : "draws no category axis";
        return err(chartProblem(context.blockId, `The "${member}" channel of the ${draw.figure} ${reason}, thus it takes no "orderBy".`));
    }
    if (rows.length > 0 && !columnPresent(column, rows, context.columns)) {
        return err(chartProblem(context.blockId, `The column "${column}" is absent from every row.`));
    }
    const transform = channelTransform(channel);
    if (!numeric && transform !== undefined) {
        return err(chartProblem(context.blockId, `The "${member}" channel of the ${draw.figure} names categories, thus it takes no transform.`));
    }
    if (transform !== undefined) {
        return ok({ name: `${transform}(${column})`, values: transformColumn(rows, column, transform) });
    }
    if (numeric) {
        for (const row of rows) {
            const cell = row[column];
            if (typeof cell === "string" && cell.trim() !== "" && toNumber(cell) === null) {
                return err(
                    chartProblem(context.blockId, `The column "${column}" holds the text "${cell}", and the ${draw.figure} draws "${member}" on a value axis.`),
                );
            }
        }
    }
    return ok({ name: column, values: rows.map((row) => row[column] ?? null) });
}

/** One point of the shape draw: its row, its pair, and its two categories. */
interface ShapedPoint {
    readonly index: number;
    readonly x: number;
    readonly y: number;
    readonly group?: string;
    readonly shape?: string;
}

/** Derive the shape draw of a PCA or of a plain scatter. */
function deriveShapeDraw(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext, draw: ShapeDraw): Result<EchartOption, RenderProblem> {
    const encoding = block.encoding ?? {};
    if (encoding.x === undefined || encoding.y === undefined) {
        const missing = encoding.x === undefined ? "x" : "y";
        return err(chartProblem(block.id, `The ${draw.figure} chart needs a column for the "${missing}" channel.`));
    }
    const x = resolve(context, rows, draw, "x", encoding.x, true);
    if (x.isErr()) return err(x.error);
    const y = resolve(context, rows, draw, "y", encoding.y, true);
    if (y.isErr()) return err(y.error);
    let groups: ShapeChannel | undefined;
    if (encoding.group !== undefined) {
        const group = resolve(context, rows, draw, "group", encoding.group, false);
        if (group.isErr()) return err(group.error);
        groups = group.value;
    }
    let shapes: ShapeChannel | undefined;
    if (encoding.shape !== undefined) {
        const shape = resolve(context, rows, draw, "shape", encoding.shape, false);
        if (shape.isErr()) return err(shape.error);
        shapes = shape.value;
    }
    const labelColumn = encoding.label;
    if (labelColumn !== undefined && rows.length > 0 && !columnPresent(labelColumn, rows, context.columns)) {
        return err(chartProblem(block.id, `The column "${labelColumn}" is absent from every row.`));
    }

    const points: ShapedPoint[] = [];
    for (let index = 0; index < rows.length; index += 1) {
        const px = toNumber(x.value.values[index]);
        const py = toNumber(y.value.values[index]);
        const pg = groups?.values[index] ?? null;
        const ps = shapes?.values[index] ?? null;
        if (px === null || py === null || (groups !== undefined && pg === null) || (shapes !== undefined && ps === null)) continue;
        points.push({ index, x: px, y: py, ...(pg !== null ? { group: categoryName(pg) } : {}), ...(ps !== null ? { shape: categoryName(ps) } : {}) });
    }

    const groupNames = firstAppearance(points.flatMap((point) => (point.group === undefined ? [] : [point.group])));
    const shapeNames = firstAppearance(points.flatMap((point) => (point.shape === undefined ? [] : [point.shape])));
    if (shapeNames.length > SHAPE_SYMBOLS.length) {
        return err(
            chartProblem(
                block.id,
                `The "shape" channel holds ${shapeNames.length} categories, and a symbol reads for ${SHAPE_SYMBOLS.length} at most. Draw that column as the "group" channel.`,
            ),
        );
    }
    const shared = groups !== undefined && shapes !== undefined ? groupNames.find((name) => shapeNames.includes(name)) : undefined;
    if (shared !== undefined) {
        return err(chartProblem(block.id, `The value "${shared}" names a group and a shape, thus the legend cannot tell the two keys apart.`));
    }

    const ranges = equalRanges(
        points.map((point) => point.x),
        points.map((point) => point.y),
        { pad: PCA_PAD, round: true },
    );
    const palette = categoricalPalette(groupNames.length);
    const yTitle = valueAxisTitle(context.labels, y.value.name);
    const named = labelColumn !== undefined;
    const labeled = named && draw.labelRows > 0 && points.length <= draw.labelRows;
    const sides = new Map<number, NameSide>();
    if (labeled && labelColumn !== undefined) {
        const placed = pointNameSides(
            points.map((point) => ({ x: point.x, y: point.y, text: String(rows[point.index][labelColumn] ?? "") })),
            ranges,
            SHAPED_POINT_PX,
        );
        for (const [place, point] of points.entries()) sides.set(point.index, placed[place]);
    }
    const buckets = new Map<string, ShapedPoint[]>();
    for (const point of points) {
        const key = bucketKey(point.group, point.shape);
        const bucket = buckets.get(key);
        if (bucket === undefined) buckets.set(key, [point]);
        else bucket.push(point);
    }
    const series: EchartOption[] = [];
    const groupKeys: ReadonlyArray<string | undefined> = groups === undefined ? [undefined] : groupNames;
    const shapeKeys: ReadonlyArray<string | undefined> = shapes === undefined ? [undefined] : shapeNames;
    for (const [groupPlace, groupKey] of groupKeys.entries()) {
        for (const [shapePlace, shapeKey] of shapeKeys.entries()) {
            const members = buckets.get(bucketKey(groupKey, shapeKey));
            if (members === undefined) continue;
            series.push({
                type: "scatter",
                name: groupKey ?? shapeKey ?? yTitle,
                ...(shapeKey !== undefined ? { symbol: SHAPE_SYMBOLS[shapePlace] } : {}),
                symbolSize: SHAPED_POINT_PX,
                itemStyle: { color: groupKey !== undefined ? palette[groupPlace] : CHART_PALETTE[0] },
                ...(labeled ? POINT_LABEL_FIELDS : {}),
                data: members.map((point) => {
                    const pair = [point.x, point.y];
                    const name = labelColumn === undefined ? undefined : rows[point.index][labelColumn];
                    if (name === undefined) return pair;
                    const side = sides.get(point.index);
                    return { value: pair, name: String(name), ...(side !== undefined && side !== "right" ? { label: { position: side } } : {}) };
                }),
            });
        }
    }

    // A shape beside a group keys its symbols in a series of no data, thus the legend draws the symbol in ink.
    if (groups !== undefined && shapes !== undefined) {
        for (const [place, name] of shapeNames.entries()) {
            series.push({ type: "scatter", name, symbol: SHAPE_SYMBOLS[place], symbolSize: SHAPED_POINT_PX, itemStyle: { color: CHART_INK }, data: [] });
        }
    }
    const entries = [
        ...(groups !== undefined ? groupNames.map((name) => ({ name, icon: POINT_LEGEND_ICON })) : []),
        ...(shapes !== undefined ? shapeNames.map((name, place) => ({ name, icon: SHAPE_SYMBOLS[place] })) : []),
    ];
    const keyed = entries.length > 1;

    const xTitle = valueAxisTitle(context.labels, x.value.name);
    const option: EchartOption = {
        tooltip: named ? { ...NAMED_POINT_TOOLTIP } : { ...PLAIN_POINT_TOOLTIP },
        series,
        legend: keyed ? { orient: draw.equalUnits ? "vertical" : "horizontal", ...(draw.equalUnits ? {} : { bottom: 0 }), data: entries } : { show: false },
    };
    if (!draw.equalUnits) {
        return ok({ ...option, xAxis: valueAxis("x", xTitle, { scale: true }), yAxis: valueAxis("y", yTitle, { scale: true }) });
    }
    const layout = squareLayout({ panels: 1, margins: PCA_MARGINS, side: keyed ? PCA_LEGEND_BAND_PX : 0, legend: keyed });
    const interval = ranges.step !== undefined ? { interval: ranges.step } : {};
    return ok({
        ...option,
        grid: layout.grid,
        xAxis: { ...valueAxis("x", xTitle, ranges.x), ...interval },
        yAxis: { ...valueAxis("y", yTitle, ranges.y), ...interval },
        ...(keyed && layout.legend !== undefined ? { legend: { ...(option.legend as EchartOption), ...layout.legend } } : {}),
        media: layout.media,
    });
}

/** The key of the split of one group and one shape. An absent member names no channel. */
function bucketKey(group: string | undefined, shape: string | undefined): string {
    return JSON.stringify([group ?? null, shape ?? null]);
}
