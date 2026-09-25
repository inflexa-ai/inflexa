/**
 * The SVG export of one chart: the server-side render of the chart runtime at a journal column width.
 *
 * The export renders the option of the page with every row inline, in the print theme, through the same
 * named renderers as the page. Thus the chart that a reader sees is the chart that the paper gets.
 *
 * The bytes are a pure function of the option. The chart runtime numbers its instances and its style
 * classes with counters of the whole process, thus two renders of one option differ in those tokens alone.
 * The export renumbers each token in order of first appearance, and two renders give one byte sequence.
 */

import { createHash } from "node:crypto";

import type * as Echarts from "echarts";
import { err, ok, type Result } from "neverthrow";

import type { EchartOption } from "./chart.js";
import { exportOption, OUTLINE_RENDERER, registerChartRenderers } from "./chart-renderers.js";
import {
    CHART_BODY_PX,
    CHART_EXPORT_SIZES,
    CHART_PRINT_THEME_NAME,
    CHART_PRINT_TEXT_PX,
    chartTheme,
    exportSizeFor,
    SCATTER_CROWD_ROWS,
    type ChartExportSize,
} from "./design.js";
import { millimeterRoot } from "./hybrid-svg.js";
import type { DataAsset } from "./table-data.js";
import type { RenderProblem } from "./types.js";

/** One instance token of the chart runtime: a class, a clip path, or a gradient, for example `zr1-cls-2`. */
const INSTANCE_TOKEN = /zr\d+-[a-z]+-?\d+/g;

/**
 * The places where the chart runtime writes an instance token: the value of an `id` or a `class` attribute,
 * a `url(#...)` reference, and the style block. A text node is none of them, thus a category name that
 * reads as a token keeps its text.
 */
const TOKEN_PLACES = /\s(?:id|class)="[^"]*"|url\(#[^)]*\)|<style[^>]*>[\s\S]*?<\/style>/g;

/** The count of hash characters in an asset name. It matches the name of a table asset. */
const HASH_CHARS = 12;

/** The module of the chart runtime. The SVG export draws with it on the server. */
export type ChartRuntime = typeof Echarts;

/**
 * Load the chart runtime.
 *
 * The runtime loads on the first export and not with this module. The harness entry reaches this module, thus
 * a static import makes each process that loads the harness pay for the runtime, also a process that exports
 * no chart. The module cache keeps the first load, thus a later call costs nothing.
 */
export function loadChartRuntime(): Promise<ChartRuntime> {
    return import("echarts");
}

/** The two SVG files of one chart: the single journal column and the double journal column. */
export interface ChartSvgs {
    readonly single: DataAsset;
    readonly double: DataAsset;
}

/**
 * Render one option to SVG text at one column size.
 *
 * The export registers the print theme and each named renderer before it draws, and each registration of
 * one name gives the same theme or the same function. The chart runtime is code outside the harness, thus its
 * throw becomes the message of an `err`. The instance is disposed in every case, thus no render leaves a timer
 * behind.
 */
export function renderChartSvg(echarts: ChartRuntime, option: EchartOption, size: ChartExportSize): Result<string, string> {
    echarts.registerTheme(CHART_PRINT_THEME_NAME, chartTheme(CHART_PRINT_TEXT_PX));
    registerChartRenderers({
        // The runtime types each item dimension as a string or a number. Each item that the derivation writes
        // for a named renderer holds numbers alone, thus the renderer reads a number at each dimension.
        registerCustomSeries: (name, render) => echarts.registerCustomSeries(name, render as unknown as Echarts.CustomSeriesRenderItem),
    });
    let chart: Echarts.ECharts | undefined;
    // The axis jitter of the chart runtime places a point that finds no free place with `Math.random`. The
    // render below runs to its end in one synchronous call, thus the seeded sequence serves this render alone,
    // and the same option gives the same points and the same bytes. The finally block puts the global back.
    const random = Math.random;
    Math.random = seededRandom(EXPORT_RANDOM_SEED);
    try {
        chart = echarts.init(null, CHART_PRINT_THEME_NAME, { renderer: "svg", ssr: true, width: size.widthPx, height: size.heightPx });
        chart.setOption(exportOption(option, CHART_PRINT_TEXT_PX, size.widthPx, size.heightPx));
        return ok(finishedSvg(chart.renderToSVGString(), size));
    } catch (cause) {
        return err(cause instanceof Error ? cause.message : String(cause));
    } finally {
        Math.random = random;
        chart?.dispose();
    }
}

/** The seed of the sequence that stands for `Math.random` during one export. Any fixed value serves. */
const EXPORT_RANDOM_SEED = 0x2f6b1e35;

/**
 * A deterministic sequence of numbers in `[0, 1)` from one seed: the mulberry32 generator. Each call of the
 * returned function gives the next number.
 */
function seededRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * The SVG text with its root at the millimeter size, and with each instance token renumbered.
 *
 * The root states the width and the height of the column in millimeters, and the view box keeps the pixel
 * space of the render. Thus a vector editor opens the file at the column width. The renumber reads the
 * places of the tokens in document order in one pass, thus the style block, each clip path, each gradient,
 * and each element that names one of them agree.
 */
function finishedSvg(svg: string, size: ChartExportSize): string {
    const tokens = new Map<string, string>();
    const renumber = (token: string): string => {
        let next = tokens.get(token);
        if (next === undefined) {
            const family = /^zr\d+-([a-z]+)/.exec(token)?.[1] ?? "t";
            next = `zr0-${family}-${tokens.size}`;
            tokens.set(token, next);
        }
        return next;
    };
    return millimeterRoot(
        svg.replace(TOKEN_PLACES, (place) => place.replace(INSTANCE_TOKEN, renumber)),
        size,
    );
}

/**
 * The count of coordinates that one option draws, summed over its series.
 *
 * The count bounds the export. A cloud of many thousands of points gives an SVG of many megabytes, two times,
 * thus the page builds the SVG of such a chart on a click, with the points as one raster layer. An empty slot draws nothing, thus it counts nothing. A radar
 * polygon draws one coordinate for each indicator, and a violin outline draws two vertices for each grid
 * point, thus each counts every coordinate that it draws.
 */
function plottedPoints(option: EchartOption): number {
    const series = option.series;
    if (!Array.isArray(series)) return 0;
    let count = 0;
    for (const entry of series) {
        if (typeof entry !== "object" || entry === null) continue;
        const fields = entry as EchartOption;
        if (!Array.isArray(fields.data)) continue;
        for (const item of fields.data) {
            if (fields.type === "radar") count += polygonCoordinates(item);
            else if (fields.renderItem === OUTLINE_RENDERER) count += outlineVertices(item);
            else count += drawnItem(item) ? 1 : 0;
        }
    }
    return count;
}

/** True when one item draws a coordinate: a number, or a value whose members hold no empty slot. */
function drawnItem(item: unknown): boolean {
    const value = typeof item === "object" && item !== null && !Array.isArray(item) ? (item as EchartOption).value : item;
    if (typeof value === "number") return true;
    return Array.isArray(value) && value.every((member) => member !== null && member !== undefined && member !== "-");
}

/**
 * The count of vertices that one violin outline draws. The item leads with the category, the extent, and the
 * offset, then holds one pair for each grid point, and the outline draws each point on its right side and on
 * its left side.
 */
function outlineVertices(item: unknown): number {
    return Array.isArray(item) ? Math.max(0, item.length - OUTLINE_LEAD_MEMBERS) : 0;
}

/** The members of an outline item before its grid pairs: the category, the two ends of the extent, and the offset. */
const OUTLINE_LEAD_MEMBERS = 4;

/** The count of coordinates that one radar polygon draws: each member of its value that is not empty. */
function polygonCoordinates(item: unknown): number {
    const value = typeof item === "object" && item !== null ? (item as EchartOption).value : undefined;
    return Array.isArray(value) ? value.filter((member) => member !== null && member !== undefined).length : 0;
}

/** One SVG asset: the content-addressed name, with the column in millimeters, and the text. */
function svgAsset(bytes: string, size: ChartExportSize): DataAsset {
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, HASH_CHARS);
    return { name: `c-${hash}-${size.widthMm}mm.svg`, bytes };
}

/**
 * The two SVG files of one chart, or `undefined` for a chart past the export bound.
 *
 * The option is the chart with every row inline. A chart whose plotted point count passes the crowd row
 * count gets no staged SVG. The page builds the hybrid SVG of such a chart, or the menu states that the PNG
 * serves a chart that holds no point layer. An option that the chart runtime cannot
 * draw refuses, and the refusal names the block.
 *
 * `bodyPx` is the height of the page chart body. A taller body draws each column at a taller height, thus a
 * row of the figure keeps its share of the height.
 */
export function chartSvgAssets(
    echarts: ChartRuntime,
    blockId: string,
    option: EchartOption,
    bodyPx: number = CHART_BODY_PX,
): Result<ChartSvgs | undefined, RenderProblem> {
    if (plottedPoints(option) > SCATTER_CROWD_ROWS) {
        return ok(undefined);
    }
    const singleSize = exportSizeFor(CHART_EXPORT_SIZES.single, bodyPx);
    const doubleSize = exportSizeFor(CHART_EXPORT_SIZES.double, bodyPx);
    const single = renderChartSvg(echarts, option, singleSize);
    if (single.isErr()) return err(exportProblem(blockId, single.error));
    const double = renderChartSvg(echarts, option, doubleSize);
    if (double.isErr()) return err(exportProblem(blockId, double.error));
    return ok({ single: svgAsset(single.value, singleSize), double: svgAsset(double.value, doubleSize) });
}

/** The refusal of an option that the chart runtime refused to draw. */
function exportProblem(blockId: string, cause: string): RenderProblem {
    return { blockId, kind: "invalid-chart-input", detail: `The chart runtime refused to draw the SVG export of the chart: ${cause}` };
}
