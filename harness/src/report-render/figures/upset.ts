/**
 * The UpSet plot: the intersections of some sets, as upset.app, UpSetR, and ComplexHeatmap draw them.
 *
 * The figure reads one row for each member of each set: the `x` column names the element, and the `group`
 * column names the set. Three grids line up:
 *
 * - The top grid draws the size of each intersection as a bar, with its count over the bar.
 * - The middle grid draws the dot matrix: one column for each intersection and one row for each set. A dark
 *   dot marks each member set of the intersection, a light dot marks each other set, and a line joins the
 *   member dots of the column.
 * - The left grid draws the size of each set as a bar that grows to the left, on the rows of the matrix. The
 *   set names sit between these bars and the matrix.
 *
 * The figure computes two named summaries, and each one reads the rows of the bound table alone:
 *
 * - The size of a set: the count of its distinct elements.
 * - The exact intersection of an element: the combination of every set that holds it. The size of an
 *   intersection is the count of its elements, thus each element counts in one intersection alone.
 *
 * The sets sort by size, the largest at the top, and a tie keeps the first appearance. The intersections sort
 * by size, largest first, then by degree, smallest first, then by the set order of their members. The largest
 * intersections draw alone past the cap, and the title under the matrix states the count of the others.
 *
 * The dots and the count text of one column must fit the column at each export size, thus one media rule for
 * each export size states the dot size and the turn of the count text there.
 */

import { err, ok, type Result } from "neverthrow";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import type { Cell, ChartRow, EchartOption } from "../chart.js";
import { CHART_BODY_PX, CHART_EXPORT_SIZES, CHART_INK, CHART_PAGE_TEXT_PX, CHART_PAGE_WIDTH_PX } from "../design.js";
import type { RenderProblem } from "../types.js";
import { axisNameFields, chartProblem, demandedColumn, valueAxis } from "./common.js";
import type { FigureContext, FigureModule } from "./index.js";

/**
 * The most sets that one figure draws. Each set takes one row of the matrix, and the rows of twelve sets hold
 * one line of the column-export text each.
 */
export const UPSET_SET_LIMIT = 12;

/** The most intersections that one figure draws. The largest ones draw, and the title states the count of the others. */
export const UPSET_INTERSECTION_LIMIT = 30;

/** The titles of the two value axes. */
const INTERSECTION_TITLE = "Intersection size";
const SET_TITLE = "Set size";

/** The light dot of a set that is not a member of the intersection. */
const ABSENT_DOT_COLOR = "#e0e0e0";

/** The text between the member names of one intersection. */
const MEMBER_SEPARATOR = " & ";

/** The places of the grids, in percent of the chart: the top margin, the gap between the bars and the matrix, and the left and right margins. */
const TOP_PCT = 9;
const GAP_PCT = 3;
const SIDE_PCT = 3;

/** The width of the set-size bars, in percent of the chart. */
const SET_BAR_PCT = 16;

/** The height of one set row, and of the whole matrix, at most, in percent of the chart. */
const ROW_MAX_PCT = 7;
const MATRIX_MAX_PCT = 50;

/** The share of the smaller band of one cell that its dot fills, and the bounds of a dot, in pixels. */
const DOT_SHARE = 0.7;
const DOT_MIN_PX = 2;
const DOT_MAX_PX = 16;

/** The width of the line that joins the member dots, as a share of the dot size, and its smallest width in pixels. */
const JOIN_SHARE = 0.25;
const JOIN_MIN_PX = 1;

/** The width of one character of the chart text, as a share of the text size. The layout estimates a name width with it. */
const CHARACTER_SHARE = 0.6;

/** The gap between a set name and the matrix, and between the name and the set bars, in pixels. */
const NAME_GAP_PX = 8;

/** The lines of text under the matrix: the tick labels and the title of the set bars, with their gaps. */
const BOTTOM_LINES = 3.2;

/** The UpSet module: the element and the set. */
export const UPSET_FIGURE: FigureModule = { reads: new Set(["x", "group"]), derive: deriveUpset };

/** One set: its name and the count of its elements. */
export interface UpsetSet {
    readonly name: string;
    readonly size: number;
}

/** One exact intersection: the places of its member sets in the set order, and the count of its elements. */
export interface UpsetIntersection {
    readonly members: readonly number[];
    readonly size: number;
}

/** The computed summary of the figure: the sets in size order, and each intersection in draw order. */
export interface UpsetSummary {
    readonly sets: readonly UpsetSet[];
    readonly intersections: readonly UpsetIntersection[];
}

/** True when a cell holds no text. */
function emptyCell(cell: Cell | undefined): boolean {
    return cell === undefined || String(cell).trim() === "";
}

/**
 * The set sizes and the exact intersections of one membership table.
 *
 * A row with an empty set cell names an element in no set, and it adds nothing: the empty intersection draws
 * no column. The error is the detail of the refusal.
 */
export function upsetSummary(rows: readonly ChartRow[], element: string, set: string): Result<UpsetSummary, string> {
    const setsOf = new Map<string, Set<string>>();
    const sizes = new Map<string, number>();
    for (const row of rows) {
        const setCell = row[set];
        if (emptyCell(setCell)) continue;
        const setName = String(setCell).trim();
        if (emptyCell(row[element])) {
            return err(`A row of the set "${setName}" names no element in the "${element}" column.`);
        }
        const elementName = String(row[element]).trim();
        const held = setsOf.get(elementName) ?? new Set<string>();
        if (held.has(setName)) {
            return err(`The element "${elementName}" is a member of the set "${setName}" in two rows. The table holds one row for each member of each set.`);
        }
        held.add(setName);
        setsOf.set(elementName, held);
        sizes.set(setName, (sizes.get(setName) ?? 0) + 1);
    }
    if (sizes.size === 0) {
        return err(`The table names no set in the "${set}" column, thus the figure has no intersection to draw.`);
    }
    if (sizes.size > UPSET_SET_LIMIT) {
        return err(`The table names ${sizes.size} sets. An upset figure draws ${UPSET_SET_LIMIT} sets at most, thus a table of fewer sets serves the reader.`);
    }
    // The map keeps the first appearance, and the sort is stable, thus a tie keeps that order.
    const sets = [...sizes.entries()].map(([name, size]) => ({ name, size })).sort((a, b) => b.size - a.size);
    const places = new Map(sets.map((entry, place) => [entry.name, place]));
    const counts = new Map<string, { members: number[]; size: number }>();
    for (const held of setsOf.values()) {
        const members = [...held].map((name) => places.get(name) ?? -1).sort((a, b) => a - b);
        const key = members.join(",");
        const entry = counts.get(key) ?? { members, size: 0 };
        entry.size += 1;
        counts.set(key, entry);
    }
    const intersections = [...counts.values()].sort((a, b) => b.size - a.size || a.members.length - b.members.length || compareMembers(a.members, b.members));
    return ok({ sets, intersections });
}

/** Compare two member lists of one degree by the set order: the list whose first different set comes first sorts first. */
function compareMembers(a: readonly number[], b: readonly number[]): number {
    for (let place = 0; place < Math.min(a.length, b.length); place += 1) {
        if (a[place] !== b[place]) return a[place] - b[place];
    }
    return a.length - b.length;
}

/** The size of one chart box and its text: the page, or one export. */
interface ChartBox {
    readonly widthPx: number;
    readonly heightPx: number;
    readonly textPx: number;
}

/** The page box and the box of each export size. */
const PAGE_BOX: ChartBox = { widthPx: CHART_PAGE_WIDTH_PX, heightPx: CHART_BODY_PX, textPx: CHART_PAGE_TEXT_PX };
const EXPORT_SIZES = [CHART_EXPORT_SIZES.single, CHART_EXPORT_SIZES.double, CHART_EXPORT_SIZES.slide] as const;

/** The places of the grids in percent of the chart. */
interface UpsetLayout {
    readonly matrixLeft: number;
    readonly matrixTop: number;
    readonly matrixBottom: number;
    readonly rowPct: number;
}

/**
 * The places of the grids for some sets, and set names of some length.
 *
 * The set names take a band between the set bars and the matrix, and the tick labels with the title of the set
 * bars take a band under the matrix. Each band holds its text at the page and at the single column, thus the
 * percent layout serves each export.
 */
function upsetLayout(setCount: number, longestName: number): UpsetLayout {
    const boxes: readonly ChartBox[] = [PAGE_BOX, CHART_EXPORT_SIZES.single];
    const namePct = Math.max(...boxes.map((box) => ((longestName * box.textPx * CHARACTER_SHARE + 2 * NAME_GAP_PX) / box.widthPx) * 100));
    const bottomPct = Math.max(...boxes.map((box) => ((BOTTOM_LINES * box.textPx + NAME_GAP_PX) / box.heightPx) * 100));
    const rowPct = Math.min(ROW_MAX_PCT, MATRIX_MAX_PCT / setCount);
    return {
        matrixLeft: rounded(SIDE_PCT + SET_BAR_PCT + namePct),
        matrixTop: rounded(100 - bottomPct - rowPct * setCount),
        matrixBottom: rounded(bottomPct),
        rowPct,
    };
}

/** The dot size of one box: a share of the smaller band of one cell, within the bounds. */
function dotPx(layout: UpsetLayout, columns: number, box: ChartBox): number {
    const column = (((100 - layout.matrixLeft - SIDE_PCT) / 100) * box.widthPx) / columns;
    const row = (layout.rowPct / 100) * box.heightPx;
    return rounded(Math.min(DOT_MAX_PX, Math.max(DOT_MIN_PX, DOT_SHARE * Math.min(column, row))));
}

/**
 * The count text over the intersection bars at one box. A text wider than its column turns upright, thus the
 * counts of many narrow columns stand side by side and none hides the next.
 */
function countLabel(layout: UpsetLayout, columns: number, digits: number, box: ChartBox): EchartOption {
    const column = (((100 - layout.matrixLeft - SIDE_PCT) / 100) * box.widthPx) / columns;
    const upright = digits * box.textPx * CHARACTER_SHARE > column;
    return upright
        ? { show: true, position: "top", color: CHART_INK, rotate: 90, align: "left", verticalAlign: "middle", distance: 4 }
        : { show: true, position: "top", color: CHART_INK, distance: 2 };
}

/** One layout percentage, rounded, thus a float residue never reaches the option. */
function rounded(value: number): number {
    return Math.round(value * 1e4) / 1e4;
}

/** A percent of the chart as the option states it. */
function pct(value: number): string {
    return `${rounded(value)}%`;
}

function deriveUpset(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<EchartOption, RenderProblem> {
    const source = { blockId: context.blockId, rows, ...(context.columns !== undefined ? { columns: context.columns } : {}) };
    const encoding = block.encoding ?? {};
    const element = demandedColumn("upset", encoding, "x", source);
    if (element.isErr()) return err(element.error);
    const set = demandedColumn("upset", encoding, "group", source);
    if (set.isErr()) return err(set.error);
    if (rows.length === 0) {
        return err(chartProblem(context.blockId, "The upset figure has no rows. It needs one row for each member of each set."));
    }
    const summary = upsetSummary(rows, element.value, set.value);
    if (summary.isErr()) return err(chartProblem(context.blockId, summary.error));

    const { sets, intersections } = summary.value;
    const drawn = intersections.slice(0, UPSET_INTERSECTION_LIMIT);
    const hidden = intersections.length - drawn.length;
    const setNames = sets.map((entry) => entry.name);
    const columnNames = drawn.map((entry) => entry.members.map((place) => setNames[place]).join(MEMBER_SEPARATOR));
    const layout = upsetLayout(sets.length, Math.max(...setNames.map((name) => name.length)));
    const digits = Math.max(...drawn.map((entry) => String(entry.size).length));

    const members: number[][] = [];
    const absent: number[][] = [];
    const joins: EchartOption[] = [];
    for (const [column, entry] of drawn.entries()) {
        const held = new Set(entry.members);
        for (let row = 0; row < sets.length; row += 1) {
            (held.has(row) ? members : absent).push([column, row]);
        }
        if (entry.members.length > 1) {
            joins.push({
                coords: [
                    [column, entry.members[0]],
                    [column, entry.members[entry.members.length - 1]],
                ],
            });
        }
    }

    const pageDot = dotPx(layout, drawn.length, PAGE_BOX);
    const matrixGrid = { left: pct(layout.matrixLeft), right: pct(SIDE_PCT), top: pct(layout.matrixTop), bottom: pct(layout.matrixBottom) };
    const hiddenAxis = { axisLabel: { show: false }, axisTick: { show: false }, axisLine: { show: false } };
    const series: EchartOption[] = [
        {
            id: "intersections",
            type: "bar",
            xAxisIndex: 0,
            yAxisIndex: 0,
            barCategoryGap: "30%",
            itemStyle: { color: CHART_INK },
            label: countLabel(layout, drawn.length, digits, PAGE_BOX),
            tooltip: { formatter: "{b}: {c}" },
            data: drawn.map((entry) => entry.size),
        },
        {
            id: "sets",
            type: "bar",
            xAxisIndex: 2,
            yAxisIndex: 2,
            barCategoryGap: "40%",
            itemStyle: { color: CHART_INK },
            tooltip: { formatter: "{b}: {c}" },
            data: sets.map((entry) => entry.size),
        },
        {
            id: "absent",
            type: "scatter",
            xAxisIndex: 1,
            yAxisIndex: 1,
            silent: true,
            symbolSize: pageDot,
            itemStyle: { color: ABSENT_DOT_COLOR },
            z: 1,
            data: absent,
        },
        {
            id: "joins",
            type: "lines",
            coordinateSystem: "cartesian2d",
            xAxisIndex: 1,
            yAxisIndex: 1,
            silent: true,
            lineStyle: { color: CHART_INK, width: joinPx(pageDot), opacity: 1 },
            z: 2,
            data: joins,
        },
        {
            id: "members",
            type: "scatter",
            xAxisIndex: 1,
            yAxisIndex: 1,
            silent: true,
            symbolSize: pageDot,
            itemStyle: { color: CHART_INK, opacity: 1 },
            z: 3,
            data: members,
        },
    ];

    return ok({
        tooltip: { trigger: "item" },
        legend: { show: false },
        grid: [
            { left: matrixGrid.left, right: matrixGrid.right, top: pct(TOP_PCT), bottom: pct(100 - layout.matrixTop + GAP_PCT) },
            matrixGrid,
            { left: pct(SIDE_PCT), width: pct(SET_BAR_PCT), top: matrixGrid.top, bottom: matrixGrid.bottom },
        ],
        xAxis: [
            { type: "category", gridIndex: 0, data: columnNames, axisLabel: { show: false }, axisTick: { show: false } },
            {
                type: "category",
                gridIndex: 1,
                data: columnNames,
                ...hiddenAxis,
                ...(hidden > 0 ? { ...axisNameFields("x", `Intersections: ${drawn.length} of ${intersections.length} shown`), nameGap: NAME_GAP_PX } : {}),
            },
            { ...valueAxis("x", SET_TITLE), gridIndex: 2, inverse: true, splitNumber: 2, minInterval: 1, axisLabel: { rotate: 0 } },
        ],
        yAxis: [
            { ...valueAxis("y", INTERSECTION_TITLE), gridIndex: 0, splitNumber: 3, minInterval: 1 },
            { type: "category", gridIndex: 1, inverse: true, data: setNames, axisTick: { show: false }, axisLine: { show: false } },
            { type: "category", gridIndex: 2, inverse: true, data: setNames, show: false },
        ],
        series,
        media: EXPORT_SIZES.map((size) => {
            const dot = dotPx(layout, drawn.length, size);
            return {
                query: { minWidth: size.widthPx, maxWidth: size.widthPx, minHeight: size.heightPx, maxHeight: size.heightPx },
                option: {
                    series: [
                        { label: countLabel(layout, drawn.length, digits, size) },
                        {},
                        { symbolSize: dot },
                        { lineStyle: { width: joinPx(dot) } },
                        { symbolSize: dot },
                    ],
                },
            };
        }),
    });
}

/** The width of the line that joins the member dots of one column, at one dot size. */
function joinPx(dot: number): number {
    return rounded(Math.max(JOIN_MIN_PX, dot * JOIN_SHARE));
}
