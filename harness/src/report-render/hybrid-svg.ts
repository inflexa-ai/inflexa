/**
 * The hybrid SVG of a dense chart: the vector axes, text, legend, and guides, over one raster layer of the points.
 *
 * A chart past the point bound of the export gets no staged SVG, because a vector file of many thousands of
 * points is too large. The page builds its SVG on a click instead. It draws the export option with the SVG
 * renderer and the point data emptied, it draws the points alone on a canvas at 300 DPI, and it puts the canvas
 * image into the SVG at the rectangle of the grid, under the vector marks. The server has no canvas, thus only
 * the page builds this file.
 *
 * The rule of a point layer and the composition of the file hold one rule each in two twins: the TypeScript
 * function and the page function. A shared test vector runs both, thus the two cannot drift in silence. The
 * option transforms and the two draws exist on the page alone, because the server never builds the file.
 */

/** The box of one export in CSS pixels, and in millimeters for a column export. */
export interface SvgRootSize {
    readonly widthPx: number;
    readonly heightPx: number;
    readonly widthMm?: number;
    readonly heightMm?: number;
}

/** The raster image of the point layer and its rectangle in the pixel space of the SVG. */
export interface PointLayerImage {
    readonly href: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/**
 * True when one series draws a point for each row: a `scatter` whose symbol draws and which shows no series
 * label. A scatter of size zero, or one with a shown label, carries names, and names stay vector text.
 */
export function isPointLayer(series: unknown): boolean {
    if (typeof series !== "object" || series === null) return false;
    const fields = series as Record<string, unknown>;
    if (fields.type !== "scatter" || fields.symbolSize === 0 || fields.symbol === "none") return false;
    const label = fields.label;
    return !(typeof label === "object" && label !== null && (label as Record<string, unknown>).show === true);
}

/** True when an option holds a point layer. The page can then build the hybrid SVG of the option. */
export function holdsPointLayer(option: Readonly<Record<string, unknown>>): boolean {
    const series = option.series;
    return Array.isArray(series) ? series.some(isPointLayer) : isPointLayer(series);
}

/**
 * The SVG text with its root at the millimeter size of a column. The view box keeps the pixel space, thus a
 * vector editor opens the file at the column width. A size with no millimeter box leaves the root as it is.
 */
export function millimeterRoot(svg: string, size: SvgRootSize): string {
    if (size.widthMm === undefined || size.heightMm === undefined) return svg;
    return svg.replace(`<svg width="${size.widthPx}" height="${size.heightPx}"`, `<svg width="${size.widthMm}mm" height="${size.heightMm}mm"`);
}

/** The count of decimals of a coordinate of the layer. A thousandth of a pixel is past each display. */
const LAYER_DECIMALS = 1000;

/** One coordinate of the layer, rounded to the decimals of the layer. */
function layerNumber(value: number): number {
    return Math.round(value * LAYER_DECIMALS) / LAYER_DECIMALS;
}

/** One attribute value with each character that can close it written as an entity. */
function attributeText(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** The root tag of an SVG file, and the transparent background rectangle that the chart runtime writes first. */
const ROOT_TAG = /^<svg\b[^>]*>/;
const BACKGROUND_RECT = /^\s*<rect width="[^"]*" height="[^"]*" x="0" y="0"[^>]*><\/rect>/;

/**
 * The hybrid SVG file: the vector file with one `<image>` element of the point layer, and the root at the
 * millimeter size.
 *
 * The image goes first after the background rectangle, thus each vector mark draws over the points: the axes,
 * the guides, the names, and the legend. The rectangle of the image is the grid rectangle, and the image
 * stretches to it, because the raster drew the grid at that rectangle. A text that holds no SVG root passes
 * through with no image.
 */
export function composeHybridSvg(svg: string, layer: PointLayerImage, size: SvgRootSize): string {
    const root = ROOT_TAG.exec(svg);
    if (root === null) return svg;
    let at = root[0].length;
    const background = BACKGROUND_RECT.exec(svg.slice(at));
    if (background !== null) at += background[0].length;
    const image =
        `\n<image href="${attributeText(layer.href)}" x="${layerNumber(layer.x)}" y="${layerNumber(layer.y)}" ` +
        `width="${layerNumber(layer.width)}" height="${layerNumber(layer.height)}" preserveAspectRatio="none"></image>`;
    return millimeterRoot(svg.slice(0, at) + image + svg.slice(at), size);
}

/**
 * The count of halvings of the search for one edge of a grid. The chart is at most some thousand pixels wide,
 * thus twenty halvings place the edge closer than a hundredth of a pixel.
 */
const EDGE_SEARCH_STEPS = 20;

/** The symbol size of a scatter that states none, in pixels: the default of the chart runtime. */
const RUNTIME_SYMBOL_PX = 10;

/**
 * The page twin of the point-layer rule and of the composition, and the page build of the hybrid file, as
 * browser source text.
 *
 * `reportHybridSvg(runtime, option, size)` is the entry point. It reads the chart runtime and the document of
 * the page, and it gives the SVG text, or `null` when the option holds no point layer or the runtime gives no
 * grid rectangle. The fragment reads `reportExportOption` of the renderer fragment, thus the bootstrap inlines
 * that fragment first.
 *
 * The draws run in this order:
 *
 * 1. The vector draw takes the export option with the rows of each point layer emptied. Each point layer keeps
 *    each row that carries its own label, and two anchors with no symbol at the least and the greatest value of
 *    each dimension. Thus each axis and each color scale keeps the extent of the full rows.
 * 2. The rectangle of each grid that holds a point layer comes from the runtime: a halving search of each edge
 *    with `containPixel` from a point inside the grid. The extent of each continuous axis of such a grid comes
 *    from `convertFromPixel` at the two edges.
 * 3. The raster draw takes the export option with the point layers alone. Each grid stands at its measured
 *    rectangle, each axis holds its measured extent and draws nothing, and the legend, the graphics, and the
 *    color scales draw nothing. Thus each point lands on the pixel where the vector axes place it.
 * 4. The composition crops the raster to the union of the grid rectangles at 300 DPI, and it puts the PNG into
 *    the vector file. The crop reaches past each grid edge by half of the largest symbol, thus a point on an
 *    edge keeps its whole symbol, as it does on the page.
 */
export const HYBRID_SVG_SOURCE = `function reportIsPointLayer(series) {
  if (typeof series !== "object" || series === null) {
    return false;
  }
  if (series.type !== "scatter" || series.symbolSize === 0 || series.symbol === "none") {
    return false;
  }
  var label = series.label;
  return !(typeof label === "object" && label !== null && label.show === true);
}
function reportMillimeterRoot(svg, size) {
  if (size.widthMm === undefined || size.heightMm === undefined) {
    return svg;
  }
  return svg.replace('<svg width="' + size.widthPx + '" height="' + size.heightPx + '"', '<svg width="' + size.widthMm + 'mm" height="' + size.heightMm + 'mm"');
}
function reportLayerNumber(value) {
  return Math.round(value * ${LAYER_DECIMALS}) / ${LAYER_DECIMALS};
}
function reportAttributeText(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function reportComposeHybridSvg(svg, layer, size) {
  var root = ${String(ROOT_TAG)}.exec(svg);
  if (root === null) {
    return svg;
  }
  var at = root[0].length;
  var background = ${String(BACKGROUND_RECT)}.exec(svg.slice(at));
  if (background !== null) {
    at += background[0].length;
  }
  var image =
    '\\n<image href="' + reportAttributeText(layer.href) + '" x="' + reportLayerNumber(layer.x) + '" y="' + reportLayerNumber(layer.y) + '" ' +
    'width="' + reportLayerNumber(layer.width) + '" height="' + reportLayerNumber(layer.height) + '" preserveAspectRatio="none"></image>';
  return reportMillimeterRoot(svg.slice(0, at) + image + svg.slice(at), size);
}
function reportList(member) {
  if (member === undefined || member === null) {
    return [];
  }
  return Array.isArray(member) ? member : [member];
}
function reportItemValue(item) {
  return typeof item === "object" && item !== null && !Array.isArray(item) ? item.value : item;
}
function reportLabeledItem(item) {
  return typeof item === "object" && item !== null && !Array.isArray(item) && item.label !== undefined;
}
function reportExtentAnchors(data) {
  var least = [];
  var most = [];
  for (var i = 0; i < data.length; i++) {
    var value = reportItemValue(data[i]);
    if (!Array.isArray(value)) {
      continue;
    }
    for (var d = 0; d < value.length; d++) {
      var cell = value[d];
      var number = typeof cell === "number" ? cell : typeof cell === "string" && cell.trim() !== "" ? Number(cell) : NaN;
      if (!isFinite(number)) {
        if (least[d] === undefined) {
          least[d] = cell;
          most[d] = cell;
        }
        continue;
      }
      if (least[d] === undefined || typeof least[d] !== "number" || number < least[d]) {
        least[d] = number;
      }
      if (most[d] === undefined || typeof most[d] !== "number" || number > most[d]) {
        most[d] = number;
      }
    }
  }
  if (least.length === 0) {
    return [];
  }
  return [
    { value: least, symbol: "none", label: { show: false } },
    { value: most, symbol: "none", label: { show: false } }
  ];
}
function reportHybridVectorOption(option) {
  var out = Object.assign({}, option);
  var series = reportList(option.series);
  var drawn = [];
  for (var s = 0; s < series.length; s++) {
    if (!reportIsPointLayer(series[s])) {
      drawn.push(series[s]);
      continue;
    }
    var data = Array.isArray(series[s].data) ? series[s].data : [];
    var kept = [];
    for (var i = 0; i < data.length; i++) {
      if (reportLabeledItem(data[i])) {
        kept.push(data[i]);
      }
    }
    drawn.push(Object.assign({}, series[s], { large: false, data: kept.concat(reportExtentAnchors(data)) }));
  }
  out.series = drawn;
  return out;
}
function reportSeriesGrid(option, series) {
  var axes = reportList(option.xAxis);
  var axis = axes[typeof series.xAxisIndex === "number" ? series.xAxisIndex : 0];
  return axis && typeof axis.gridIndex === "number" ? axis.gridIndex : 0;
}
function reportContinuousAxis(axis, kind) {
  var type = axis.type === undefined ? (kind === "xAxis" ? "category" : "value") : axis.type;
  return type === "value" || type === "log" || type === "time";
}
function reportGridBox(chart, gridIndex, seed, width, height) {
  var finder = { gridIndex: gridIndex };
  if (!chart.containPixel(finder, seed)) {
    return null;
  }
  function edge(inside, outside, point) {
    for (var step = 0; step < ${EDGE_SEARCH_STEPS}; step++) {
      var middle = (inside + outside) / 2;
      if (chart.containPixel(finder, point(middle))) {
        inside = middle;
      } else {
        outside = middle;
      }
    }
    return inside;
  }
  function alongX(x) {
    return [x, seed[1]];
  }
  function alongY(y) {
    return [seed[0], y];
  }
  var left = edge(seed[0], -1, alongX);
  var right = edge(seed[0], width + 1, alongX);
  var top = edge(seed[1], -1, alongY);
  var bottom = edge(seed[1], height + 1, alongY);
  return { x: left, y: top, width: right - left, height: bottom - top };
}
function reportSeed(chart, series, index, width, height) {
  var data = Array.isArray(series.data) ? series.data : [];
  if (data.length === 0) {
    return null;
  }
  // The middle of the data extent of the layer sits inside its grid, because each axis covers its data.
  var anchors = reportExtentAnchors(data);
  if (anchors.length === 2 && typeof anchors[0].value[0] === "number" && typeof anchors[0].value[1] === "number") {
    var middle = [(anchors[0].value[0] + anchors[1].value[0]) / 2, (anchors[0].value[1] + anchors[1].value[1]) / 2];
    var point = chart.convertToPixel({ seriesIndex: index }, middle);
    if (Array.isArray(point) && isFinite(point[0]) && isFinite(point[1])) {
      return point;
    }
  }
  return [width / 2, height / 2];
}
function reportSymbolReach(series) {
  var size = series.symbolSize;
  if (typeof size === "number") {
    return size / 2;
  }
  if (Array.isArray(size)) {
    return Math.max(Number(size[0]) || 0, Number(size[1]) || 0) / 2;
  }
  return ${RUNTIME_SYMBOL_PX} / 2;
}
function reportPointLayerBox(chart, option, width, height) {
  var series = reportList(option.series);
  var boxes = {};
  var found = false;
  var reach = 0;
  for (var s = 0; s < series.length; s++) {
    if (!reportIsPointLayer(series[s])) {
      continue;
    }
    reach = Math.max(reach, Math.ceil(reportSymbolReach(series[s])));
    var grid = reportSeriesGrid(option, series[s]);
    if (boxes[grid] !== undefined) {
      continue;
    }
    // A layer with no row gives no place inside its grid. A facet panel can hold no row of one category, thus
    // the grid takes its seed from the next layer that holds rows, and a grid of empty layers draws no point.
    var seed = reportSeed(chart, series[s], s, width, height);
    if (seed === null) {
      continue;
    }
    var box = reportGridBox(chart, grid, seed, width, height);
    if (box === null) {
      return null;
    }
    boxes[grid] = box;
    found = true;
  }
  if (!found) {
    return null;
  }
  var union = null;
  for (var key in boxes) {
    var b = boxes[key];
    if (union === null) {
      union = { x: b.x, y: b.y, right: b.x + b.width, bottom: b.y + b.height };
    } else {
      union = { x: Math.min(union.x, b.x), y: Math.min(union.y, b.y), right: Math.max(union.right, b.x + b.width), bottom: Math.max(union.bottom, b.y + b.height) };
    }
  }
  var extents = { xAxis: [], yAxis: [] };
  var kinds = ["xAxis", "yAxis"];
  for (var k = 0; k < kinds.length; k++) {
    var axes = reportList(option[kinds[k]]);
    for (var a = 0; a < axes.length; a++) {
      var place = boxes[typeof axes[a].gridIndex === "number" ? axes[a].gridIndex : 0];
      if (place === undefined || !reportContinuousAxis(axes[a], kinds[k])) {
        continue;
      }
      var finder = {};
      finder[kinds[k] + "Index"] = a;
      var ends = kinds[k] === "xAxis" ? [place.x, place.x + place.width] : [place.y + place.height, place.y];
      var first = chart.convertFromPixel(finder, ends[0]);
      var last = chart.convertFromPixel(finder, ends[1]);
      extents[kinds[k]][a] = { min: Math.min(first, last), max: Math.max(first, last) };
    }
  }
  var left = Math.max(0, union.x - reach);
  var top = Math.max(0, union.y - reach);
  var right = Math.min(width, union.right + reach);
  var bottom = Math.min(height, union.bottom + reach);
  return { boxes: boxes, extents: extents, box: { x: left, y: top, width: right - left, height: bottom - top } };
}
function reportUnlabeledItem(item) {
  if (!reportLabeledItem(item)) {
    return item;
  }
  var copy = Object.assign({}, item);
  delete copy.label;
  return copy;
}
function reportHidden(member) {
  if (Array.isArray(member)) {
    var list = [];
    for (var i = 0; i < member.length; i++) {
      list.push(Object.assign({}, member[i], { show: false }));
    }
    return list;
  }
  return Object.assign({}, member, { show: false });
}
function reportHybridRasterOption(option, layer) {
  var out = Object.assign({}, option);
  delete out.graphic;
  delete out.title;
  if (out.legend !== undefined) {
    out.legend = reportHidden(out.legend);
  }
  if (out.visualMap !== undefined) {
    out.visualMap = reportHidden(out.visualMap);
  }
  var series = reportList(option.series);
  var drawn = [];
  for (var s = 0; s < series.length; s++) {
    var copy = Object.assign({}, series[s], { label: { show: false }, progressive: 0 });
    delete copy.markLine;
    delete copy.markArea;
    delete copy.markPoint;
    if (reportIsPointLayer(series[s])) {
      var data = Array.isArray(series[s].data) ? series[s].data : [];
      var points = [];
      for (var i = 0; i < data.length; i++) {
        points.push(reportUnlabeledItem(data[i]));
      }
      copy.data = points;
    } else {
      copy.data = [];
    }
    drawn.push(copy);
  }
  out.series = drawn;
  var grids = reportList(option.grid);
  var placed = [];
  var count = grids.length > 0 ? grids.length : 1;
  for (var g = 0; g < count; g++) {
    var grid = Object.assign({}, grids[g] || {});
    var box = layer.boxes[g];
    if (box !== undefined) {
      delete grid.right;
      delete grid.bottom;
      grid.left = box.x;
      grid.top = box.y;
      grid.width = box.width;
      grid.height = box.height;
      grid.containLabel = false;
      grid.outerBoundsMode = "none";
    }
    placed.push(grid);
  }
  out.grid = placed;
  var kinds = ["xAxis", "yAxis"];
  for (var k = 0; k < kinds.length; k++) {
    if (option[kinds[k]] === undefined) {
      continue;
    }
    var axes = reportList(option[kinds[k]]);
    var pinned = [];
    for (var a = 0; a < axes.length; a++) {
      var axis = Object.assign({}, axes[a], { show: false });
      var extent = layer.extents[kinds[k]][a];
      if (extent !== undefined) {
        axis.min = extent.min;
        axis.max = extent.max;
      }
      pinned.push(axis);
    }
    out[kinds[k]] = Array.isArray(option[kinds[k]]) ? pinned : pinned[0];
  }
  return out;
}
function reportCroppedLayer(chart, box, ratio) {
  var full = chart.renderToCanvas({ pixelRatio: ratio });
  var crop = document.createElement("canvas");
  crop.width = Math.max(1, Math.round(box.width * ratio));
  crop.height = Math.max(1, Math.round(box.height * ratio));
  crop.getContext("2d").drawImage(full, box.x * ratio, box.y * ratio, box.width * ratio, box.height * ratio, 0, 0, crop.width, crop.height);
  return crop.toDataURL("image/png");
}
function reportHybridSvg(runtime, option, size) {
  var exported = reportExportOption(option, size.textPx, size.width, size.height);
  if (!reportList(exported.series).some(reportIsPointLayer)) {
    return null;
  }
  var vector = runtime.init(null, size.theme, { renderer: "svg", ssr: true, width: size.width, height: size.height });
  var svg;
  var layer;
  try {
    vector.setOption(reportHybridVectorOption(exported));
    layer = reportPointLayerBox(vector, exported, size.width, size.height);
    svg = vector.renderToSVGString();
  } finally {
    vector.dispose();
  }
  if (layer === null) {
    return null;
  }
  var raster = runtime.init(document.createElement("div"), size.theme, { renderer: "canvas", width: size.width, height: size.height, devicePixelRatio: size.pixelRatio });
  var href;
  try {
    raster.setOption(reportHybridRasterOption(exported, layer));
    href = reportCroppedLayer(raster, layer.box, size.pixelRatio);
  } finally {
    raster.dispose();
  }
  return reportComposeHybridSvg(
    svg,
    { href: href, x: layer.box.x, y: layer.box.y, width: layer.box.width, height: layer.box.height },
    { widthPx: size.width, heightPx: size.height, widthMm: size.widthMm, heightMm: size.heightMm }
  );
}`;
