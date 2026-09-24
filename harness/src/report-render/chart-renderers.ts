/**
 * The named renderers of a custom series, in two twins.
 *
 * The chart runtime draws an interval and a violin outline through a `custom` series, and such a series
 * takes a `renderItem` function. The option rides to the page as inline JSON, thus it holds no function.
 * The derivation writes the name of a renderer as a string, and each consumer binds the name to its
 * function before the option reaches the chart runtime: the page bootstrap through the source text below,
 * and the server export through the TypeScript functions.
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

import { CHART_INK, CHART_PAGE_TEXT_PX, COLOR_SCALE_BAND_PCT } from "./design.js";

/** The renderer name of an interval: an error bar, a confidence interval, or the inner mark of a violin. */
export const INTERVAL_RENDERER = "interval";

/** The renderer name of a violin outline. */
export const OUTLINE_RENDERER = "outline";

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
export function intervalRenderer(_params: unknown, api: RenderApi): RenderedElement {
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
export function outlineRenderer(_params: unknown, api: RenderApi): RenderedElement {
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

/** The function of one renderer name, or `undefined` for a name that no renderer holds. */
function rendererOf(name: unknown): ((params: unknown, api: RenderApi) => RenderedElement) | undefined {
    if (name === INTERVAL_RENDERER) return intervalRenderer;
    if (name === OUTLINE_RENDERER) return outlineRenderer;
    return undefined;
}

/**
 * Bind each renderer name of one option to its function.
 *
 * The bind copies each series that it changes and the option around them. Thus the caller keeps the option
 * as data, and a second bind of the same option reads the names again.
 */
export function bindRenderers(option: Record<string, unknown>): Record<string, unknown> {
    const series = option.series;
    if (!Array.isArray(series)) {
        return option;
    }
    const bound = series.map((entry: unknown) => {
        if (typeof entry !== "object" || entry === null) return entry;
        const renderer = rendererOf((entry as Record<string, unknown>).renderItem);
        return renderer === undefined ? entry : { ...(entry as Record<string, unknown>), renderItem: renderer };
    });
    return { ...option, series: bound };
}

/** One axis, or one list of axes, with each name gap scaled to the text size of an export. */
function scaledAxes(axes: unknown, scale: number): unknown {
    if (Array.isArray(axes)) return axes.map((axis) => scaledAxes(axis, scale));
    if (typeof axes !== "object" || axes === null) return axes;
    const axis = axes as Record<string, unknown>;
    return typeof axis.nameGap === "number" ? { ...axis, nameGap: axis.nameGap * scale } : axis;
}

/** One graphic element with its text scaled to the text size of an export. A facet panel label is such an element. */
function scaledGraphic(element: unknown, scale: number): unknown {
    if (typeof element !== "object" || element === null) return element;
    const style = (element as Record<string, unknown>).style as Record<string, unknown> | undefined;
    if (style === undefined || typeof style.fontSize !== "number") return element;
    return { ...(element as Record<string, unknown>), style: { ...style, fontSize: style.fontSize * scale } };
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
 * One continuous color map of an export, with its ends as static text and no handle.
 *
 * A handle serves a reader on the page. In a still figure its value labels stand on the ends of the scale,
 * thus the export prints the title and the upper end over the scale and the lower end under it. The title
 * wraps into the band of the scale. The scale starts at the top of the plot and stays short, thus its lower
 * end never meets the labels of the x axis.
 */
function stillScale(map: unknown, textPx: number, widthPx: number): unknown {
    if (typeof map !== "object" || map === null) return map;
    const fields = map as Record<string, unknown>;
    if (fields.calculable !== true || typeof fields.min !== "number" || typeof fields.max !== "number") return map;
    const digits = typeof fields.precision === "number" ? fields.precision : 0;
    const title =
        Array.isArray(fields.text) && typeof fields.text[0] === "string" && fields.text[0] !== "" ? `${wrappedTitle(fields.text[0], textPx, widthPx)}\n` : "";
    return {
        ...fields,
        calculable: false,
        top: STILL_SCALE_TOP,
        itemHeight: STILL_SCALE_LINES * textPx,
        text: [`${title}${fields.max.toFixed(digits)}`, fields.min.toFixed(digits)],
    };
}

/** The top of a still color scale, which is the top margin of the grid, and its length in lines of the text. */
const STILL_SCALE_TOP = "8%";
const STILL_SCALE_LINES = 8;

/** The height of the legend band of an export, in lines of its text. */
const LEGEND_BAND_LINES = 2.5;

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
 * names above a band of the legend height. The category labels turn where they do not fit the width, and a
 * color scale prints its ends as static text. A grid that contains its labels contains its names too.
 */
export function exportOption(option: Record<string, unknown>, textPx: number, widthPx: number): Record<string, unknown> {
    const scale = textPx / CHART_PAGE_TEXT_PX;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(option)) {
        if (key === "tooltip" || key === "toolbox") continue;
        out[key] = option[key];
    }
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
    return out;
}

/**
 * The page twin of the two renderers, of the bind step, and of the export option, as browser source text.
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
function reportRendererOf(name) {
  if (name === ${JSON.stringify(INTERVAL_RENDERER)}) {
    return reportIntervalRenderer;
  }
  if (name === ${JSON.stringify(OUTLINE_RENDERER)}) {
    return reportOutlineRenderer;
  }
  return undefined;
}
function reportBindRenderers(option) {
  var series = option.series;
  if (!Array.isArray(series)) {
    return option;
  }
  var bound = [];
  for (var s = 0; s < series.length; s++) {
    var entry = series[s];
    var renderer = entry && typeof entry === "object" ? reportRendererOf(entry.renderItem) : undefined;
    if (renderer === undefined) {
      bound.push(entry);
      continue;
    }
    bound.push(Object.assign({}, entry, { renderItem: renderer }));
  }
  return Object.assign({}, option, { series: bound });
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
  return typeof axes.nameGap === "number" ? Object.assign({}, axes, { nameGap: axes.nameGap * scale }) : axes;
}
function reportScaledGraphic(element, scale) {
  if (typeof element !== "object" || element === null) {
    return element;
  }
  var style = element.style;
  if (style === undefined || typeof style.fontSize !== "number") {
    return element;
  }
  return Object.assign({}, element, { style: Object.assign({}, style, { fontSize: style.fontSize * scale }) });
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
  if (map.calculable !== true || typeof map.min !== "number" || typeof map.max !== "number") {
    return map;
  }
  var digits = typeof map.precision === "number" ? map.precision : 0;
  var title = Array.isArray(map.text) && typeof map.text[0] === "string" && map.text[0] !== "" ? reportWrappedTitle(map.text[0], textPx, widthPx) + "\\n" : "";
  return Object.assign({}, map, {
    calculable: false,
    top: ${JSON.stringify(STILL_SCALE_TOP)},
    itemHeight: ${STILL_SCALE_LINES} * textPx,
    text: [title + map.max.toFixed(digits), map.min.toFixed(digits)]
  });
}
function reportExportOption(option, textPx, widthPx) {
  var scale = textPx / ${CHART_PAGE_TEXT_PX};
  var out = {};
  var keys = Object.keys(option);
  for (var k = 0; k < keys.length; k++) {
    if (keys[k] === "tooltip" || keys[k] === "toolbox") {
      continue;
    }
    out[keys[k]] = option[keys[k]];
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
  return out;
}`;
