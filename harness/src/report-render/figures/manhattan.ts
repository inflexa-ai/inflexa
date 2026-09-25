/**
 * The Manhattan figure, as qqman and the GWAS papers draw it: the cumulative genome position on x, the
 * transformed p on y, and one block of points for each chromosome.
 *
 * - The chromosomes alternate between two colors, thus each boundary reads without a tick.
 * - Each chromosome name sits under the middle of its points, and the position ticks hide.
 * - Two guide lines mark the genome-wide significance at 5e-8 and the suggestive level at 1e-5. The
 *   genome-wide line carries its label.
 * - The lead variant of each chromosome that passes the genome-wide line is the row with the smallest p of
 *   that chromosome, as the `annotateTop` rule of qqman gives it. The ten most significant lead variants
 *   show their names over their peaks, clear of each other and of the points, with a leader line to each
 *   peak. The label of the genome-wide line sits over the line, clear of them.
 * - A chromosome name prints where it keeps a gap from the name before it, thus the small chromosomes never
 *   print two names on top of each other.
 * - The lead names and the chromosome names place again for the plot and the text size of each export. A render
 *   tries the most significant lead names whose summed text width fits the plot width, and a name that finds no
 *   place clear of the earlier names does not print. Thus a narrow export prints fewer names.
 * - The chromosomes read in genome order whatever the order of the rows: the numbered ones, then X, Y, and MT,
 *   then each other name. The colors, the names, and the leads read that order.
 * - A variant whose stored p is 0 draws an upward triangle at the top of the plotted range, and it leads its
 *   chromosome.
 *
 * The `group` channel names the chromosome, and the figure needs it. The points come from the composition
 * machinery, thus a table of many thousand variants reads the shared payload. The lines ride the point series
 * as mark members, and the chromosome names and the lead names ride one series each after them. Thus the page
 * draws each of them over the payload points.
 */

import { err, ok, type Result } from "neverthrow";

import { channelColumn, type ChartBlock, type ChartComposition } from "../../contracts/report-blocks.js";
import { MANHATTAN_P_THRESHOLD } from "../chart-presets.js";
import type { Cell, ChartRow, EchartOption } from "../chart.js";
import { CHART_INK, CHART_PALETTE, MUTED_CHART_COLOR } from "../design.js";
import { formatNumberCell, typographicExponent } from "../number-format.js";
import type { RenderProblem } from "../types.js";
import { categoryName, transformColumn } from "./common.js";
import {
    axisOf,
    BELOW_RESOLUTION_NAME,
    BELOW_RESOLUTION_SYMBOL,
    BELOW_RESOLUTION_SYMBOL_PX,
    BELOW_RESOLUTION_TOOLTIP,
    belowResolutionHeight,
    belowResolutionRows,
    DENSE_NULL_SYMBOL_PX,
    DENSE_SIGNAL_OPACITY,
    demandedChannel,
    largest,
    niceCeiling,
    plottedValues,
    pointLayer,
    POINT_NAMES,
    pointNameSeries,
    seriesOf,
    sizedSeries,
} from "./dense.js";
import type { FigureContext, FigureMember, FigureModule } from "./index.js";
import { placeLeaderNames, textWidthPx, type Box, type NamedPoint, type NameFrame } from "./label-room.js";

/** The two colors that alternate between the chromosomes: the blue of the palette and the muted gray. */
export const MANHATTAN_COLORS = [CHART_PALETTE[0], MUTED_CHART_COLOR] as const;

/** The suggestive level of a GWAS, the second guide line of qqman. */
export const MANHATTAN_SUGGESTIVE_P = 1e-5;

/** The x title where the binding declares no label. The axis shows the chromosome names, not a position. */
const CHROMOSOME_TITLE = "Chromosome";

/** The y title of the transformed p. The minus sign is the character, not a hyphen. */
const NEG_LOG10_P_TITLE = "−log10(p)";

/** The members of a Manhattan block that the figure reads. */
const READS: ReadonlySet<FigureMember> = new Set(["x", "y", "group", "label"]);

/** The largest count of lead variants that show their name, over the whole genome. */
export const MANHATTAN_LABEL_COUNT = 10;

/**
 * The lead names that a render tries to place: the most significant ones, in order, while the summed width of
 * their text fits the width of the plot. A narrow export thus tries fewer names, and each of them keeps room
 * beside its peak.
 */
function leadsThatFit(names: readonly NamedPoint[], frame: NameFrame): NamedPoint[] {
    let used = 0;
    let count = 0;
    for (const name of names) {
        used += textWidthPx(name.text, frame.textPx);
        if (used > frame.widthPx) break;
        count += 1;
    }
    return names.slice(0, count);
}

/**
 * The smallest gap between two chromosome names that both print, as a share of the text size.
 *
 * The small chromosomes lie close together. The name of a chromosome whose text comes nearer than this gap to
 * the text of the last printed name, in the plot of a render, does not print in that render.
 */
export const MANHATTAN_NAME_GAP_SHARE = 0.5;

/**
 * The label place of the genome-wide guide: inside the plot at the right end, over the line.
 *
 * The band under the line is a few pixels high, and a label there runs into the axis and the chromosome names.
 * The box of the label over the line is reserved when the lead names place, thus no name covers it.
 */
const GUIDE_OVER_LINE = "insideEndTop";

/** The gap between a guide line and its label, in pixels: the default distance of the chart runtime. */
const GUIDE_LABEL_DISTANCE_PX = 5;

/** The height of one line of the label text, as a share of the text size. */
const GUIDE_LINE_SHARE = 1.3;

/**
 * The box in data units that the label of the genome-wide line takes at the right end of the line, over it, in
 * the plot of one render.
 */
export function guideLabelBox(line: number, x: { readonly min: number; readonly max: number }, top: number, text: string, frame: NameFrame): Box {
    const width = (textWidthPx(text, frame.textPx) + GUIDE_LABEL_DISTANCE_PX) / frame.widthPx;
    const height = (GUIDE_LINE_SHARE * frame.textPx + GUIDE_LABEL_DISTANCE_PX) / frame.heightPx;
    return { left: x.max - width * (x.max - x.min), right: x.max, bottom: line, top: line + height * top };
}

/** The name of the series that carries the chromosome names. */
const CHROMOSOME_NAMES = "Chromosome names";

/**
 * The chromosomes whose name prints in the plot of one render, in order. A name prints where its text starts at
 * least `MANHATTAN_NAME_GAP_SHARE` of the text size past the end of the text of the last printed name. Each text
 * centers under the middle of its chromosome. The first chromosome always prints.
 */
function printedNames(found: readonly Chromosome[], x: { readonly min: number; readonly max: number }, frame: NameFrame): Chromosome[] {
    const toPx = (value: number): number => ((value - x.min) / (x.max - x.min)) * frame.widthPx;
    const gap = MANHATTAN_NAME_GAP_SHARE * frame.textPx;
    const printed: Chromosome[] = [];
    let lastEnd: number | undefined;
    for (const chromosome of found) {
        const middle = toPx((chromosome.low + chromosome.high) / 2);
        const half = textWidthPx(categoryName(chromosome.name), frame.textPx) / 2;
        if (lastEnd === undefined || middle - half - lastEnd >= gap) {
            printed.push(chromosome);
            lastEnd = middle + half;
        }
    }
    return printed;
}

/**
 * The series of the chromosome names: one point with no symbol under the middle of each printed chromosome,
 * at the x axis, with the name as its label.
 *
 * The gap rule decides which names print in each render, thus two names never print on top of each other. The
 * runtime also measures the labels and hides a name that overlaps another, for a page narrower than its frame.
 * The series follows the points in the series list, thus the points still read the shared payload.
 */
function chromosomeNames(found: readonly Chromosome[]): EchartOption {
    return {
        type: "scatter",
        name: CHROMOSOME_NAMES,
        silent: true,
        symbolSize: 0,
        tooltip: { show: false },
        label: { show: true, position: "bottom", distance: 6, color: CHART_INK, formatter: "{b}" },
        labelLayout: { hideOverlap: true },
        data: found.map((chromosome) => ({ name: categoryName(chromosome.name), value: [(chromosome.low + chromosome.high) / 2, 0] })),
    };
}

/** The sides of a peak where a lead name sits, in the order that the figure tries them. */
const LEAD_NAME_SIDES = ["top", "right", "left"] as const;

/** One chromosome of the table: its key, the extent of its drawn positions, and its lead row. */
interface Chromosome {
    readonly name: Cell;
    low: number;
    high: number;
    lead?: number;
}

/** The place of the three named chromosomes after the numbered ones, in genome order. */
const NAMED_CHROMOSOMES: Readonly<Record<string, number>> = { X: 0, Y: 1, MT: 2, M: 2 };

/** The text prefix of a chromosome name that some tables carry, for example `chr1`. */
const CHROMOSOME_PREFIX = /^chr/i;

/**
 * The genome order of two chromosome names: the numbered chromosomes in numeric order, then X, Y, and MT, then
 * each other name in text order. A `chr` prefix takes no part in the order.
 */
export function compareChromosomes(a: Cell, b: Cell): number {
    const rank = (cell: Cell): [number, number, string] => {
        const name = String(cell).trim().replace(CHROMOSOME_PREFIX, "");
        if (/^\d+$/.test(name)) return [0, Number(name), name];
        const named = NAMED_CHROMOSOMES[name.toUpperCase()];
        return named !== undefined ? [1, named, name] : [2, 0, name];
    };
    const [left, right] = [rank(a), rank(b)];
    if (left[0] !== right[0]) return left[0] - right[0];
    if (left[1] !== right[1]) return left[1] - right[1];
    return left[2] < right[2] ? -1 : left[2] > right[2] ? 1 : 0;
}

/**
 * The chromosomes of the table in genome order, whatever the order of the rows.
 *
 * The extent reads each row that draws a point. The lead is the row with the largest transformed p above the
 * genome-wide line whose name is not empty. A tie keeps the row at the smaller position, then the first row.
 */
function chromosomes(
    rows: readonly ChartRow[],
    groupColumn: string,
    labelColumn: string | undefined,
    xs: readonly (number | null)[],
    ys: readonly (number | null)[],
    line: number,
): Chromosome[] {
    const byKey = new Map<string, Chromosome>();
    const order: Chromosome[] = [];
    for (let index = 0; index < rows.length; index += 1) {
        const value = rows[index][groupColumn];
        const x = xs[index];
        const y = ys[index];
        if (value === undefined || x === null || y === null) continue;
        // The key carries the type of the cell, as the series split does.
        const key = `${typeof value}:${String(value)}`;
        let chromosome = byKey.get(key);
        if (chromosome === undefined) {
            chromosome = { name: value, low: x, high: x };
            byKey.set(key, chromosome);
            order.push(chromosome);
        }
        chromosome.low = Math.min(chromosome.low, x);
        chromosome.high = Math.max(chromosome.high, x);
        const name = labelColumn === undefined ? undefined : rows[index][labelColumn];
        if (y > line && name !== undefined && String(name).trim() !== "" && (chromosome.lead === undefined || leads(index, chromosome.lead, xs, ys))) {
            chromosome.lead = index;
        }
    }
    return order.sort((a, b) => compareChromosomes(a.name, b.name));
}

/** True when one row leads before another: a larger transformed p, then a smaller position, then the earlier row. */
function leads(index: number, other: number, xs: readonly (number | null)[], ys: readonly (number | null)[]): boolean {
    const byP = (ys[index] ?? 0) - (ys[other] ?? 0);
    if (byP !== 0) return byP > 0;
    const byPosition = (xs[other] ?? 0) - (xs[index] ?? 0);
    return byPosition !== 0 ? byPosition > 0 : index < other;
}

/** The guide lines of a mark member, with the label of the genome-wide line over the line. */
function guideOverLine(markLine: EchartOption, line: number): EchartOption {
    const data = Array.isArray(markLine.data) ? (markLine.data as EchartOption[]) : [];
    return {
        ...markLine,
        data: data.map((entry) =>
            entry.yAxis === line && typeof entry.label === "object" && entry.label !== null
                ? { ...entry, label: { ...(entry.label as EchartOption), position: GUIDE_OVER_LINE } }
                : entry,
        ),
    };
}

/** The text of a guide p-value: the p in the scientific form of the number helper, as a power of ten. */
function guideText(p: number): string {
    return `p ${typographicExponent(formatNumberCell(p, "scientific").text)}`;
}

function deriveManhattan(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<EchartOption, RenderProblem> {
    const encoding = block.encoding ?? {};
    const x = demandedChannel(context.blockId, "manhattan", encoding, "x");
    if (x.isErr()) return err(x.error);
    const y = demandedChannel(context.blockId, "manhattan", encoding, "y");
    if (y.isErr()) return err(y.error);
    const group = demandedChannel(context.blockId, "manhattan", encoding, "group");
    if (group.isErr()) return err(group.error);

    const pColumn = channelColumn(y.value);
    const line = -Math.log10(MANHATTAN_P_THRESHOLD);
    const suggestive = -Math.log10(MANHATTAN_SUGGESTIVE_P);
    const xs = plottedValues(rows, x.value);
    const finite = transformColumn(rows, pColumn, "neg_log10");
    const peak = largest(finite.flatMap((value, index) => (value !== null && xs[index] !== null ? [value] : []))) ?? 0;
    const zeroRows = belowResolutionRows(rows, pColumn, xs);
    const zeros = new Set(zeroRows);
    const zeroY = belowResolutionHeight(peak, line);
    // A stored zero draws at the top of the plotted range, and it outranks each finite p as a lead.
    const ys = finite.map((value, index) => (zeros.has(index) ? zeroY : value));
    const ranks = finite.map((value, index) => (zeros.has(index) ? Number.POSITIVE_INFINITY : value));
    const groupColumn = channelColumn(group.value);
    const found = chromosomes(rows, groupColumn, encoding.label, xs, ranks, line);
    const composition: ChartComposition = {
        series: [
            {
                form: "scatter",
                encoding: {
                    x: x.value,
                    y: { column: pColumn, transform: "neg_log10" },
                    group: group.value,
                    ...(encoding.label !== undefined ? { label: encoding.label } : {}),
                },
            },
        ],
        annotations: [
            { kind: "reference-line", axis: "y", value: line, label: guideText(MANHATTAN_P_THRESHOLD) },
            // The two lines lie a few pixels apart, thus a second label would cover the first one.
            { kind: "reference-line", axis: "y", value: suggestive },
        ],
    };
    // The most significant lead variants show their names, one for each chromosome at most.
    const leadRows = found
        .flatMap((chromosome) => (chromosome.lead !== undefined ? [chromosome.lead] : []))
        .sort((a, b) => (leads(a, b, xs, ranks) ? -1 : 1))
        .slice(0, MANHATTAN_LABEL_COUNT);
    const composed = context.compose(composition, { preset: { x: CHROMOSOME_TITLE, y: NEG_LOG10_P_TITLE } });
    if (composed.isErr()) return err(composed.error);

    const option = composed.value;
    // The composition splits the series in the order of the rows, thus each series takes the color of the
    // genome place of its chromosome, and never of its place in the series list.
    const places = new Map(found.map((chromosome, place) => [categoryName(chromosome.name), place]));
    const colorOf = (name: unknown): string => MANHATTAN_COLORS[(places.get(String(name)) ?? 0) % MANHATTAN_COLORS.length];
    const low = found.length > 0 ? Math.min(...found.map((chromosome) => chromosome.low)) : undefined;
    const high = found.length > 0 ? Math.max(...found.map((chromosome) => chromosome.high)) : undefined;
    const top = niceCeiling(Math.max(peak, line, zeroRows.length > 0 ? zeroY : 0));
    const labelColumn = encoding.label;
    const names = labelColumn === undefined ? [] : leadRows.map((index) => ({ x: xs[index] ?? 0, y: ys[index] ?? 0, text: String(rows[index][labelColumn]) }));
    const span = low !== undefined && high !== undefined ? { min: low, max: high } : undefined;
    const text = sizedSeries([CHROMOSOME_NAMES, POINT_NAMES], (frame) => {
        if (span === undefined) return [];
        const tried = leadsThatFit(names, frame);
        const placed = placeLeaderNames(tried, { xs, ys, pointPx: DENSE_NULL_SYMBOL_PX }, { x: span, y: { min: 0, max: top } }, LEAD_NAME_SIDES, top, frame, [
            guideLabelBox(line, span, top, guideText(MANHATTAN_P_THRESHOLD), frame),
        ]);
        return [chromosomeNames(printedNames(found, span, frame)), ...pointNameSeries(tried, placed)];
    });
    return ok({
        ...option,
        ...text.member,
        legend: { show: false },
        xAxis: {
            ...axisOf(option, "xAxis"),
            ...(low !== undefined && high !== undefined ? { min: low, max: high } : {}),
            axisLabel: { show: false },
            axisTick: { show: false },
        },
        yAxis: { ...axisOf(option, "yAxis"), min: 0, max: top },
        series: [
            ...seriesOf(option).map((series) => ({
                ...series,
                ...pointLayer(colorOf(series.name), DENSE_NULL_SYMBOL_PX, DENSE_SIGNAL_OPACITY),
                ...(series.markLine !== undefined ? { markLine: guideOverLine(series.markLine as EchartOption, line) } : {}),
            })),
            ...(zeroRows.length > 0
                ? [
                      {
                          type: "scatter",
                          name: BELOW_RESOLUTION_NAME,
                          symbol: BELOW_RESOLUTION_SYMBOL,
                          symbolSize: BELOW_RESOLUTION_SYMBOL_PX,
                          itemStyle: { opacity: DENSE_SIGNAL_OPACITY },
                          tooltip: BELOW_RESOLUTION_TOOLTIP,
                          data: zeroRows.map((index) => ({
                              ...(labelColumn !== undefined ? { name: String(rows[index][labelColumn]) } : {}),
                              value: [xs[index] ?? 0, zeroY],
                              itemStyle: { color: colorOf(categoryName(rows[index][groupColumn])) },
                          })),
                      },
                  ]
                : []),
            ...text.page,
        ],
    });
}

/** The Manhattan figure module. */
export const MANHATTAN_FIGURE: FigureModule = { reads: READS, derive: deriveManhattan };
