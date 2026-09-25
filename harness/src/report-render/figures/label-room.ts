/**
 * The place of the names that a figure of one unit draws on its data: the sample names of a PCA, and the
 * category names of an embedding.
 *
 * The chart runtime moves a label that overlaps another one only where the label states its own absolute
 * place, and the option holds no function that could state one. Thus the derivation places each name itself,
 * before the draw, in the units of the data. The square of the figure spans one length of data on each axis,
 * thus one estimate of the square size converts a text size in pixels to a size in data units on both axes.
 *
 * The estimate reads a square smaller than the square of the page, because the column export draws a smaller
 * square at a text size that shrinks less. A name that clears its neighbor at the estimate clears it at each
 * size. The place is a pure function of the points and the names, thus the same rows give the same places.
 */

import { CHART_EXPORT_SIZES, CHART_PAGE_TEXT_PX } from "../design.js";

/** The square side, in pixels, at which the derivation measures a name. */
const ESTIMATE_SQUARE_PX = 240;

/** The width of one character, and the height of one line, as a share of the text size. */
const CHARACTER_SHARE = 0.6;
const LINE_SHARE = 1.3;

/** The gap between a point and its name, in pixels. */
export const NAME_GAP_PX = 4;

/** One box in data units, or in pixels. */
export interface Box {
    readonly left: number;
    readonly right: number;
    readonly bottom: number;
    readonly top: number;
}

/** True when two boxes share an area. */
export function overlaps(a: Box, b: Box): boolean {
    return a.left < b.right && b.left < a.right && a.bottom < b.top && b.bottom < a.top;
}

/** The range of the two axes of a plot, in data units. */
export interface PlotRange {
    readonly x: { readonly min: number; readonly max: number };
    readonly y: { readonly min: number; readonly max: number };
}

/**
 * True when a name on one side of its point stays inside the plot on that side. A name at the left never
 * crosses the y axis, and a name under its point never crosses the x axis. A name over or under its point
 * centers on it, thus it can pass a side edge by a part of its width.
 */
function inside(box: Box, side: NameSide, plot: PlotRange): boolean {
    switch (side) {
        case "right":
            return box.right <= plot.x.max;
        case "left":
            return box.left >= plot.x.min;
        case "top":
            return box.top <= plot.y.max;
        case "bottom":
            return box.bottom >= plot.y.min;
    }
}

/** The size of one name in data units, for an axis of the given length. */
function nameSize(text: string, length: number): { readonly width: number; readonly height: number } {
    const unit = length / ESTIMATE_SQUARE_PX;
    return { width: text.length * CHARACTER_SHARE * CHART_PAGE_TEXT_PX * unit, height: LINE_SHARE * CHART_PAGE_TEXT_PX * unit };
}

/** One named point: its place in data units and its name. */
export interface NamedPoint {
    readonly x: number;
    readonly y: number;
    readonly text: string;
}

/** The four sides of a point where its name can sit, in the order that the figure tries them. */
export const NAME_SIDES = ["right", "left", "top", "bottom"] as const;

/** One side of a point. */
export type NameSide = (typeof NAME_SIDES)[number];

/**
 * The side of each point where its name sits, in the order of the points.
 *
 * Each name takes the first side, in the order right, left, top, bottom, where it stays inside the plot on that
 * side and covers no earlier name and no point. A name that finds no free side sits at the right. `plot` is the range of
 * the two axes in data units, and `pointPx` is the diameter of a point in pixels.
 */
export function pointNameSides(points: readonly NamedPoint[], plot: PlotRange, pointPx: number): NameSide[] {
    const length = plot.x.max - plot.x.min;
    const unit = length / ESTIMATE_SQUARE_PX;
    const reach = (pointPx / 2) * unit;
    const gap = NAME_GAP_PX * unit;
    const marks: Box[] = points.map((point) => ({ left: point.x - reach, right: point.x + reach, bottom: point.y - reach, top: point.y + reach }));
    const placed: Box[] = [];
    return points.map((point, index) => {
        const { width, height } = nameSize(point.text, length);
        const boxes: Record<NameSide, Box> = {
            right: { left: point.x + reach + gap, right: point.x + reach + gap + width, bottom: point.y - height / 2, top: point.y + height / 2 },
            left: { left: point.x - reach - gap - width, right: point.x - reach - gap, bottom: point.y - height / 2, top: point.y + height / 2 },
            top: { left: point.x - width / 2, right: point.x + width / 2, bottom: point.y + reach + gap, top: point.y + reach + gap + height },
            bottom: { left: point.x - width / 2, right: point.x + width / 2, bottom: point.y - reach - gap - height, top: point.y - reach - gap },
        };
        const free = NAME_SIDES.find((side) => {
            const box = boxes[side];
            return (
                inside(box, side, plot) && !placed.some((other) => overlaps(box, other)) && !marks.some((mark, other) => other !== index && overlaps(box, mark))
            );
        });
        const side = free ?? "right";
        placed.push(boxes[side]);
        return side;
    });
}

/**
 * The place of each category name on the data, in the order of the names.
 *
 * A name sits centered on its anchor, for example the median of its cells. A heavier name places first, thus
 * the name of a large cluster keeps its anchor. A name that covers an earlier name moves along y by whole
 * lines, up first, until it covers none. `weights` gives the weight of each name, for example its cell count.
 */
export function nameAnchors(names: readonly NamedPoint[], weights: readonly number[], length: number): Array<{ readonly x: number; readonly y: number }> {
    const order = names.map((_name, index) => index).sort((a, b) => weights[b] - weights[a] || a - b);
    const placed: Box[] = [];
    const out: Array<{ x: number; y: number }> = names.map((name) => ({ x: name.x, y: name.y }));
    for (const index of order) {
        const name = names[index];
        const { width, height } = nameSize(name.text, length);
        const boxAt = (y: number): Box => ({ left: name.x - width / 2, right: name.x + width / 2, bottom: y - height / 2, top: y + height / 2 });
        let chosen = name.y;
        for (const step of [0, 1, -1, 2, -2, 3, -3]) {
            const y = name.y + step * height;
            if (!placed.some((other) => overlaps(boxAt(y), other))) {
                chosen = y;
                break;
            }
        }
        placed.push(boxAt(chosen));
        out[index] = { x: name.x, y: Number(chosen.toPrecision(12)) };
    }
    return out;
}

/**
 * The plot of one render, where a dense figure measures its names: the plot size in pixels and the text size of
 * the render.
 *
 * Each frame is a little smaller than the plot that the chart runtime draws for a figure of one grid at that
 * size. A smaller frame puts the names nearer to each other than the drawn plot does, thus a name that clears
 * its neighbors in the frame clears them in the drawn plot.
 */
export interface NameFrame {
    readonly widthPx: number;
    readonly heightPx: number;
    readonly textPx: number;
}

/** The width of one text in pixels at one text size: the estimate of each figure that places its own text. */
export function textWidthPx(text: string, textPx: number): number {
    return text.length * CHARACTER_SHARE * textPx;
}

/** The frame of the page: the plot inside the 900 by 400 pixel chart body of a window 1280 pixels wide. */
export const PAGE_PLOT_FRAME: NameFrame = { widthPx: 760, heightPx: 285, textPx: CHART_PAGE_TEXT_PX };

/** The frame of the single-column export: the plot inside the 336 by 253 pixel chart, and the 7 pt text. */
export const COLUMN_PLOT_FRAME: NameFrame = { widthPx: 260, heightPx: 160, textPx: CHART_EXPORT_SIZES.single.textPx };

/** The frame of the double-column export: the plot inside the 692 by 348 pixel chart, and the 7 pt text. */
export const DOUBLE_COLUMN_PLOT_FRAME: NameFrame = { widthPx: 580, heightPx: 245, textPx: CHART_EXPORT_SIZES.double.textPx };

/** The frame of the slide export: the plot inside the 1920 by 1080 pixel chart, and the slide text. */
export const SLIDE_PLOT_FRAME: NameFrame = { widthPx: 1600, heightPx: 760, textPx: CHART_EXPORT_SIZES.slide.textPx };

/** The frame of each export size. A new export size joins with the frame of its plot. */
export const EXPORT_PLOT_FRAMES: Readonly<Record<keyof typeof CHART_EXPORT_SIZES, NameFrame>> = {
    single: COLUMN_PLOT_FRAME,
    double: DOUBLE_COLUMN_PLOT_FRAME,
    slide: SLIDE_PLOT_FRAME,
};

/**
 * The three places of a name beside its anchor: the text starts at the anchor, the text ends at the anchor,
 * or the text centers over the anchor.
 */
export type LeaderSide = "right" | "left" | "top";

/** The anchor of one name in data units, and the side of the anchor where the text sits. */
export interface LeaderName {
    readonly x: number;
    readonly y: number;
    readonly side: LeaderSide;
}

/** The points that no name can cover: the plotted pair of each row, and the diameter of the largest point. */
export interface NameObstacles {
    readonly xs: readonly (number | null)[];
    readonly ys: readonly (number | null)[];
    readonly pointPx: number;
}

/** The most lines that a name moves away from its point before the figure gives it up. */
const LEADER_STEPS = 12;

/**
 * The anchor of each name, in the order of the names, or `undefined` for a name that finds no free place.
 *
 * The names come in the order of their weight, thus the most important name places first. Each name tries the
 * sides in the given order, first beside its point, then one line further away at each step, up before down.
 * A leader line joins each point to the anchor of its name. A place is free when the name stays inside the
 * plot, when the name and its leader line cross no earlier name and no earlier leader line, and when they cover
 * no point. Where no place is free, the name takes the first place clear of the earlier names and leader lines
 * that covers the fewest points. A name that finds no place clear of them draws nothing.
 *
 * The geometry runs in pixels of `frame`, and each point enters a grid of cells one line high. Thus a test of
 * one place reads the points of a few cells alone, and a table of many thousand points costs one pass to index.
 * `plot` is the range of the two axes in data units. `top` is the highest y in data units that the text of a
 * name can reach, because the chart runtime can end the y axis at the largest point. `reserved` holds the boxes
 * in data units that other text of the figure takes, for example the label of a guide line, and no name covers
 * one. A leader line can pass one, because a point can lie under the text.
 */
export function placeLeaderNames(
    names: readonly NamedPoint[],
    obstacles: NameObstacles,
    plot: PlotRange,
    sides: readonly LeaderSide[],
    top: number,
    frame: NameFrame = COLUMN_PLOT_FRAME,
    reserved: readonly Box[] = [],
): Array<LeaderName | undefined> {
    const xSpan = plot.x.max - plot.x.min;
    const ySpan = plot.y.max - plot.y.min;
    if (!(xSpan > 0) || !(ySpan > 0)) return names.map(() => undefined);
    const toX = (x: number): number => ((x - plot.x.min) / xSpan) * frame.widthPx;
    const toY = (y: number): number => ((y - plot.y.min) / ySpan) * frame.heightPx;
    const lineHeight = LINE_SHARE * frame.textPx;
    const reach = obstacles.pointPx / 2;
    const ceiling = Math.min(frame.heightPx, toY(top) + lineHeight / 2);

    const cells = new Map<string, Array<{ x: number; y: number }>>();
    const cellOf = (value: number): number => Math.floor(value / lineHeight);
    for (let index = 0; index < obstacles.xs.length; index += 1) {
        const x = obstacles.xs[index];
        const y = obstacles.ys[index];
        if (x === null || y === null) continue;
        const point = { x: toX(x), y: toY(y) };
        const key = `${cellOf(point.x)}:${cellOf(point.y)}`;
        const cell = cells.get(key);
        if (cell === undefined) cells.set(key, [point]);
        else cell.push(point);
    }
    const coveredPoints = (box: Box): number => {
        let count = 0;
        for (let column = cellOf(box.left - reach); column <= cellOf(box.right + reach); column += 1) {
            for (let row = cellOf(box.bottom - reach); row <= cellOf(box.top + reach); row += 1) {
                const cell = cells.get(`${column}:${row}`);
                if (cell === undefined) continue;
                for (const point of cell) {
                    if (point.x + reach > box.left && point.x - reach < box.right && point.y + reach > box.bottom && point.y - reach < box.top) count += 1;
                }
            }
        }
        return count;
    };

    // The points that a leader line passes, sampled at each point radius along the line. The named point and
    // the points that touch it sit at the start of the line, thus the count starts one point width away.
    const crossedPoints = (from: Point, to: Point): number => {
        const length = Math.hypot(to.x - from.x, to.y - from.y);
        const spacing = Math.max(reach, 1);
        let count = 0;
        for (let along = 2 * reach + NAME_GAP_PX; along < length; along += spacing) {
            const at = { x: from.x + ((to.x - from.x) * along) / length, y: from.y + ((to.y - from.y) * along) / length };
            count += coveredPoints({ left: at.x, right: at.x, bottom: at.y, top: at.y });
        }
        return count;
    };

    const kept = reserved.map((box) => ({ left: toX(box.left), right: toX(box.right), bottom: toY(box.bottom), top: toY(box.top) }));
    const placed: Box[] = [];
    const leaders: Array<readonly [Point, Point]> = [];
    return names.map((name) => {
        const width = textWidthPx(name.text, frame.textPx);
        const point = { x: toX(name.x), y: toY(name.y) };
        let best: { anchor: Point; side: LeaderSide; box: Box; covered: number } | undefined;
        search: for (let step = 0; step <= LEADER_STEPS; step += 1) {
            for (const side of sides) {
                for (const direction of side === "top" || step === 0 ? [1] : [1, -1]) {
                    const anchor = leaderAnchor(point, side, step, direction, reach, lineHeight, width, frame.widthPx);
                    const box = leaderBox(anchor, side, width, lineHeight);
                    const inside = box.left >= 0 && box.right <= frame.widthPx && box.bottom >= 0 && box.top <= ceiling;
                    if (!inside || kept.some((other) => overlaps(box, other))) continue;
                    if (placed.some((other) => overlaps(box, other) || crosses(point, anchor, other))) continue;
                    if (leaders.some(([from, to]) => crosses(from, to, box))) continue;
                    const covered = coveredPoints(box) + crossedPoints(point, anchor);
                    if (best === undefined || covered < best.covered) best = { anchor, side, box, covered };
                    if (covered === 0) break search;
                }
            }
        }
        if (best === undefined) return undefined;
        placed.push(best.box);
        leaders.push([point, best.anchor]);
        const x = plot.x.min + (best.anchor.x / frame.widthPx) * xSpan;
        const y = plot.y.min + (best.anchor.y / frame.heightPx) * ySpan;
        return { x: Number(x.toPrecision(12)), y: Number(y.toPrecision(12)), side: best.side };
    });
}

/** One place in pixels. */
interface Point {
    readonly x: number;
    readonly y: number;
}

/**
 * True when the segment between two places passes through a box: the clip of Liang and Barsky, which keeps the
 * part of the segment inside each of the four edges.
 */
function crosses(from: Point, to: Point, box: Box): boolean {
    let enter = 0;
    let leave = 1;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    for (const [p, q] of [
        [-dx, from.x - box.left],
        [dx, box.right - from.x],
        [-dy, from.y - box.bottom],
        [dy, box.top - from.y],
    ] as const) {
        if (p === 0) {
            if (q < 0) return false;
            continue;
        }
        const ratio = q / p;
        if (p < 0) enter = Math.max(enter, ratio);
        else leave = Math.min(leave, ratio);
        if (enter > leave) return false;
    }
    return true;
}

/**
 * The anchor of a name in pixels: beside the point at the right or at the left, or over it, then one line
 * further away at each step. A name over a point near a side edge of the plot moves along x until it fits
 * inside the plot, and its leader line then leans.
 */
function leaderAnchor(
    point: { readonly x: number; readonly y: number },
    side: LeaderSide,
    step: number,
    direction: number,
    reach: number,
    lineHeight: number,
    width: number,
    plotWidth: number,
): { x: number; y: number } {
    const gap = NAME_GAP_PX;
    switch (side) {
        case "right":
            return { x: point.x + reach + gap, y: point.y + direction * step * lineHeight };
        case "left":
            return { x: point.x - reach - gap, y: point.y + direction * step * lineHeight };
        case "top":
            return { x: Math.min(Math.max(point.x, width / 2), plotWidth - width / 2), y: point.y + reach + gap + step * lineHeight };
    }
}

/** The box of a name in pixels at its anchor. */
function leaderBox(anchor: { readonly x: number; readonly y: number }, side: LeaderSide, width: number, height: number): Box {
    switch (side) {
        case "right":
            return { left: anchor.x, right: anchor.x + width, bottom: anchor.y - height / 2, top: anchor.y + height / 2 };
        case "left":
            return { left: anchor.x - width, right: anchor.x, bottom: anchor.y - height / 2, top: anchor.y + height / 2 };
        case "top":
            return { left: anchor.x - width / 2, right: anchor.x + width / 2, bottom: anchor.y, top: anchor.y + height };
    }
}

/** The box of one placed name in data units, for a test that a name covers no neighbor and no point. */
export function leaderNameBox(name: LeaderName, text: string, plot: PlotRange, frame: NameFrame = COLUMN_PLOT_FRAME): Box {
    const xUnit = (plot.x.max - plot.x.min) / frame.widthPx;
    const yUnit = (plot.y.max - plot.y.min) / frame.heightPx;
    const box = leaderBox({ x: 0, y: 0 }, name.side, textWidthPx(text, frame.textPx), LINE_SHARE * frame.textPx);
    return { left: name.x + box.left * xUnit, right: name.x + box.right * xUnit, bottom: name.y + box.bottom * yUnit, top: name.y + box.top * yUnit };
}
