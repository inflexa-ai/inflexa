/**
 * The lollipop: the mutations of one protein along its amino-acid positions, over its domain track.
 *
 * The canonical design is the one of maftools and of the cBioPortal mutation view. Each row draws a stem from
 * zero to its count and a head at the count, in the color of its class. The domains of the track draw as
 * labeled boxes on a band under the axis, over a gray backbone of the whole protein. The x axis spans the
 * protein: from zero to the length column of the track, or to the largest end and position where the track
 * names no length or where one of them passes it. The three largest counts carry the text of the label column.
 *
 * The figure computes no summary. Each stem is one row with a class where the block names a class column, each
 * box is one row of the track, and the lane of a box is the first lane where it overlaps no earlier box, thus
 * the lanes follow the order of the track rows.
 */

import { err, ok, type Result } from "neverthrow";

import { channelColumn, channelOrder, channelTransform, type ChartBlock } from "../../contracts/report-blocks.js";
import { STEM_RENDERER } from "../chart-renderers.js";
import type { ChartRow, EchartOption } from "../chart.js";
import { CHART_INK, CHART_PALETTE, GUIDE_LINE_COLOR } from "../design.js";
import type { RenderProblem } from "../types.js";
import {
    categoricalPalette,
    categoryName,
    chartProblem,
    columnPresent,
    firstAppearance,
    firstFreeLanes,
    toNumber,
    valueAxis,
    valueAxisTitle,
} from "./common.js";
import type { FigureContext, FigureModule, FigureTrack } from "./index.js";
import { classColors, classOf, legendClasses } from "./oncoprint.js";

/** The semantic title of the position axis and of the count axis. */
const POSITION_TITLE = "Amino-acid position";
const COUNT_TITLE = "Mutations";

/** The count of the largest counts that carry the text of the label column. */
const LABELED_COUNT = 3;

/**
 * The count of characters that the full span of the x axis holds at the single journal column. A box label
 * takes the share of this count that its box spans, thus a label never runs past its box at that width.
 */
const LABEL_CHARS_ACROSS = 60;

/** The fewest characters that a shortened box label shows. A box too narrow for them draws no label. */
const LABEL_MIN_CHARS = 4;

/** The places of the two grids with a track, in percent of the chart: the stems, and the domain band under them. */
const STEM_GRID: EchartOption = { left: "10%", right: "5%", top: "10%", bottom: "44%" };
const BAND_GRID: EchartOption = { left: "10%", right: "5%", top: "58%", height: "12%" };

/** The icon size and the gap of the class legend, in pixels, as the oncoprint states them. */
const LEGEND_ICON_PX = 10;
const LEGEND_GAP_PX = 8;

/** The margin of a box inside its lane, and of the backbone inside the band, in lanes. */
const BOX_MARGIN = 0.1;
const BACKBONE_MARGIN = 0.3;

/** The opacity of a domain box. The box reads as a region of the backbone, and its label reads on it. */
const BOX_OPACITY = 0.35;

/** The lollipop module: the position, the count, the class, the label, and the domain track. */
export const LOLLIPOP_FIGURE: FigureModule = { reads: new Set(["x", "y", "group", "label", "track"]), derive: deriveLollipop };

/** One plotted mutation: the row, its position, and its count. */
interface Stem {
    readonly row: ChartRow;
    readonly x: number;
    readonly y: number;
}

/** One box of the track: its span, its name, and its lane. */
interface DomainBox {
    readonly start: number;
    readonly end: number;
    readonly name: string;
    readonly lane: number;
}

function deriveLollipop(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<EchartOption, RenderProblem> {
    const position = numericChannel(block, rows, context, "x");
    if (position.isErr()) return err(position.error);
    const count = numericChannel(block, rows, context, "y");
    if (count.isErr()) return err(count.error);
    const groupChannel = block.encoding?.group;
    if (groupChannel !== undefined && (channelTransform(groupChannel) !== undefined || channelOrder(groupChannel) !== undefined)) {
        return err(
            chartProblem(
                context.blockId,
                'The lollipop reads the "group" column as the class of each row, thus the channel takes no transform and no "orderBy".',
            ),
        );
    }
    const group = groupChannel === undefined ? undefined : channelColumn(groupChannel);
    const label = block.encoding?.label;
    for (const column of [group, label]) {
        if (column !== undefined && rows.length > 0 && !columnPresent(column, rows, context.columns)) {
            return err(chartProblem(context.blockId, `The column "${column}" is absent from every row.`));
        }
    }

    const stems: Stem[] = [];
    for (const row of rows) {
        const x = toNumber(row[position.value]);
        const y = toNumber(row[count.value]);
        // A row with no class falls in no stem series, thus it takes no label and no room on the axis either.
        if (x !== null && y !== null && (group === undefined || classOf(row, group) !== undefined)) stems.push({ row, x, y });
    }
    const boxes = context.track === undefined ? ok(undefined) : domainBoxes(context.blockId, context.track);
    if (boxes.isErr()) return err(boxes.error);
    const length = axisLength(stems, context.track, boxes.value);

    const classes = group === undefined ? [] : legendClasses(rows, group);
    const colors = classColors(classes);
    const stemTitle = valueAxisTitle(context.labels, count.value, COUNT_TITLE);
    const series: EchartOption[] =
        group === undefined
            ? [stemSeries(stemTitle, CHART_PALETTE[0], stems, label)]
            : classes.map((name, index) =>
                  stemSeries(
                      categoryName(name),
                      colors[index],
                      stems.filter((stem) => classOf(stem.row, group) === name),
                      label,
                  ),
              );
    if (label !== undefined) series.push(labelSeries(stems, label));

    const positionTitle = valueAxisTitle(context.labels, position.value, POSITION_TITLE);
    const countAxis = { ...valueAxis("y", stemTitle, { min: 0 }), minInterval: 1 };
    const legend = {
        bottom: 0,
        itemWidth: LEGEND_ICON_PX,
        itemHeight: LEGEND_ICON_PX,
        itemGap: LEGEND_GAP_PX,
        data: series.filter((entry) => entry.renderItem === STEM_RENDERER).map((entry) => String(entry.name)),
    };
    if (boxes.value === undefined) {
        return ok({ tooltip: { trigger: "item" }, xAxis: valueAxis("x", positionTitle, { min: 0, max: length }), yAxis: countAxis, series, legend });
    }
    const lanes = boxes.value.reduce((most, box) => Math.max(most, box.lane + 1), 1);
    return ok({
        tooltip: { trigger: "item" },
        grid: [{ ...STEM_GRID }, { ...BAND_GRID }],
        xAxis: [
            { type: "value", min: 0, max: length, axisLabel: { show: false }, axisTick: { show: false } },
            { ...valueAxis("x", positionTitle, { min: 0, max: length }), gridIndex: 1, axisLine: { show: false }, splitLine: { show: false } },
        ],
        yAxis: [countAxis, { type: "value", gridIndex: 1, min: 0, max: lanes, inverse: true, show: false }],
        series: [...series, bandSeries(boxes.value, length, lanes)],
        legend,
    });
}

/** The column of one numeric channel. An absent channel, a transform, and a column that no row holds each refuse. */
function numericChannel(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext, name: "x" | "y"): Result<string, RenderProblem> {
    const channel = block.encoding?.[name];
    if (channel === undefined) {
        return err(chartProblem(context.blockId, `The lollipop figure needs a column for the "${name}" channel.`));
    }
    if (channelTransform(channel) !== undefined || channelOrder(channel) !== undefined) {
        return err(
            chartProblem(context.blockId, `The lollipop reads the "${name}" column as it stands, thus the channel takes no transform and no "orderBy".`),
        );
    }
    const column = channelColumn(channel);
    if (rows.length > 0 && !columnPresent(column, rows, context.columns)) {
        return err(chartProblem(context.blockId, `The column "${column}" is absent from every row.`));
    }
    return ok(column);
}

/**
 * The boxes of the track in the order of its rows, each one in the first lane where it overlaps no earlier box.
 * A row whose start or end is not numeric draws no box, and a row whose end precedes its start refuses.
 */
function domainBoxes(blockId: string, track: FigureTrack): Result<DomainBox[], RenderProblem> {
    for (const column of [track.start, track.end, track.label]) {
        if (track.rows.length > 0 && !columnPresent(column, track.rows, track.columns)) {
            return err(chartProblem(blockId, `The track table holds no "${column}" column.`));
        }
    }
    const laneOf = firstFreeLanes(track.rows.length);
    const boxes: DomainBox[] = [];
    for (const [index, row] of track.rows.entries()) {
        const start = toNumber(row[track.start]);
        const end = toNumber(row[track.end]);
        if (start === null || end === null) continue;
        if (end < start) {
            return err(chartProblem(blockId, `The track row ${index + 1} ends at ${end}, before its start at ${start}. A domain ends at or after its start.`));
        }
        boxes.push({ start, end, name: String(row[track.label] ?? ""), lane: laneOf(start, end) });
    }
    return ok(boxes);
}

/**
 * The end of the x axis: the largest of the length column of the first track row that holds a number, the
 * largest end of a box, and the largest position of a stem. A mutation table and a domain table of two isoforms
 * disagree on the length, and each stem and each box stays inside the plot.
 */
function axisLength(stems: readonly Stem[], track: FigureTrack | undefined, boxes: readonly DomainBox[] | undefined): number {
    let largest = 0;
    const lengthColumn = track?.length;
    if (track !== undefined && lengthColumn !== undefined) {
        for (const row of track.rows) {
            const length = toNumber(row[lengthColumn]);
            if (length === null) continue;
            largest = length;
            break;
        }
    }
    for (const stem of stems) largest = Math.max(largest, stem.x);
    for (const box of boxes ?? []) largest = Math.max(largest, box.end);
    return largest;
}

/** The stems in order of their count, the largest first, thus a smaller head draws over the stem of a larger one. */
function byCount(stems: readonly Stem[]): Stem[] {
    return stems
        .map((stem, place) => ({ stem, place }))
        .sort((a, b) => b.stem.y - a.stem.y || a.place - b.place)
        .map((entry) => entry.stem);
}

/** One series of stems through the stem renderer, in one color. Each item names its row by the label column. */
function stemSeries(name: string, color: string, stems: readonly Stem[], label: string | undefined): EchartOption {
    return {
        type: "custom",
        name,
        renderItem: STEM_RENDERER,
        encode: { x: 0, y: 1 },
        itemStyle: { color },
        tooltip: { formatter: "{a}<br/>{b}" },
        data: byCount(stems).map((stem) => ({ name: label === undefined ? "" : String(stem.row[label] ?? ""), value: [stem.x, stem.y] })),
    };
}

/** The labels of the three largest counts: one point with no symbol at each head, and its text above it. */
function labelSeries(stems: readonly Stem[], label: string): EchartOption {
    return {
        type: "scatter",
        silent: true,
        symbolSize: 0,
        z: 10,
        label: { show: true, formatter: "{b}", position: "top", distance: 6, color: CHART_INK },
        labelLayout: { hideOverlap: true },
        data: byCount(stems)
            .slice(0, LABELED_COUNT)
            .map((stem) => ({ name: String(stem.row[label] ?? ""), value: [stem.x, stem.y] })),
    };
}

/**
 * The band of the track: one gray backbone over the whole protein, then one box for each domain in its lane.
 * The boxes of one name share one color. Each label takes the share of the axis that its box spans.
 */
function bandSeries(boxes: readonly DomainBox[], length: number, lanes: number): EchartOption {
    const names = firstAppearance(boxes.map((box) => box.name));
    const palette = categoricalPalette(names.length);
    const colorOf = new Map(names.map((name, place) => [name, palette[place % palette.length]]));
    const areas: EchartOption[][] = [
        [
            { xAxis: 0, yAxis: BACKBONE_MARGIN, itemStyle: { color: GUIDE_LINE_COLOR, opacity: BOX_OPACITY }, label: { show: false } },
            { xAxis: length, yAxis: lanes - BACKBONE_MARGIN },
        ],
    ];
    for (const box of boxes) {
        const text = boxLabel(box, length);
        areas.push([
            {
                name: box.name,
                xAxis: box.start,
                yAxis: box.lane + BOX_MARGIN,
                itemStyle: { color: colorOf.get(box.name), opacity: BOX_OPACITY, borderColor: colorOf.get(box.name), borderWidth: 1 },
                label: text === undefined ? { show: false } : { show: true, position: "inside", formatter: text, color: CHART_INK },
            },
            { xAxis: box.end, yAxis: box.lane + 1 - BOX_MARGIN },
        ]);
    }
    return {
        type: "line",
        xAxisIndex: 1,
        yAxisIndex: 1,
        silent: true,
        data: [],
        markArea: { silent: false, tooltip: { formatter: "{b}" }, data: areas },
    };
}

/** The label of one box: the whole name where it fits the box, a shortened name where some of it fits, else none. */
function boxLabel(box: DomainBox, length: number): string | undefined {
    const room = length > 0 ? Math.round(((box.end - box.start) / length) * LABEL_CHARS_ACROSS) : 0;
    if (box.name.length <= room) return box.name;
    if (room < LABEL_MIN_CHARS) return undefined;
    return `${box.name.slice(0, room - 1).trimEnd()}…`;
}
