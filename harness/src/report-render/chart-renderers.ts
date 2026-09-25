/**
 * The named renderers of a custom series, in two twins.
 *
 * The chart runtime draws an interval, a violin outline, an oncoprint cell, and a lollipop stem through a
 * `custom` series. The option rides to the page as inline JSON, thus it holds no function. The derivation
 * writes the name of a renderer as the `renderItem` string, and the chart runtime finds the function under
 * that name in its own registry. Each consumer registers each renderer with `registerCustomSeries` before it
 * draws: the page bootstrap through the source text below, and the server export through the TypeScript
 * functions. A series that needs parameters beyond its items carries them as JSON in `itemPayload`, and the
 * renderer reads them from its first argument.
 *
 * The two twins hold one rule each. A shared test vector runs both over one set of items with a stub of the
 * runtime, and it compares the elements that they give. Thus the two cannot drift in silence.
 *
 * A category axis rounds a data coordinate to its category, thus a renderer never adds a fraction of a
 * category to a coordinate. It takes the band of one category in pixels from the runtime, and it shifts the
 * pixel position by a fraction of that band.
 *
 * The export option lives here too, in the same two twins: the server draws the SVG through it, and the page
 * draws each PNG through it.
 */

import { CHART_INK, CHART_PAGE_TEXT_PX, COLOR_SCALE_BAND_PCT, GUIDE_LINE_COLOR } from "./design.js";

/** The renderer name of an interval: an error bar, a confidence interval, or the inner mark of a violin. */
export const INTERVAL_RENDERER = "interval";

/** The renderer name of a violin outline. */
export const OUTLINE_RENDERER = "outline";

/** The renderer name of one oncoprint cell: the gray ground and the glyph of its alteration class. */
export const CELL_GLYPH_RENDERER = "cell-glyph";

/** The renderer name of one lollipop mutation: a stem from zero and a head at its count. */
export const STEM_RENDERER = "stem";

/** The gap between two oncoprint cells, in pixels. */
export const CELL_GAP_PX = 1;

/**
 * The largest share of one cell band that the gap takes. A cohort of some hundred samples at a column width
 * gives a band near one pixel, and a full pixel of gap would erase each cell.
 */
const CELL_GAP_MAX_SHARE = 0.25;

/** The share of the ground height that the glyph of a class covers. The gray ground shows above and below it. */
export const CELL_GLYPH_SHARE = 0.6;

/** The radius of the head of a lollipop stem, in pixels. */
export const STEM_HEAD_RADIUS_PX = 3.5;

/** The count of grid points of one violin outline. Each item of an outline holds one pair for each point. */
export const VIOLIN_GRID_POINTS = 64;

/** The half length of the cap at each bound of an error bar, in pixels. */
export const INTERVAL_CAP_PX = 4;

/** The stroke width of an error bar and of its caps, in pixels. */
const INTERVAL_STROKE_PX = 1.5;

/** The stroke width of the quartile line of a violin, in pixels. It reads as a thin box inside the outline. */
const INNER_STROKE_PX = 3;

/** The radius of the median point of a violin, in pixels. */
const INNER_POINT_RADIUS_PX = 2.5;

/** The fill of the median point of a violin. A light point reads on the dark quartile line. */
const INNER_POINT_FILL = "#ffffff";

/** The opacity of a violin outline. The quartile line inside it stays readable. */
const OUTLINE_OPACITY = 0.75;

/** The first argument of a renderer: the JSON parameters that the series carries in `itemPayload`. */
export interface RenderParams {
    readonly itemPayload?: Readonly<Record<string, unknown>>;
}

/** The part of the chart runtime that a renderer reads. */
export interface RenderApi {
    value(dimension: number): number;
    coord(point: number[]): number[];
    size(delta: number[]): number[];
    visual(name: "color"): string;
}

/** One graphic element that a renderer gives back to the chart runtime. */
export interface RenderedElement {
    type: string;
    shape?: Record<string, unknown>;
    style?: Record<string, unknown>;
    children?: RenderedElement[];
}

/** One straight segment in the ink of the chart. */
function segment(x1: number, y1: number, x2: number, y2: number, width: number): RenderedElement {
    return { type: "line", shape: { x1, y1, x2, y2 }, style: { stroke: CHART_INK, lineWidth: width } };
}

/**
 * Draw one interval.
 *
 * An item is `[x, y, low, high, axis, offset, mark]`. `axis` is `0` for an interval along x and `1` for one
 * along y. `offset` is a fraction of one category band, and it moves the interval over its own bar in a
 * grouped chart. `mark` is `0` for an error bar with two caps, and `1` for the inner mark of a violin: a
 * thick quartile line and one point at the median, which is the anchor `y`.
 */
export function intervalRenderer(_params: RenderParams, api: RenderApi): RenderedElement {
    const x = api.value(0);
    const y = api.value(1);
    const low = api.value(2);
    const high = api.value(3);
    const alongX = api.value(4) === 0;
    const offset = api.value(5);
    const inner = api.value(6) === 1;
    const band = alongX ? api.size([0, 1])[1] : api.size([1, 0])[0];
    const shift = offset * band;
    const from = api.coord(alongX ? [low, y] : [x, low]);
    const to = api.coord(alongX ? [high, y] : [x, high]);
    const anchor = api.coord([x, y]);
    const fromX = alongX ? from[0] : from[0] + shift;
    const fromY = alongX ? from[1] + shift : from[1];
    const toX = alongX ? to[0] : to[0] + shift;
    const toY = alongX ? to[1] + shift : to[1];
    if (inner) {
        return {
            type: "group",
            children: [
                segment(fromX, fromY, toX, toY, INNER_STROKE_PX),
                {
                    type: "circle",
                    shape: { cx: alongX ? anchor[0] : anchor[0] + shift, cy: alongX ? anchor[1] + shift : anchor[1], r: INNER_POINT_RADIUS_PX },
                    style: { fill: INNER_POINT_FILL, stroke: CHART_INK, lineWidth: 1 },
                },
            ],
        };
    }
    const children = [segment(fromX, fromY, toX, toY, INTERVAL_STROKE_PX)];
    for (const [endX, endY] of [
        [fromX, fromY],
        [toX, toY],
    ]) {
        children.push(
            alongX
                ? segment(endX, endY - INTERVAL_CAP_PX, endX, endY + INTERVAL_CAP_PX, INTERVAL_STROKE_PX)
                : segment(endX - INTERVAL_CAP_PX, endY, endX + INTERVAL_CAP_PX, endY, INTERVAL_STROKE_PX),
        );
    }
    return { type: "group", children };
}

/**
 * Draw one violin outline.
 *
 * An item is `[c, yMin, yMax, offset, w1, y1, w2, y2, ...]` with one pair for each grid point. `c` is the
 * category index, `yMin` and `yMax` are the extent of the grid, and `offset` is a fraction of one band that
 * moves a grouped violin inside its band. Each pair is a half-width in band fractions and its grid value.
 * The outline runs up the right side and down the left side, thus the polygon closes on itself.
 */
export function outlineRenderer(_params: RenderParams, api: RenderApi): RenderedElement {
    const category = api.value(0);
    const band = api.size([1, 0])[0];
    const center = api.value(3) * band;
    const right: number[][] = [];
    const left: number[][] = [];
    for (let point = 0; point < VIOLIN_GRID_POINTS; point += 1) {
        const width = api.value(4 + 2 * point) * band;
        const at = api.coord([category, api.value(5 + 2 * point)]);
        right.push([at[0] + center + width, at[1]]);
        left.push([at[0] + center - width, at[1]]);
    }
    const color = api.visual("color");
    return {
        type: "polygon",
        shape: { points: right.concat(left.reverse()) },
        style: { fill: color, stroke: color, lineWidth: 1, opacity: OUTLINE_OPACITY },
    };
}

/**
 * Draw one oncoprint cell.
 *
 * An item is `[x, y, class]`. `x` and `y` are the places of the sample and the gene on the two category axes,
 * and `class` is the place of the alteration class in the `colors` list of the payload, or `-1` for a cell
 * with no alteration. Each cell draws the `ground` color of the payload over its band less one gap. An altered
 * cell adds one glyph in the color of its class: the width of the ground and a share of its height, centered.
 */
export function cellGlyphRenderer(params: RenderParams, api: RenderApi): RenderedElement {
    const payload = params.itemPayload ?? {};
    const colors = Array.isArray(payload.colors) ? payload.colors : [];
    const ground = typeof payload.ground === "string" ? payload.ground : CHART_INK;
    const center = api.coord([api.value(0), api.value(1)]);
    const klass = api.value(2);
    const band = api.size([1, 1]);
    const width = band[0] - Math.min(CELL_GAP_PX, band[0] * CELL_GAP_MAX_SHARE);
    const height = band[1] - Math.min(CELL_GAP_PX, band[1] * CELL_GAP_MAX_SHARE);
    const children: RenderedElement[] = [
        { type: "rect", shape: { x: center[0] - width / 2, y: center[1] - height / 2, width, height }, style: { fill: ground } },
    ];
    if (klass >= 0 && klass < colors.length) {
        const glyph = height * CELL_GLYPH_SHARE;
        children.push({ type: "rect", shape: { x: center[0] - width / 2, y: center[1] - glyph / 2, width, height: glyph }, style: { fill: colors[klass] } });
    }
    return { type: "group", children };
}

/**
 * Draw one lollipop mutation.
 *
 * An item is `[x, y]`: the amino-acid position and the count. The stem is a thin gray line from the value `0`
 * to the count, and the head is one circle at the count in the color of the series.
 */
export function stemRenderer(_params: RenderParams, api: RenderApi): RenderedElement {
    const x = api.value(0);
    const floor = api.coord([x, 0]);
    const head = api.coord([x, api.value(1)]);
    return {
        type: "group",
        children: [
            { type: "line", shape: { x1: floor[0], y1: floor[1], x2: head[0], y2: head[1] }, style: { stroke: GUIDE_LINE_COLOR, lineWidth: 1 } },
            {
                type: "circle",
                shape: { cx: head[0], cy: head[1], r: STEM_HEAD_RADIUS_PX },
                style: { fill: api.visual("color"), stroke: CHART_INK, lineWidth: 0.5 },
            },
        ],
    };
}

/** One renderer function: the parameters of its series and the part of the runtime that it reads. */
export type ChartRenderer = (params: RenderParams, api: RenderApi) => RenderedElement;

/**
 * One registered renderer: the name that a derived series states, the TypeScript function that the export
 * registers, and the name of the page twin in `CHART_RENDERERS_SOURCE` that the bootstrap registers.
 */
export interface ChartRendererEntry {
    readonly name: string;
    readonly render: ChartRenderer;
    readonly pageFunction: string;
}

/**
 * The registered renderers. A renderer joins by one entry here, beside its TypeScript function and its page
 * twin, and each consumer registers it under the same name.
 */
export const CHART_RENDERERS: readonly ChartRendererEntry[] = [
    { name: INTERVAL_RENDERER, render: intervalRenderer, pageFunction: "reportIntervalRenderer" },
    { name: OUTLINE_RENDERER, render: outlineRenderer, pageFunction: "reportOutlineRenderer" },
    { name: CELL_GLYPH_RENDERER, render: cellGlyphRenderer, pageFunction: "reportCellGlyphRenderer" },
    { name: STEM_RENDERER, render: stemRenderer, pageFunction: "reportStemRenderer" },
];

/** The part of the chart runtime that holds the registry of the named renderers. */
export interface RendererRegistry {
    registerCustomSeries(name: string, render: ChartRenderer): void;
}

/**
 * Register each renderer with the chart runtime. A second registration of one name replaces the first with
 * the same function, thus a caller registers before each draw and the runtime holds one function per name.
 */
export function registerChartRenderers(runtime: RendererRegistry): void {
    for (const entry of CHART_RENDERERS) {
        runtime.registerCustomSeries(entry.name, entry.render);
    }
}

/**
 * The member of an option that holds the series of each export width, for a figure whose text the derivation
 * places itself.
 *
 * A name that the derivation places clears its neighbors at one plot size and one text size alone. Thus the
 * figure places its names again for the plot of each export, and the export takes the series of its width in
 * place of the page series of the same names. The member is no field of the chart runtime, and the runtime
 * keeps an unknown member without a draw.
 */
export const SIZED_SERIES_MEMBER = "sizedSeries";

/** The series of each export width: the names of the page series that they replace, and the series of each width. */
export interface SizedSeries {
    readonly names: readonly string[];
    readonly widths: Readonly<Record<string, readonly unknown[]>>;
}

/**
 * The series of an option with the page series of the sized names replaced by the series of one export width.
 * A width that the member does not hold keeps the page series.
 */
function sizedSeries(series: unknown, sized: unknown, widthPx: number): unknown {
    if (!Array.isArray(series) || typeof sized !== "object" || sized === null) return series;
    const fields = sized as Record<string, unknown>;
    const widths = fields.widths as Record<string, unknown> | undefined;
    const chosen = typeof widths === "object" && widths !== null ? widths[String(widthPx)] : undefined;
    if (!Array.isArray(fields.names) || !Array.isArray(chosen)) return series;
    const names = fields.names as unknown[];
    const kept = series.filter((entry: unknown) => typeof entry !== "object" || entry === null || names.indexOf((entry as Record<string, unknown>).name) < 0);
    return kept.concat(chosen);
}

/**
 * One axis, or one list of axes, with each gap that clears its text scaled to the text size of an export: the
 * name gap, and the offset of an axis past a column of text.
 */
function scaledAxes(axes: unknown, scale: number): unknown {
    if (Array.isArray(axes)) return axes.map((axis) => scaledAxes(axis, scale));
    if (typeof axes !== "object" || axes === null) return axes;
    const axis = { ...(axes as Record<string, unknown>) };
    if (typeof axis.nameGap === "number") axis.nameGap = axis.nameGap * scale;
    if (typeof axis.offset === "number") axis.offset = axis.offset * scale;
    return axis;
}

/**
 * One graphic element with its text scaled to the text size of an export, and the text of each child of a
 * group. A facet panel label is such an element, and the size legend is such a group.
 */
function scaledGraphic(element: unknown, scale: number): unknown {
    if (typeof element !== "object" || element === null) return element;
    const out = { ...(element as Record<string, unknown>) };
    const style = out.style as Record<string, unknown> | undefined;
    if (style !== undefined && typeof style.fontSize === "number") out.style = { ...style, fontSize: style.fontSize * scale };
    if (Array.isArray(out.children)) out.children = out.children.map((child: unknown) => scaledGraphic(child, scale));
    return out;
}

/** The width of one character of the chart text, as a share of the text size. The export guesses a label width with it. */
const CHARACTER_SHARE = 0.6;

/** The share of the export width that the category labels of one x axis can fill. */
const LABEL_ROOM = 0.8;

/**
 * One x axis of categories with its labels turned where they do not fit the width of the export.
 *
 * The page turns the labels by their count. A column export is narrower, thus it turns the labels whose
 * longest name, at the export text size, passes the width of one category. A label that needs more than two
 * widths turns upright. An authored turn stays.
 */
function fittedCategories(axis: unknown, textPx: number, widthPx: number): unknown {
    if (typeof axis !== "object" || axis === null || Array.isArray(axis)) return axis;
    const fields = axis as Record<string, unknown>;
    const data = fields.data;
    if (fields.type !== "category" || !Array.isArray(data) || data.length === 0) return axis;
    const label = typeof fields.axisLabel === "object" && fields.axisLabel !== null ? (fields.axisLabel as Record<string, unknown>) : {};
    if (typeof label.rotate === "number" && label.rotate !== 0) return axis;
    let longest = 0;
    for (const name of data) longest = Math.max(longest, String(name).length);
    const need = longest * textPx * CHARACTER_SHARE;
    const room = (widthPx * LABEL_ROOM) / data.length;
    if (need <= room) return axis;
    return { ...fields, axisLabel: { ...label, rotate: need > 2 * room ? 90 : 45 } };
}

/** The share of the scale band that one line of a scale title can fill. The rest keeps a gap to the plot. */
const SCALE_TITLE_ROOM = 0.8;

/**
 * The title of a still color scale, wrapped at its spaces into lines that fit the scale band.
 *
 * The chart runtime centers the title over the bar and lays the scale out at the right edge. A title wider
 * than the band pushes the scale box into the plot. The width of a line is the estimate of the export: each
 * character takes a fixed share of the text size. One word longer than a line stays whole.
 */
function wrappedTitle(title: string, textPx: number, widthPx: number): string {
    const perLine = Math.max(1, Math.floor((widthPx * COLOR_SCALE_BAND_PCT * SCALE_TITLE_ROOM) / 100 / (textPx * CHARACTER_SHARE)));
    const lines: string[] = [];
    let line = "";
    for (const word of title.split(" ")) {
        if (line === "") {
            line = word;
        } else if (line.length + 1 + word.length <= perLine) {
            line = `${line} ${word}`;
        } else {
            lines.push(line);
            line = word;
        }
    }
    if (line !== "") lines.push(line);
    return lines.join("\n");
}

/**
 * The width in pixels of the grid that one axis draws in. A facet states the width of each grid in percent of
 * the chart, and a chart of one grid spans the export width.
 */
function gridWidth(grid: unknown, axis: unknown, widthPx: number): number {
    const place =
        typeof axis === "object" && axis !== null && typeof (axis as Record<string, unknown>).gridIndex === "number"
            ? ((axis as Record<string, unknown>).gridIndex as number)
            : 0;
    const entry = Array.isArray(grid) ? grid[place] : grid;
    const width = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).width : undefined;
    if (typeof width === "string" && width.endsWith("%")) return (widthPx * Number.parseFloat(width)) / 100;
    if (typeof width === "number") return width;
    return widthPx;
}

/** One x axis, or each x axis of a facet, with its category labels fitted to the width of its own grid. */
function fittedAxes(axes: unknown, grid: unknown, textPx: number, widthPx: number): unknown {
    if (!Array.isArray(axes)) return fittedCategories(axes, textPx, gridWidth(grid, axes, widthPx));
    return axes.map((axis: unknown) => fittedCategories(axis, textPx, gridWidth(grid, axis, widthPx)));
}

/**
 * One continuous color map of an export, with its title wrapped into the band of the scale.
 *
 * The page prints the title and the upper end over the scale, one line each, and the lower end under it. The
 * export keeps the two ends and wraps the title into the band of the scale. The scale starts at the top of the
 * plot and stays short, thus its lower end never meets the labels of the x axis. A map that shows nothing, that
 * prints no end, or that draws pieces and no scale passes through.
 */
function stillScale(map: unknown, textPx: number, widthPx: number): unknown {
    if (typeof map !== "object" || map === null) return map;
    const fields = map as Record<string, unknown>;
    const text = fields.text;
    if (fields.show === false || fields.type === "piecewise" || !Array.isArray(text) || typeof text[0] !== "string" || typeof text[1] !== "string") return map;
    const lines = text[0].split("\n");
    const upper = lines[lines.length - 1];
    const title = lines.slice(0, -1).join(" ");
    return {
        ...fields,
        top: STILL_SCALE_TOP,
        itemHeight: STILL_SCALE_LINES * textPx,
        text: [title === "" ? upper : `${wrappedTitle(title, textPx, widthPx)}\n${upper}`, text[1]],
    };
}

/** The top of a still color scale, which is the top margin of the grid, and its length in lines of the text. */
const STILL_SCALE_TOP = "8%";
const STILL_SCALE_LINES = 8;

/** The height of the legend band of an export, in lines of its text. */
const LEGEND_BAND_LINES = 2.5;

/** The outer bounds mode of a facet panel: the labels of the panel stay inside the box of its grid. */
const PANEL_BOUNDS_MODE = "same";

/** The item gap of the legend in the theme, in pixels. Two lines of a legend that wraps stand one gap apart. */
const LEGEND_ITEM_GAP_PX = 16;

/** The line pitch of the legend text, and the height of the x title of a facet, as a share of the text size. */
const LEGEND_LINE_SHARE = 1.25;
const FACET_TITLE_SHARE = 1.6;

/** The padding of the legend box at each side, in pixels: the default of the chart runtime. */
const LEGEND_PADDING_PX = 5;

/**
 * The smallest share of its page height that the lowest row of facet panels keeps in an export. The single column
 * wraps a legend of many names into more lines than its height holds, thus such a legend draws in one line that
 * scrolls, and the panels keep their room.
 */
const PANEL_MIN_SHARE = 0.5;

/**
 * The height of the band of a bottom legend of some lines, in pixels: one line pitch and one item gap for each
 * line, and one text size under the lowest line.
 */
function legendBand(lines: number, textPx: number): number {
    return Math.round(lines * (textPx * LEGEND_LINE_SHARE + LEGEND_ITEM_GAP_PX) + textPx);
}

/**
 * The count of lines of a horizontal legend at one width. An entry is the icon of the text size, the gap of
 * five pixels to its text, and the text. The entries fill each line in order, one item gap apart. The names
 * are the data of the legend, or else the name of each series in order of first appearance.
 */
function legendLines(option: Record<string, unknown>, textPx: number, widthPx: number): number {
    const legend = option.legend as Record<string, unknown>;
    const names: string[] = [];
    if (Array.isArray(legend.data)) {
        for (const entry of legend.data) {
            const name = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).name : entry;
            if (typeof name === "string") names.push(name);
        }
    } else if (Array.isArray(option.series)) {
        for (const series of option.series) {
            const name = typeof series === "object" && series !== null ? (series as Record<string, unknown>).name : undefined;
            if (typeof name === "string" && name !== "" && names.indexOf(name) < 0) names.push(name);
        }
    }
    const room = widthPx - 2 * LEGEND_PADDING_PX;
    let lines = names.length === 0 ? 0 : 1;
    let used = 0;
    for (const name of names) {
        const entry = textPx + 5 + name.length * textPx * CHARACTER_SHARE;
        if (used > 0 && used + LEGEND_ITEM_GAP_PX + entry > room) {
            lines += 1;
            used = entry;
        } else {
            used = used > 0 ? used + LEGEND_ITEM_GAP_PX + entry : entry;
        }
    }
    return lines;
}

/**
 * A facet with its lowest row of panels and its x title held above the band of a bottom legend.
 *
 * The page reserves the legend band in percent of its body, and a narrow export wraps the legend into more
 * lines than that band holds. Each panel of the lowest row then ends its box over the x title, and the x title
 * sits on the band. A panel keeps its top, thus its label stays in place, and the labels of a panel stay
 * inside its box. A legend whose lines leave the lowest panels under `PANEL_MIN_SHARE` of their height draws in
 * one line that scrolls.
 */
function facetOverLegend(option: Record<string, unknown>, textPx: number, widthPx: number, heightPx: number): void {
    const grids = option.grid as unknown[];
    const title = Math.round(textPx * FACET_TITLE_SHARE);
    let lowest = 0;
    let reserve = 0;
    for (const grid of grids) {
        const bottom = panelBottom(grid);
        if (bottom <= lowest) continue;
        const fields = grid as Record<string, unknown>;
        lowest = bottom;
        reserve = Number.parseFloat(String(fields.top)) + Number.parseFloat(String(fields.height)) * PANEL_MIN_SHARE;
    }
    const lines = legendLines(option, textPx, widthPx);
    let band = legendBand(lines, textPx);
    if (lines > 1 && ((heightPx - band - title) / heightPx) * 100 < reserve) {
        option.legend = { ...(option.legend as Record<string, unknown>), type: "scroll" };
        band = legendBand(1, textPx);
    }
    const floor = ((heightPx - band - title) / heightPx) * 100;
    option.grid = grids.map((grid: unknown) => {
        const bottom = panelBottom(grid);
        if (bottom < lowest || bottom <= floor) return grid;
        const fields = grid as Record<string, unknown>;
        const top = Number.parseFloat(String(fields.top));
        return { ...fields, height: `${Math.round((floor - top) * 1e4) / 1e4}%` };
    });
    if (Array.isArray(option.graphic)) {
        option.graphic = option.graphic.map((element: unknown) =>
            typeof element === "object" && element !== null && (element as Record<string, unknown>).bottom !== undefined
                ? { ...(element as Record<string, unknown>), bottom: band }
                : element,
        );
    }
}

/** The bottom edge of one facet panel, in percent of the chart, or 0 for a grid that is no facet panel. */
function panelBottom(grid: unknown): number {
    if (typeof grid !== "object" || grid === null) return 0;
    const fields = grid as Record<string, unknown>;
    if (fields.outerBoundsMode !== PANEL_BOUNDS_MODE || typeof fields.top !== "string" || typeof fields.height !== "string") return 0;
    return Number.parseFloat(fields.top) + Number.parseFloat(fields.height);
}

/** True when an option lays out facet panels over a bottom legend. */
function holdsFacetLegend(option: Record<string, unknown>): boolean {
    const legend = option.legend as Record<string, unknown> | undefined;
    const bottom = typeof legend === "object" && legend !== null && legend.show !== false && legend.bottom !== undefined;
    return bottom && Array.isArray(option.grid) && option.grid.some((grid: unknown) => panelBottom(grid) > 0);
}

/** True when an option draws a legend along the bottom edge of a grid of one panel. */
function holdsBottomLegend(option: Record<string, unknown>): boolean {
    const legend = option.legend as Record<string, unknown> | undefined;
    const bottom = typeof legend === "object" && legend !== null && legend.show !== false && legend.bottom !== undefined;
    return bottom && option.xAxis !== undefined && !Array.isArray(option.grid);
}

/**
 * The option of one export at one text size.
 *
 * An export is a still figure. Thus it carries no tooltip, no toolbox, and no animation. The theme of the
 * export sets the text size, and the gap between an axis and its name, and the label of a facet panel, scale
 * with the text. The copy leaves the input as it is, thus the page keeps its own option.
 *
 * A column export is short and narrow. Thus the grid of a chart with a bottom legend holds its labels and its
 * names above a band of the legend height, and the panels of a facet end over the band of the legend lines
 * that the export width gives. The category labels turn where they do not fit the width, and a color scale
 * prints its ends as static text. A grid that contains its labels contains its names too.
 */
export function exportOption(option: Record<string, unknown>, textPx: number, widthPx: number, heightPx: number): Record<string, unknown> {
    const scale = textPx / CHART_PAGE_TEXT_PX;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(option)) {
        if (key === "tooltip" || key === "toolbox" || key === SIZED_SERIES_MEMBER) continue;
        out[key] = option[key];
    }
    if (out.series !== undefined) out.series = sizedSeries(out.series, option[SIZED_SERIES_MEMBER], widthPx);
    out.animation = false;
    if (out.xAxis !== undefined) out.xAxis = scaledAxes(out.xAxis, scale);
    if (out.yAxis !== undefined) out.yAxis = scaledAxes(out.yAxis, scale);
    if (Array.isArray(out.graphic)) out.graphic = out.graphic.map((element: unknown) => scaledGraphic(element, scale));
    if (out.xAxis !== undefined) out.xAxis = fittedAxes(out.xAxis, out.grid, textPx, widthPx);
    if (Array.isArray(out.visualMap)) out.visualMap = out.visualMap.map((map: unknown) => stillScale(map, textPx, widthPx));
    else if (out.visualMap !== undefined) out.visualMap = stillScale(out.visualMap, textPx, widthPx);
    if (typeof out.grid === "object" && out.grid !== null && !Array.isArray(out.grid) && (out.grid as Record<string, unknown>).containLabel === true) {
        // The legacy containment holds the labels alone, and a name at the edge of a short export is cut.
        out.grid = { ...(out.grid as Record<string, unknown>), containLabel: false, outerBoundsMode: "auto", outerBoundsContain: "all" };
    }
    if (holdsBottomLegend(out)) {
        const grid = typeof out.grid === "object" && out.grid !== null ? (out.grid as Record<string, unknown>) : {};
        out.grid = { ...grid, outerBoundsMode: "auto", outerBounds: { left: 0, right: 0, top: 0, bottom: Math.round(textPx * LEGEND_BAND_LINES) } };
    }
    if (holdsFacetLegend(out)) facetOverLegend(out, textPx, widthPx, heightPx);
    return out;
}

/**
 * The page twin of each renderer, of the bind step, and of the export option, as browser source text.
 *
 * Each function holds the rule of its TypeScript twin in the same order of operations. Thus the two give
 * the same numbers for one item, and the shared test vector compares them exactly.
 */
export const CHART_RENDERERS_SOURCE = `function reportSegment(x1, y1, x2, y2, width) {
  return { type: "line", shape: { x1: x1, y1: y1, x2: x2, y2: y2 }, style: { stroke: ${JSON.stringify(CHART_INK)}, lineWidth: width } };
}
function reportIntervalRenderer(params, api) {
  var x = api.value(0);
  var y = api.value(1);
  var low = api.value(2);
  var high = api.value(3);
  var alongX = api.value(4) === 0;
  var offset = api.value(5);
  var inner = api.value(6) === 1;
  var band = alongX ? api.size([0, 1])[1] : api.size([1, 0])[0];
  var shift = offset * band;
  var from = api.coord(alongX ? [low, y] : [x, low]);
  var to = api.coord(alongX ? [high, y] : [x, high]);
  var anchor = api.coord([x, y]);
  var fromX = alongX ? from[0] : from[0] + shift;
  var fromY = alongX ? from[1] + shift : from[1];
  var toX = alongX ? to[0] : to[0] + shift;
  var toY = alongX ? to[1] + shift : to[1];
  if (inner) {
    return {
      type: "group",
      children: [
        reportSegment(fromX, fromY, toX, toY, ${INNER_STROKE_PX}),
        {
          type: "circle",
          shape: { cx: alongX ? anchor[0] : anchor[0] + shift, cy: alongX ? anchor[1] + shift : anchor[1], r: ${INNER_POINT_RADIUS_PX} },
          style: { fill: ${JSON.stringify(INNER_POINT_FILL)}, stroke: ${JSON.stringify(CHART_INK)}, lineWidth: 1 }
        }
      ]
    };
  }
  var children = [reportSegment(fromX, fromY, toX, toY, ${INTERVAL_STROKE_PX})];
  var ends = [[fromX, fromY], [toX, toY]];
  for (var e = 0; e < ends.length; e++) {
    var endX = ends[e][0];
    var endY = ends[e][1];
    children.push(
      alongX
        ? reportSegment(endX, endY - ${INTERVAL_CAP_PX}, endX, endY + ${INTERVAL_CAP_PX}, ${INTERVAL_STROKE_PX})
        : reportSegment(endX - ${INTERVAL_CAP_PX}, endY, endX + ${INTERVAL_CAP_PX}, endY, ${INTERVAL_STROKE_PX})
    );
  }
  return { type: "group", children: children };
}
function reportOutlineRenderer(params, api) {
  var category = api.value(0);
  var band = api.size([1, 0])[0];
  var center = api.value(3) * band;
  var right = [];
  var left = [];
  for (var point = 0; point < ${VIOLIN_GRID_POINTS}; point++) {
    var width = api.value(4 + 2 * point) * band;
    var at = api.coord([category, api.value(5 + 2 * point)]);
    right.push([at[0] + center + width, at[1]]);
    left.push([at[0] + center - width, at[1]]);
  }
  var color = api.visual("color");
  return {
    type: "polygon",
    shape: { points: right.concat(left.reverse()) },
    style: { fill: color, stroke: color, lineWidth: 1, opacity: ${OUTLINE_OPACITY} }
  };
}
function reportCellGlyphRenderer(params, api) {
  var payload = params.itemPayload || {};
  var colors = Array.isArray(payload.colors) ? payload.colors : [];
  var ground = typeof payload.ground === "string" ? payload.ground : ${JSON.stringify(CHART_INK)};
  var center = api.coord([api.value(0), api.value(1)]);
  var klass = api.value(2);
  var band = api.size([1, 1]);
  var width = band[0] - Math.min(${CELL_GAP_PX}, band[0] * ${CELL_GAP_MAX_SHARE});
  var height = band[1] - Math.min(${CELL_GAP_PX}, band[1] * ${CELL_GAP_MAX_SHARE});
  var children = [{ type: "rect", shape: { x: center[0] - width / 2, y: center[1] - height / 2, width: width, height: height }, style: { fill: ground } }];
  if (klass >= 0 && klass < colors.length) {
    var glyph = height * ${CELL_GLYPH_SHARE};
    children.push({ type: "rect", shape: { x: center[0] - width / 2, y: center[1] - glyph / 2, width: width, height: glyph }, style: { fill: colors[klass] } });
  }
  return { type: "group", children: children };
}
function reportStemRenderer(params, api) {
  var x = api.value(0);
  var floor = api.coord([x, 0]);
  var head = api.coord([x, api.value(1)]);
  return {
    type: "group",
    children: [
      { type: "line", shape: { x1: floor[0], y1: floor[1], x2: head[0], y2: head[1] }, style: { stroke: ${JSON.stringify(GUIDE_LINE_COLOR)}, lineWidth: 1 } },
      { type: "circle", shape: { cx: head[0], cy: head[1], r: ${STEM_HEAD_RADIUS_PX} }, style: { fill: api.visual("color"), stroke: ${JSON.stringify(CHART_INK)}, lineWidth: 0.5 } }
    ]
  };
}
function reportRegisterRenderers(runtime) {
${CHART_RENDERERS.map((entry) => `  runtime.registerCustomSeries(${JSON.stringify(entry.name)}, ${entry.pageFunction});`).join("\n")}
}
function reportScaledAxes(axes, scale) {
  if (Array.isArray(axes)) {
    var list = [];
    for (var a = 0; a < axes.length; a++) {
      list.push(reportScaledAxes(axes[a], scale));
    }
    return list;
  }
  if (typeof axes !== "object" || axes === null) {
    return axes;
  }
  var axis = Object.assign({}, axes);
  if (typeof axis.nameGap === "number") {
    axis.nameGap = axis.nameGap * scale;
  }
  if (typeof axis.offset === "number") {
    axis.offset = axis.offset * scale;
  }
  return axis;
}
function reportScaledGraphic(element, scale) {
  if (typeof element !== "object" || element === null) {
    return element;
  }
  var out = Object.assign({}, element);
  var style = out.style;
  if (style !== undefined && typeof style.fontSize === "number") {
    out.style = Object.assign({}, style, { fontSize: style.fontSize * scale });
  }
  if (Array.isArray(out.children)) {
    var children = [];
    for (var c = 0; c < out.children.length; c++) {
      children.push(reportScaledGraphic(out.children[c], scale));
    }
    out.children = children;
  }
  return out;
}
function reportLegendLines(option, textPx, widthPx) {
  var legend = option.legend;
  var names = [];
  if (Array.isArray(legend.data)) {
    for (var d = 0; d < legend.data.length; d++) {
      var entry = legend.data[d];
      var entryName = typeof entry === "object" && entry !== null ? entry.name : entry;
      if (typeof entryName === "string") {
        names.push(entryName);
      }
    }
  } else if (Array.isArray(option.series)) {
    for (var s = 0; s < option.series.length; s++) {
      var series = option.series[s];
      var seriesName = typeof series === "object" && series !== null ? series.name : undefined;
      if (typeof seriesName === "string" && seriesName !== "" && names.indexOf(seriesName) < 0) {
        names.push(seriesName);
      }
    }
  }
  var room = widthPx - 2 * ${LEGEND_PADDING_PX};
  var lines = names.length === 0 ? 0 : 1;
  var used = 0;
  for (var n = 0; n < names.length; n++) {
    var width = textPx + 5 + names[n].length * textPx * ${CHARACTER_SHARE};
    if (used > 0 && used + ${LEGEND_ITEM_GAP_PX} + width > room) {
      lines += 1;
      used = width;
    } else {
      used = used > 0 ? used + ${LEGEND_ITEM_GAP_PX} + width : width;
    }
  }
  return lines;
}
function reportPanelBottom(grid) {
  if (typeof grid !== "object" || grid === null) {
    return 0;
  }
  if (grid.outerBoundsMode !== ${JSON.stringify(PANEL_BOUNDS_MODE)} || typeof grid.top !== "string" || typeof grid.height !== "string") {
    return 0;
  }
  return Number.parseFloat(grid.top) + Number.parseFloat(grid.height);
}
function reportHoldsFacetLegend(option) {
  var legend = option.legend;
  var bottom = typeof legend === "object" && legend !== null && legend.show !== false && legend.bottom !== undefined;
  if (!bottom || !Array.isArray(option.grid)) {
    return false;
  }
  for (var g = 0; g < option.grid.length; g++) {
    if (reportPanelBottom(option.grid[g]) > 0) {
      return true;
    }
  }
  return false;
}
function reportLegendBand(lines, textPx) {
  return Math.round(lines * (textPx * ${LEGEND_LINE_SHARE} + ${LEGEND_ITEM_GAP_PX}) + textPx);
}
function reportFacetOverLegend(option, textPx, widthPx, heightPx) {
  var grids = option.grid;
  var title = Math.round(textPx * ${FACET_TITLE_SHARE});
  var lowest = 0;
  var reserve = 0;
  for (var g = 0; g < grids.length; g++) {
    var edge = reportPanelBottom(grids[g]);
    if (edge <= lowest) {
      continue;
    }
    lowest = edge;
    reserve = Number.parseFloat(String(grids[g].top)) + Number.parseFloat(String(grids[g].height)) * ${PANEL_MIN_SHARE};
  }
  var lines = reportLegendLines(option, textPx, widthPx);
  var band = reportLegendBand(lines, textPx);
  if (lines > 1 && ((heightPx - band - title) / heightPx) * 100 < reserve) {
    option.legend = Object.assign({}, option.legend, { type: "scroll" });
    band = reportLegendBand(1, textPx);
  }
  var floor = ((heightPx - band - title) / heightPx) * 100;
  var placed = [];
  for (var p = 0; p < grids.length; p++) {
    var bottom = reportPanelBottom(grids[p]);
    if (bottom < lowest || bottom <= floor) {
      placed.push(grids[p]);
      continue;
    }
    var top = Number.parseFloat(String(grids[p].top));
    placed.push(Object.assign({}, grids[p], { height: Math.round((floor - top) * 1e4) / 1e4 + "%" }));
  }
  option.grid = placed;
  if (Array.isArray(option.graphic)) {
    var graphic = [];
    for (var e = 0; e < option.graphic.length; e++) {
      var element = option.graphic[e];
      graphic.push(typeof element === "object" && element !== null && element.bottom !== undefined ? Object.assign({}, element, { bottom: band }) : element);
    }
    option.graphic = graphic;
  }
}
function reportHoldsBottomLegend(option) {
  var legend = option.legend;
  var bottom = typeof legend === "object" && legend !== null && legend.show !== false && legend.bottom !== undefined;
  return bottom && option.xAxis !== undefined && !Array.isArray(option.grid);
}
function reportFittedCategories(axis, textPx, widthPx) {
  if (typeof axis !== "object" || axis === null || Array.isArray(axis)) {
    return axis;
  }
  var data = axis.data;
  if (axis.type !== "category" || !Array.isArray(data) || data.length === 0) {
    return axis;
  }
  var label = typeof axis.axisLabel === "object" && axis.axisLabel !== null ? axis.axisLabel : {};
  if (typeof label.rotate === "number" && label.rotate !== 0) {
    return axis;
  }
  var longest = 0;
  for (var d = 0; d < data.length; d++) {
    longest = Math.max(longest, String(data[d]).length);
  }
  var need = longest * textPx * ${CHARACTER_SHARE};
  var room = (widthPx * ${LABEL_ROOM}) / data.length;
  if (need <= room) {
    return axis;
  }
  return Object.assign({}, axis, { axisLabel: Object.assign({}, label, { rotate: need > 2 * room ? 90 : 45 }) });
}
function reportWrappedTitle(title, textPx, widthPx) {
  var perLine = Math.max(1, Math.floor((widthPx * ${COLOR_SCALE_BAND_PCT} * ${SCALE_TITLE_ROOM}) / 100 / (textPx * ${CHARACTER_SHARE})));
  var words = title.split(" ");
  var lines = [];
  var line = "";
  for (var w = 0; w < words.length; w++) {
    var word = words[w];
    if (line === "") {
      line = word;
    } else if (line.length + 1 + word.length <= perLine) {
      line = line + " " + word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") {
    lines.push(line);
  }
  return lines.join("\\n");
}
function reportGridWidth(grid, axis, widthPx) {
  var place = typeof axis === "object" && axis !== null && typeof axis.gridIndex === "number" ? axis.gridIndex : 0;
  var entry = Array.isArray(grid) ? grid[place] : grid;
  var width = typeof entry === "object" && entry !== null ? entry.width : undefined;
  if (typeof width === "string" && width.endsWith("%")) {
    return (widthPx * Number.parseFloat(width)) / 100;
  }
  if (typeof width === "number") {
    return width;
  }
  return widthPx;
}
function reportFittedAxes(axes, grid, textPx, widthPx) {
  if (!Array.isArray(axes)) {
    return reportFittedCategories(axes, textPx, reportGridWidth(grid, axes, widthPx));
  }
  var fitted = [];
  for (var a = 0; a < axes.length; a++) {
    fitted.push(reportFittedCategories(axes[a], textPx, reportGridWidth(grid, axes[a], widthPx)));
  }
  return fitted;
}
function reportStillScale(map, textPx, widthPx) {
  if (typeof map !== "object" || map === null) {
    return map;
  }
  var text = map.text;
  if (map.show === false || map.type === "piecewise" || !Array.isArray(text) || typeof text[0] !== "string" || typeof text[1] !== "string") {
    return map;
  }
  var lines = text[0].split("\\n");
  var upper = lines[lines.length - 1];
  var title = lines.slice(0, -1).join(" ");
  return Object.assign({}, map, {
    top: ${JSON.stringify(STILL_SCALE_TOP)},
    itemHeight: ${STILL_SCALE_LINES} * textPx,
    text: [title === "" ? upper : reportWrappedTitle(title, textPx, widthPx) + "\\n" + upper, text[1]]
  });
}
function reportSizedSeries(series, sized, widthPx) {
  if (!Array.isArray(series) || typeof sized !== "object" || sized === null) {
    return series;
  }
  var widths = sized.widths;
  var chosen = typeof widths === "object" && widths !== null ? widths[String(widthPx)] : undefined;
  if (!Array.isArray(sized.names) || !Array.isArray(chosen)) {
    return series;
  }
  var kept = [];
  for (var s = 0; s < series.length; s++) {
    var entry = series[s];
    if (typeof entry !== "object" || entry === null || sized.names.indexOf(entry.name) < 0) {
      kept.push(entry);
    }
  }
  return kept.concat(chosen);
}
function reportExportOption(option, textPx, widthPx, heightPx) {
  var scale = textPx / ${CHART_PAGE_TEXT_PX};
  var out = {};
  var keys = Object.keys(option);
  for (var k = 0; k < keys.length; k++) {
    if (keys[k] === "tooltip" || keys[k] === "toolbox" || keys[k] === ${JSON.stringify(SIZED_SERIES_MEMBER)}) {
      continue;
    }
    out[keys[k]] = option[keys[k]];
  }
  if (out.series !== undefined) {
    out.series = reportSizedSeries(out.series, option[${JSON.stringify(SIZED_SERIES_MEMBER)}], widthPx);
  }
  out.animation = false;
  if (out.xAxis !== undefined) {
    out.xAxis = reportScaledAxes(out.xAxis, scale);
  }
  if (out.yAxis !== undefined) {
    out.yAxis = reportScaledAxes(out.yAxis, scale);
  }
  if (Array.isArray(out.graphic)) {
    var graphic = [];
    for (var g = 0; g < out.graphic.length; g++) {
      graphic.push(reportScaledGraphic(out.graphic[g], scale));
    }
    out.graphic = graphic;
  }
  if (out.xAxis !== undefined) {
    out.xAxis = reportFittedAxes(out.xAxis, out.grid, textPx, widthPx);
  }
  if (Array.isArray(out.visualMap)) {
    var maps = [];
    for (var m = 0; m < out.visualMap.length; m++) {
      maps.push(reportStillScale(out.visualMap[m], textPx, widthPx));
    }
    out.visualMap = maps;
  } else if (out.visualMap !== undefined) {
    out.visualMap = reportStillScale(out.visualMap, textPx, widthPx);
  }
  if (typeof out.grid === "object" && out.grid !== null && !Array.isArray(out.grid) && out.grid.containLabel === true) {
    out.grid = Object.assign({}, out.grid, { containLabel: false, outerBoundsMode: "auto", outerBoundsContain: "all" });
  }
  if (reportHoldsBottomLegend(out)) {
    var grid = typeof out.grid === "object" && out.grid !== null ? out.grid : {};
    out.grid = Object.assign({}, grid, { outerBoundsMode: "auto", outerBounds: { left: 0, right: 0, top: 0, bottom: Math.round(textPx * ${LEGEND_BAND_LINES}) } });
  }
  if (reportHoldsFacetLegend(out)) {
    reportFacetOverLegend(out, textPx, widthPx, heightPx);
  }
  return out;
}`;
