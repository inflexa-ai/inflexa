/**
 * The layout of a figure whose two axes share one unit: a PCA, an embedding, and a ROC curve.
 *
 * One unit on x equals one unit on y when the two axes span one length of data and the plot is a square. The
 * option rides to the page as JSON, and the chart runtime knows the size of its container at the draw alone.
 * No grid field of the runtime keeps an aspect, and a percentage of the width is no percentage of the height.
 * Thus the grid states its width and its height in pixels, as one number, and the square holds in every
 * container.
 *
 * The size of the square follows the container through the media rules of the runtime. Each rule names the
 * smallest container that holds one square size with its margins, and the runtime applies each rule that
 * matches, in order. The rules grow, thus the largest square that fits wins. The first rule matches every
 * container, thus a container that shrinks falls back to the smallest square. A rule states every place that
 * the square moves: each grid, the legend, and each color scale in the band at the right of the squares. A
 * rule also states the point size of a square smaller than the page square.
 *
 * The page narrows its chart body to the block of the largest square that fits the body height, and it
 * centers the body in the card. An export has a fixed size, thus one rule for each export size places the
 * largest square that fits it, with the margins at the text size of the export, in the middle of the width.
 * Such a rule names its size as the smallest and the largest container, thus no other container meets it.
 */

import type { EchartOption } from "../chart.js";
import { CHART_EXPORT_SIZES, CHART_PAGE_TEXT_PX, FACET_COLUMNS } from "../design.js";
import { legendLineCount, legendLinePx } from "./common.js";

/** The margins around the squares, in pixels at the page text size. */
export interface SquareMargins {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
}

/** What one square layout places: the panels, their margins, and the members of the band at their right. */
export interface SquareLayoutFields {
    readonly panels: number;
    readonly margins: SquareMargins;
    /** The width in pixels of the band at the right of the squares, or 0 for no band. */
    readonly side: number;
    /** True when the band holds the legend. */
    readonly legend?: boolean;
    /** The count of color scales in the band. */
    readonly visualMaps?: number;
    /** The leading series whose points shrink with a small square, and their point size at the page square. */
    readonly points?: { readonly series: number; readonly px: number };
    /**
     * A legend in a band under the squares instead of the band at their right: the names of its entries. The
     * band holds the lines that the entries fill at the width of the square block.
     */
    readonly legendBand?: { readonly place: "bottom"; readonly entries: readonly string[] };
    /**
     * The series whose label wraps inside the square, for example the statistics text of a corner. The label
     * takes the width of the square less its insets, thus a long statistic breaks into lines and never crosses
     * an axis of a small square.
     */
    readonly squareLabel?: { readonly series: number; readonly insetPx: number };
}

/** The grids of a square layout, the places of the band members, and the media rules that resize them. */
export interface SquareLayout {
    readonly grid: EchartOption[];
    readonly legend?: EchartOption;
    readonly visualMap?: EchartOption[];
    readonly media: EchartOption[];
}

/** The smallest square side, in pixels. A container smaller than its rule still draws this square. */
const SQUARE_MIN_PX = 120;

/** The largest square side, in pixels. The slide export is the largest container. */
const SQUARE_MAX_PX = 1100;

/** The ratio between two neighbor square sizes. The largest square that fits leaves at most this share unused. */
const SQUARE_STEP = 1.1;

/** The gap between two panels, and between the squares and their band, in pixels. */
const PANEL_GAP_PX = 16;

/**
 * The square side from which the margins grow with the square. The slide export draws its text at two
 * times the page size, thus the margins of a large square grow up to two times.
 */
const MARGIN_SCALE_FROM_PX = 330;
const MARGIN_SCALE_MAX = 2;

/** The square sides of the media rules, smallest first. The list is a constant, thus each option holds the same rules. */
const SQUARE_SIDES: readonly number[] = (() => {
    const sides: number[] = [];
    for (let side = SQUARE_MIN_PX; side <= SQUARE_MAX_PX; side *= SQUARE_STEP) sides.push(Math.round(side));
    return sides;
})();

/**
 * The square side at which a point takes its full size. A smaller square, for example the one of the column
 * export, shrinks each point in proportion, thus a cloud keeps its density at the size of a journal column. A
 * larger square keeps the full size, as a plot in points keeps its dot size on a larger figure.
 */
const POINT_SCALE_FROM_PX = 330;

/** The smallest point size of a square that shrinks its points, in pixels. */
const POINT_MIN_PX = 1;

/** One place of the layout at one square side: the grids, the band members, and the smallest container that holds them. */
interface Placement {
    readonly series?: EchartOption[];
    readonly grid: EchartOption[];
    readonly legend?: EchartOption;
    readonly visualMap?: EchartOption[];
    readonly minWidth: number;
    readonly minHeight: number;
}

/**
 * The layout of some square panels, and of the band at their right.
 *
 * The panels lay out three to a row, as a facet does, from the top left corner. Each grid draws no label past
 * its box, thus the runtime never shrinks a square to fit a label.
 */
export function squareLayout(fields: SquareLayoutFields): SquareLayout {
    const placements = SQUARE_SIDES.map((side) => placement(side, fields, marginScale(side)));
    const smallest = placements[0];
    const media: EchartOption[] = placements.map((entry, index) => ({
        // The first rule matches every container, thus a container that shrinks past a rule falls back to it.
        query: index === 0 ? { minWidth: 0 } : { minWidth: entry.minWidth, minHeight: entry.minHeight },
        option: placedOption(entry),
    }));
    for (const size of EXPORT_SIZES) {
        const scale = size.textPx / CHART_PAGE_TEXT_PX;
        const fitting = SQUARE_SIDES.map((side) => placement(side, fields, scale)).filter(
            (entry) => entry.minWidth <= size.widthPx && entry.minHeight <= size.heightPx,
        );
        const chosen = fitting.length > 0 ? fitting[fitting.length - 1] : placement(SQUARE_MIN_PX, fields, scale);
        media.push({
            query: { minWidth: size.widthPx, maxWidth: size.widthPx, minHeight: size.heightPx, maxHeight: size.heightPx },
            option: placedOption(shifted(chosen, Math.max(0, Math.floor((size.widthPx - chosen.minWidth) / 2)))),
        });
    }
    return {
        grid: smallest.grid,
        ...(smallest.legend !== undefined ? { legend: smallest.legend } : {}),
        ...(smallest.visualMap !== undefined ? { visualMap: smallest.visualMap } : {}),
        media,
    };
}

/** The export sizes that take a rule of their own: the two journal columns and the slide. */
const EXPORT_SIZES = [CHART_EXPORT_SIZES.single, CHART_EXPORT_SIZES.double, CHART_EXPORT_SIZES.slide] as const;

/** The scale of the margins of a page square: one up to the page square, and larger with a larger square. */
function marginScale(side: number): number {
    return Math.min(MARGIN_SCALE_MAX, Math.max(1, side / MARGIN_SCALE_FROM_PX));
}

/** The option of one media rule: the point size, the grids, the legend, and the color scales of one placement. */
function placedOption(entry: Placement): EchartOption {
    return {
        ...(entry.series !== undefined ? { series: entry.series } : {}),
        grid: entry.grid,
        ...(entry.legend !== undefined ? { legend: entry.legend } : {}),
        ...(entry.visualMap !== undefined ? { visualMap: entry.visualMap } : {}),
    };
}

/** One placement moved right by some pixels: each grid, the legend, and each color scale. */
function shifted(entry: Placement, by: number): Placement {
    const move = (member: EchartOption): EchartOption => ({ ...member, left: (member.left as number) + by });
    return {
        ...entry,
        grid: entry.grid.map(move),
        ...(entry.legend !== undefined ? { legend: move(entry.legend) } : {}),
        ...(entry.visualMap !== undefined ? { visualMap: entry.visualMap.map(move) } : {}),
    };
}

/**
 * The place of each member of the layout at one square side. `scale` is the scale of the margins: the text
 * size of the container over the page text size.
 */
function placement(side: number, fields: SquareLayoutFields, scale: number): Placement {
    const margin = (value: number): number => Math.round(value * scale);
    const top = margin(fields.margins.top);
    const left = margin(fields.margins.left);
    const columns = Math.max(1, Math.min(fields.panels, FACET_COLUMNS));
    const rows = Math.max(1, Math.ceil(fields.panels / columns));
    const gap = margin(PANEL_GAP_PX);
    const grid: EchartOption[] = [];
    for (let panel = 0; panel < Math.max(1, fields.panels); panel += 1) {
        grid.push({
            left: left + (panel % columns) * (side + gap),
            top: top + Math.floor(panel / columns) * (side + gap),
            width: side,
            height: side,
            outerBoundsMode: "none",
        });
    }
    const blockRight = left + columns * side + (columns - 1) * gap;
    const bandLeft = blockRight + gap;
    const band = fields.side > 0 ? margin(fields.side) + gap : 0;
    const points = fields.points;
    const pointPx = points === undefined ? 0 : Math.max(POINT_MIN_PX, Math.round(points.px * Math.min(1, side / POINT_SCALE_FROM_PX) * 10) / 10);
    const squareLabel = fields.squareLabel;
    const series: EchartOption[] = Array.from(
        { length: Math.max(points?.series ?? 0, squareLabel === undefined ? 0 : squareLabel.series + 1) },
        (_entry, index) => ({
            ...(points !== undefined && index < points.series ? { symbolSize: pointPx } : {}),
            ...(squareLabel !== undefined && index === squareLabel.series ? { label: { width: side - 2 * squareLabel.insetPx, overflow: "break" } } : {}),
        }),
    );
    const blockBottom = top + rows * side + (rows - 1) * gap + margin(fields.margins.bottom);
    const bottomBand = fields.legendBand;
    const textPx = CHART_PAGE_TEXT_PX * scale;
    const legendHeight = bottomBand === undefined ? 0 : Math.round(legendLineCount(bottomBand.entries, blockRight - left, textPx) * legendLinePx(textPx));
    const legend =
        fields.legend !== true
            ? {}
            : bottomBand === undefined
              ? { legend: { left: bandLeft, top } }
              : { legend: { left, top: blockBottom, width: blockRight - left, orient: "horizontal" } };
    return {
        ...(series.length > 0 ? { series } : {}),
        grid,
        ...legend,
        ...(fields.visualMaps !== undefined && fields.visualMaps > 0
            ? { visualMap: Array.from({ length: fields.visualMaps }, () => ({ left: bandLeft, top })) }
            : {}),
        minWidth: blockRight + band + margin(fields.margins.right),
        minHeight: blockBottom + legendHeight,
    };
}

/** The range of one axis. */
export interface AxisRange {
    readonly min: number;
    readonly max: number;
}

/** The ranges of the two axes of one unit, and the tick step of a rounded pair. */
export interface EqualRanges {
    readonly x: AxisRange;
    readonly y: AxisRange;
    readonly step?: number;
}

/**
 * The ranges of two axes that share one unit: each axis spans one length, around its own data.
 *
 * `pad` widens the longer span by that share on each side. `round` ends each axis on a multiple of one round
 * step, and it states the step, thus the ticks of the two axes stand one step apart. The shorter axis grows by
 * whole steps on its two sides, an odd step on the low side, until its span matches. Each extent reads its
 * values in one pass.
 */
export function equalRanges(xs: readonly number[], ys: readonly number[], fields: { readonly pad: number; readonly round: boolean }): EqualRanges {
    const x = extent(xs);
    const y = extent(ys);
    const span = Math.max(x.max - x.min, y.max - y.min);
    const length = span > 0 ? span * (1 + 2 * fields.pad) : 1;
    if (!fields.round) {
        return { x: around(x, length), y: around(y, length) };
    }
    const step = roundStep(length / 5);
    const snapped = [x, y].map((range) => ({ min: Math.floor(range.min / step), max: Math.ceil(range.max / step) }));
    const steps = Math.max(...snapped.map((range) => range.max - range.min), 1);
    const [xRange, yRange] = snapped.map((range) => {
        const short = steps - (range.max - range.min);
        return { min: exact((range.min - Math.ceil(short / 2)) * step), max: exact((range.max + Math.floor(short / 2)) * step) };
    });
    return { x: xRange, y: yRange, step };
}

/** The extent of some values, or the unit range for no value. */
function extent(values: readonly number[]): AxisRange {
    if (values.length === 0) return { min: 0, max: 1 };
    let min = values[0];
    let max = values[0];
    for (const value of values) {
        if (value < min) min = value;
        if (value > max) max = value;
    }
    return { min, max };
}

/** One range of the given length around the middle of an extent. */
function around(range: AxisRange, length: number): AxisRange {
    const middle = (range.min + range.max) / 2;
    return { min: exact(middle - length / 2), max: exact(middle + length / 2) };
}

/** The round step at or above a raw step: one, two, two and a half, five, or ten times a power of ten. */
function roundStep(raw: number): number {
    const base = Math.pow(10, Math.floor(Math.log10(raw)));
    const fraction = raw / base;
    return exact((fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * base);
}

/** A number rounded to twelve significant digits, thus a float residue never reaches an axis. */
function exact(value: number): number {
    return Number(value.toPrecision(12));
}
