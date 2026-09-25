/**
 * The regional association plot, as LocusZoom draws it (Pruim et al. 2010): the variants of one region of one
 * chromosome, with the position on x and the transformed p on y.
 *
 * - Each point takes the LocusZoom bin of its r² with the lead variant, and a point of no r² draws gray under
 *   the others. One legend over the plot states the bins and the gray.
 * - The lead variant is the row with the largest transformed p. It draws as a purple diamond with its name on
 *   top. A tie keeps the row at the smaller position, then the first row.
 * - The recombination rate draws as a blue line on a right axis in cM/Mb, from the rows in position order.
 * - A guide line marks the genome-wide significance at 5 × 10⁻⁸. Its name sits over the line at the first free
 *   spot from the left end, where no variant and no stretch of the recombination line meets the name.
 * - The x axis reads in megabases, with round ticks, and it ends at the first and the last position of the rows.
 * - The genes of the track draw under the plot, each one as a line with its name under it. The lane of a gene
 *   is the first lane where its line and its name overlap no gene before it, in the order of the gene starts.
 * - A variant whose stored p is 0 draws an upward triangle at the top of the plotted range, and it leads.
 *
 * The points and the recombination line come from the composition machinery, thus a window of many thousand
 * variants reads the shared payload. The r² rides the points as a continuous color, and a piecewise map bins
 * it. The composition drops a row whose color is not numeric, thus the points of no r² draw in a series of
 * their own after the composition, with their rows inline. The tick names, the lead, and the genes follow them.
 *
 * The chart runtime takes no function in the option, thus the axis cannot print a position divided by 10⁶.
 * The axis hides its own ticks and labels, and a series of named points draws each tick in megabases, as the
 * Manhattan figure prints its chromosome names.
 */

import { err, ok, type Result } from "neverthrow";

import { channelColumn, channelOrder, channelTransform, type ChartBlock, type ChartComposition } from "../../contracts/report-blocks.js";
import { declaredForColumn } from "../../contracts/report-reference.js";
import { MANHATTAN_P_THRESHOLD } from "../chart-presets.js";
import type { ChartRow, EchartOption } from "../chart.js";
import { CHART_BODY_MAX_PX, CHART_BODY_PX, CHART_EXPORT_SIZES, CHART_INK, exportSizeFor } from "../design.js";
import { formatNumberCell, typographicExponent } from "../number-format.js";
import type { RenderProblem } from "../types.js";
import { categoryName, chartProblem, columnPresent, firstFreeLanes, toNumber, transformColumn, valueAxis, valueAxisTitle, withFigureBody } from "./common.js";
import {
    axisOf,
    BELOW_RESOLUTION_SYMBOL,
    BELOW_RESOLUTION_SYMBOL_PX,
    BELOW_RESOLUTION_TOOLTIP,
    belowResolutionHeight,
    belowResolutionRows,
    DENSE_NULL_Z,
    demandedChannel,
    largest,
    niceCeiling,
    seriesOf,
} from "./dense.js";
import type { FigureContext, FigureMember, FigureModule, FigureTrack } from "./index.js";
import { COLUMN_PLOT_FRAME, textWidthPx } from "./label-room.js";

/** One LD bin: the r² range, lower end included, and its color. The highest bin includes 1. */
export interface LdBin {
    readonly low: number;
    readonly high: number;
    readonly color: string;
}

/** The five r² bins of LocusZoom, in ascending order, with its colors: navy, sky blue, green, orange, and red. */
export const LD_BINS: readonly LdBin[] = [
    { low: 0, high: 0.2, color: "#000080" },
    { low: 0.2, high: 0.4, color: "#87cefa" },
    { low: 0.4, high: 0.6, color: "#00a000" },
    { low: 0.6, high: 0.8, color: "#ffa500" },
    { low: 0.8, high: 1, color: "#ff0000" },
];

/** The gray of a variant with no r², and the name of its series and its legend entry. */
export const LD_MISSING_COLOR = "#8c8c8c";
export const LD_MISSING_NAME = "No r²";

/** The purple of the lead variant, as LocusZoom draws it, and the name of its series. */
export const LEAD_VARIANT_COLOR = "#9632b8";
export const LEAD_VARIANT_NAME = "Lead variant";

/** The blue of the recombination line, and the name of its series. */
export const RECOMBINATION_COLOR = "#1f4fd8";
export const RECOMBINATION_NAME = "Recombination rate";

/** The name of the series that prints the tick names in megabases, and of the series of the genes. */
export const POSITION_TICKS = "Position ticks";
export const GENE_NAMES = "Genes";

/** The name of the series that prints the name of the genome-wide line. */
export const GUIDE_LABEL = "Genome-wide line";

/** The title of the legend, of the p axis, and of the recombination axis where its column declares no label. */
const LEGEND_TITLE = "r²";
const NEG_LOG10_P_TITLE = "−log10(p)";
const RECOMBINATION_TITLE = "Recombination rate (cM/Mb)";

/** The members of a locuszoom block that the figure reads. */
const READS: ReadonlySet<FigureMember> = new Set(["x", "y", "color", "label", "metric", "group", "track"]);

/** The size in pixels of a variant point, of the lead diamond, and the width of the point outline. */
const POINT_PX = 6;
const LEAD_PX = 12;
const POINT_OUTLINE_PX = 0.4;

/** The width of the recombination line in pixels, and its opacity. The points read over it. */
const RECOMBINATION_WIDTH_PX = 1;
const RECOMBINATION_OPACITY = 0.7;

/**
 * The name of the genome-wide line: its gap over the line, its gap from the left end and from each variant or
 * stretch of the recombination line that it clears, and the halo of the page color around its letters, in
 * pixels. The height of its line of text is a share of the text size.
 */
const GUIDE_GAP_PX = 2;
const GUIDE_INSET_PX = 4;
const GUIDE_HALO_PX = 2;
const GUIDE_HALO_COLOR = "#ffffff";
const GUIDE_LINE_SHARE = 1.25;

/** The width of a gene line in pixels. */
const GENE_WIDTH_PX = 2;

/** The icon size in pixels of the legend, and the gaps between its items and between an icon and its text. */
const LEGEND_ICON_PX = 8;
const LEGEND_ITEM_GAP_PX = 6;
const LEGEND_TEXT_GAP_PX = 3;

/** The width and the length in pixels of a tick mark of the position axis. */
const TICK_WIDTH_PX = 1;
const TICK_LENGTH_PX = 5;

/** The count of base pairs in one megabase. */
const BASES_PER_MB = 1_000_000;

/** The most tick steps that the position axis draws. Six names of four digits fit the single journal column. */
const POSITION_TICK_COUNT = 5;

/** The round tick steps of the position axis, in base pairs, in ascending order. */
const POSITION_STEPS = [1, 2, 2.5, 5].flatMap((coefficient) => [1e3, 1e4, 1e5, 1e6, 1e7].map((power) => coefficient * power)).sort((a, b) => a - b);

/**
 * The layout of the plot and of the gene band, in percent of the default chart body.
 *
 * The axis band under the plot holds the tick names and the title of the position axis. Each lane of genes
 * takes one band of the height of a line and a name. A band of more lanes than the body holds grows the body.
 */
const PLOT_TOP = 12;
const PLOT_LEFT = 10;
const PLOT_RIGHT = 5;
const PLOT_RIGHT_WITH_RATE = 10;
const AXIS_BAND = 17;
const GENE_LANE = 6;
const TRACK_BOTTOM = 3;
const LANES_IN_BODY = 3;

/** The place of a gene line inside its lane, in lanes from the top of the lane. The name sits under the line. */
const GENE_LINE_PLACE = 0.25;

/**
 * The width of one character of a gene name, as a share of the text size, and the gap in characters between two
 * genes of one lane. A name reads at the single journal column, thus its width reads that frame.
 */
const GENE_CHARACTER_SHARE = 0.6;
const GENE_GAP_CHARACTERS = 1;

/** The trailing unit of a declared position label, which the megabase axis replaces. */
const POSITION_UNIT = /\s*\((bp|base pairs|kb|Mb)\)\s*$/i;

/** The columns of one locuszoom block. */
interface LocusColumns {
    readonly position: string;
    readonly p: string;
    readonly r2: string;
    readonly label?: string;
    readonly rate?: string;
    readonly chromosome?: string;
}

/** One gene of the window: its clipped span, its name, the center of its name, and its lane. */
interface Gene {
    readonly start: number;
    readonly end: number;
    readonly name: string;
    readonly center: number;
    readonly lane: number;
}

function deriveLocusZoom(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<EchartOption, RenderProblem> {
    const columns = locusColumns(block, rows, context);
    if (columns.isErr()) return err(columns.error);
    const { position, p, r2, label, rate, chromosome } = columns.value;
    const xs = rows.map((row) => toNumber(row[position]));
    const faulty = xs.findIndex((x) => x === null);
    if (faulty >= 0) {
        return err(
            chartProblem(
                context.blockId,
                `The locuszoom reads the "${position}" column as a position in base pairs, and row ${faulty + 1} holds "${String(rows[faulty][position] ?? "")}", which is not a number.`,
            ),
        );
    }
    const chromosomes = chromosome === undefined ? [] : distinctNames(rows, chromosome);
    if (chromosomes.length > 1) {
        return err(
            chartProblem(
                context.blockId,
                `The locuszoom draws one region of one chromosome, and the "${chromosome}" column holds "${chromosomes[0]}" and "${chromosomes[1]}".`,
            ),
        );
    }
    const r2s = rows.map((row) => toNumber(row[r2]));
    const outside = r2s.findIndex((value) => value !== null && (value < 0 || value > 1));
    if (outside >= 0) {
        return err(
            chartProblem(
                context.blockId,
                `The locuszoom reads the "${r2}" column as the r² with the lead variant, and row ${outside + 1} holds ${r2s[outside]}, which is outside 0 to 1.`,
            ),
        );
    }

    const line = -Math.log10(MANHATTAN_P_THRESHOLD);
    const finite = transformColumn(rows, p, "neg_log10");
    const peak = largest(finite.flatMap((value) => (value !== null ? [value] : [])));
    const zeroRows = belowResolutionRows(rows, p, xs);
    const zeros = new Set(zeroRows);
    const zeroY = belowResolutionHeight(peak, line);
    const ys = finite.map((value, index) => (zeros.has(index) ? zeroY : value));
    const lead = leadRow(xs, finite, zeros);
    const top = niceCeiling(Math.max(peak ?? 0, line, zeroRows.length > 0 ? zeroY : 0));
    const window = positionWindow(xs);
    const genes = context.track === undefined ? ok(undefined) : windowGenes(context.blockId, context.track, window);
    if (genes.isErr()) return err(genes.error);
    const lanes = genes.value === undefined ? 0 : Math.max(1, (largest(genes.value.map((gene) => gene.lane)) ?? 0) + 1);

    const composition: ChartComposition = {
        series: [
            { form: "scatter", encoding: { x: position, y: { column: p, transform: "neg_log10" }, color: r2, ...(label !== undefined ? { label } : {}) } },
            ...(rate !== undefined ? [{ form: "line" as const, name: RECOMBINATION_NAME, encoding: { x: position, y: rate } }] : []),
        ],
        annotations: [{ kind: "reference-line", axis: "y", value: line }],
    };
    const xTitle = positionTitle(context, position, chromosomes[0]);
    const composed = context.compose(composition, { preset: { x: xTitle, y: NEG_LOG10_P_TITLE }, colorOnTop: true });
    if (composed.isErr()) return err(composed.error);
    const option = composed.value;
    const [points, recombination] = seriesOf(option);

    const nameOf = (index: number): string | undefined => {
        const cell = label === undefined ? undefined : rows[index][label];
        return cell === undefined || cell === null || String(cell).trim() === "" ? undefined : String(cell);
    };
    const item = (index: number, y: number): EchartOption => {
        const name = nameOf(index);
        return { ...(name !== undefined ? { name } : {}), value: [xs[index] ?? 0, y] };
    };
    const missing: EchartOption[] = [];
    for (let index = 0; index < rows.length; index += 1) {
        const y = finite[index];
        if (r2s[index] === null && y !== null) missing.push(item(index, y));
    }
    const rated = rate === undefined ? [] : ratesInOrder(rows, xs, rate);
    const rateTop = niceCeiling(largest(rated.map(([, value]) => value)) ?? 0);

    const layout = bandLayout(lanes, rate !== undefined);
    const plotAxis = {
        ...axisOf(option, "xAxis"),
        ...valueAxis("x", xTitle, { min: window.min, max: window.max }),
        axisLabel: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
    };
    const pAxis = { ...axisOf(option, "yAxis"), ...valueAxis("y", NEG_LOG10_P_TITLE, { min: 0, max: top }) };
    const rateAxis =
        rate === undefined
            ? []
            : [
                  {
                      ...valueAxis("y", valueAxisTitle(context.labels, rate, RECOMBINATION_TITLE), { min: 0, max: rateTop }),
                      position: "right",
                      nameRotate: -90,
                      splitLine: { show: false },
                  },
              ];
    const series: EchartOption[] = [
        { ...points, symbolSize: POINT_PX, itemStyle: { borderColor: CHART_INK, borderWidth: POINT_OUTLINE_PX } },
        ...(recombination !== undefined
            ? [
                  {
                      ...recombination,
                      yAxisIndex: 1,
                      showSymbol: false,
                      silent: true,
                      z: DENSE_NULL_Z,
                      lineStyle: { color: RECOMBINATION_COLOR, width: RECOMBINATION_WIDTH_PX, opacity: RECOMBINATION_OPACITY },
                      itemStyle: { color: RECOMBINATION_COLOR },
                  },
              ]
            : []),
        ...(missing.length > 0 ? [missingSeries(missing)] : []),
        ...(zeroRows.length > 0 ? [zeroSeries(zeroRows.map((index) => ({ ...item(index, zeroY), itemStyle: { color: binColor(r2s[index]) } })))] : []),
        tickSeries(window),
        guideSeries(guideText(MANHATTAN_P_THRESHOLD), line, { ys, xs, rated, top, rateTop, window, layout }),
        ...(lead !== undefined ? [leadSeries(item(lead, ys[lead] ?? 0))] : []),
        ...(genes.value !== undefined ? [geneSeries(genes.value, rate !== undefined ? 2 : 1)] : []),
    ];
    const plotGrid = { top: pct(layout.top), bottom: pct(layout.plotBottom), left: pct(PLOT_LEFT), right: pct(layout.right) };
    const geneGrid = { bottom: pct(layout.trackBottom), height: pct(layout.band), left: pct(PLOT_LEFT), right: pct(layout.right) };
    const derived: EchartOption = {
        ...option,
        legend: { show: false },
        visualMap: [ldLegend()],
        grid: genes.value === undefined ? plotGrid : [plotGrid, geneGrid],
        xAxis: genes.value === undefined ? plotAxis : [plotAxis, { type: "value", gridIndex: 1, min: window.min, max: window.max, show: false }],
        yAxis: [pAxis, ...rateAxis, ...(genes.value === undefined ? [] : [{ type: "value", gridIndex: 1, min: 0, max: lanes, inverse: true, show: false }])],
        series,
    };
    return ok(layout.bodyPx > CHART_BODY_PX ? withFigureBody(derived, layout.bodyPx) : derived);
}

/** The columns of the channels. An absent position, p, or r², a transform on one of them, and an absent column each refuse. */
function locusColumns(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<LocusColumns, RenderProblem> {
    const encoding = block.encoding ?? {};
    const x = demandedChannel(context.blockId, "locuszoom", encoding, "x");
    if (x.isErr()) return err(x.error);
    const y = demandedChannel(context.blockId, "locuszoom", encoding, "y");
    if (y.isErr()) return err(y.error);
    if (encoding.color === undefined) {
        return err(chartProblem(context.blockId, 'The locuszoom chart needs a column for the "color" channel: the r² of each variant with the lead variant.'));
    }
    const plain = { x: x.value, color: encoding.color, metric: encoding.metric, group: encoding.group };
    for (const [name, channel] of Object.entries(plain)) {
        if (channel !== undefined && (channelTransform(channel) !== undefined || channelOrder(channel) !== undefined)) {
            return err(
                chartProblem(context.blockId, `The locuszoom reads the "${name}" column as it stands, thus the channel takes no transform and no "orderBy".`),
            );
        }
    }
    const found: LocusColumns = {
        position: channelColumn(x.value),
        // The figure applies the transform of the p column itself, as the Manhattan figure does.
        p: channelColumn(y.value),
        r2: channelColumn(encoding.color),
        ...(encoding.label !== undefined ? { label: encoding.label } : {}),
        ...(encoding.metric !== undefined ? { rate: channelColumn(encoding.metric) } : {}),
        ...(encoding.group !== undefined ? { chromosome: channelColumn(encoding.group) } : {}),
    };
    for (const column of Object.values(found)) {
        if (rows.length > 0 && !columnPresent(column, rows, context.columns)) {
            return err(chartProblem(context.blockId, `The column "${column}" is absent from every row.`));
        }
    }
    return ok(found);
}

/** The distinct names of one column, in the order of the rows. An empty cell names nothing. */
function distinctNames(rows: readonly ChartRow[], column: string): string[] {
    const names: string[] = [];
    for (const row of rows) {
        const cell = row[column];
        if (cell === undefined || cell === null || String(cell).trim() === "") continue;
        const name = categoryName(cell);
        if (!names.includes(name)) names.push(name);
        if (names.length > 1) break;
    }
    return names;
}

/**
 * The lead row: the largest transformed p, a stored zero before each finite p. A tie keeps the row at the
 * smaller position, then the first row. A table with no p gives no lead.
 */
function leadRow(xs: readonly (number | null)[], finite: readonly (number | null)[], zeros: ReadonlySet<number>): number | undefined {
    let lead: number | undefined;
    let best = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < finite.length; index += 1) {
        const rank = zeros.has(index) ? Number.POSITIVE_INFINITY : finite[index];
        if (rank === null) continue;
        if (lead === undefined || rank > best || (rank === best && (xs[index] ?? 0) < (xs[lead] ?? 0))) {
            lead = index;
            best = rank;
        }
    }
    return lead;
}

/** The text of a guide p-value: the p in the scientific form of the number helper, as a power of ten. */
function guideText(value: number): string {
    return `p ${typographicExponent(formatNumberCell(value, "scientific").text)}`;
}

/** The pairs of the position and the recombination rate of each row with both, in position order. */
function ratesInOrder(rows: readonly ChartRow[], xs: readonly (number | null)[], rate: string): Array<[number, number]> {
    const pairs: Array<[number, number]> = [];
    for (const [index, row] of rows.entries()) {
        const x = xs[index];
        const value = toNumber(row[rate]);
        if (x !== null && value !== null) pairs.push([x, value]);
    }
    return pairs.sort((a, b) => a[0] - b[0]);
}

/** The marks that the name of the genome-wide line keeps clear of, and the frame of the plot. */
interface GuideRoom {
    readonly xs: readonly (number | null)[];
    readonly ys: readonly (number | null)[];
    readonly rated: ReadonlyArray<readonly [number, number]>;
    readonly top: number;
    readonly rateTop: number;
    readonly window: PositionWindow;
    readonly layout: BandLayout;
}

/**
 * The position where the name of the genome-wide line starts: the first spot from the left end where the box
 * of the name, over the line, holds no variant and no stretch of the recombination line. The right end sits at
 * the recombination axis, thus the search starts at the left. A plot with no free spot takes the first spot
 * where the fewest of those marks meet the box, and the halo keeps the name legible over them.
 *
 * The box reads the single-column export. There the name takes the largest share of the width and of the
 * height of the plot, thus a spot that is free there is free at each size.
 */
function guideStart(text: string, line: number, room: GuideRoom): number {
    const { window, layout } = room;
    const frame = exportSizeFor(CHART_EXPORT_SIZES.single, layout.bodyPx);
    const plotWidthPx = (frame.widthPx * (100 - PLOT_LEFT - layout.right)) / 100;
    const plotHeightPx = (frame.heightPx * (100 - layout.top - layout.plotBottom)) / 100;
    const xPerPx = (window.max - window.min) / plotWidthPx;
    const yPerPx = room.top / plotHeightPx;
    const width = (textWidthPx(text, frame.textPx) + 2 * GUIDE_HALO_PX) * xPerPx;
    const inset = GUIDE_INSET_PX * xPerPx;
    const low = line;
    const high = line + (GUIDE_GAP_PX + frame.textPx * GUIDE_LINE_SHARE) * yPerPx;
    const reach = (POINT_PX / 2) * yPerPx;
    const half = (POINT_PX / 2) * xPerPx;

    const blocked: Array<[number, number]> = [];
    for (const [index, x] of room.xs.entries()) {
        const y = room.ys[index];
        if (x !== null && y !== null && y + reach >= low && y - reach <= high) blocked.push([x - half, x + half]);
    }
    if (room.rateTop > 0) {
        const rateLow = (low / room.top) * room.rateTop;
        const rateHigh = (high / room.top) * room.rateTop;
        for (let index = 1; index < room.rated.length; index += 1) {
            const [x1, r1] = room.rated[index - 1];
            const [x2, r2] = room.rated[index];
            if (Math.max(r1, r2) >= rateLow && Math.min(r1, r2) <= rateHigh) blocked.push([x1, x2]);
        }
    }
    const marks = union(blocked);
    const covered = coverage(marks);
    // A spot starts at the left end or past the end of a mark, because a start inside a free stretch covers no
    // less than the start of that stretch.
    let best = window.min + inset;
    let least = covered(best, best + width + inset);
    for (const [, end] of marks) {
        const from = end + inset;
        if (from + width > window.max - inset || least === 0) break;
        const share = covered(from, from + width + inset);
        if (share < least) {
            best = from;
            least = share;
        }
    }
    return best;
}

/** The union of some intervals, as disjoint intervals in ascending order. */
function union(intervals: Array<[number, number]>): Array<[number, number]> {
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const [start, end] of sorted) {
        const last = merged[merged.length - 1];
        if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
        else merged.push([start, end]);
    }
    return merged;
}

/** The length that some disjoint intervals in ascending order cover inside a span, read with two binary searches. */
function coverage(marks: ReadonlyArray<readonly [number, number]>): (from: number, to: number) => number {
    const before = [0];
    for (const [start, end] of marks) before.push(before[before.length - 1] + end - start);
    const firstEndingAfter = (x: number): number => {
        let low = 0;
        let high = marks.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (marks[middle][1] > x) high = middle;
            else low = middle + 1;
        }
        return low;
    };
    return (from, to) => {
        const first = firstEndingAfter(from);
        let last = firstEndingAfter(to);
        if (last < marks.length && marks[last][0] < to) last += 1;
        if (first >= last) return 0;
        return before[last] - before[first] - Math.max(0, from - marks[first][0]) - Math.max(0, marks[last - 1][1] - to);
    };
}

/**
 * The series of the name of the genome-wide line: one point with no symbol on the line, whose label starts at
 * the point and sits over the line. The halo of the page color keeps each letter clear of a mark under it.
 */
function guideSeries(text: string, line: number, room: GuideRoom): EchartOption {
    return {
        type: "scatter",
        name: GUIDE_LABEL,
        silent: true,
        symbolSize: 0,
        z: 10,
        tooltip: { show: false },
        label: {
            show: true,
            formatter: "{b}",
            position: [0, -GUIDE_GAP_PX],
            align: "left",
            verticalAlign: "bottom",
            color: CHART_INK,
            textBorderColor: GUIDE_HALO_COLOR,
            textBorderWidth: GUIDE_HALO_PX,
        },
        data: [{ name: text, value: [guideStart(text, line, room), line] }],
    };
}

/** The window of the position axis: the ends of the rows, and the round tick step. */
interface PositionWindow {
    readonly min: number;
    readonly max: number;
    readonly step: number;
}

/**
 * The window of the positions: the smallest and the largest position, and the smallest round step that draws
 * at most `POSITION_TICK_COUNT` steps across them. The axis ends at the rows, as the window of the run states
 * the region, and the ticks sit at the multiples of the step inside it.
 */
function positionWindow(xs: readonly (number | null)[]): PositionWindow {
    let low: number | undefined;
    let high: number | undefined;
    for (const x of xs) {
        if (x === null) continue;
        low = low === undefined ? x : Math.min(low, x);
        high = high === undefined ? x : Math.max(high, x);
    }
    const from = low ?? 0;
    const to = high ?? 0;
    const span = Math.max(to - from, POSITION_STEPS[0]);
    const step = POSITION_STEPS.find((candidate) => span / candidate <= POSITION_TICK_COUNT) ?? POSITION_STEPS[POSITION_STEPS.length - 1];
    return { min: from, max: Math.max(to, from + 1), step };
}

/**
 * The title of the position axis in megabases: the declared label of the position column with its unit
 * replaced, else the chromosome of the rows, else the bare position.
 */
function positionTitle(context: FigureContext, column: string, chromosome: string | undefined): string {
    const declared = declaredForColumn(context.labels, column);
    if (declared !== undefined) return `${declared.replace(POSITION_UNIT, "")} (Mb)`;
    if (chromosome === undefined) return "Position (Mb)";
    const name = chromosome.replace(/^chr/i, "");
    return `Position on chr${name} (Mb)`;
}

/**
 * The series of the ticks: one tick mark under the x axis at each multiple of the step inside the window, with
 * the position in megabases as its label. The runtime counts the ticks of an axis from its minimum, and the
 * window starts at the first row, thus the axis draws no tick of its own. The count of decimals is the count of the step, thus each name reads
 * alike.
 */
function tickSeries(window: PositionWindow): EchartOption {
    const decimals = decimalsOf(window.step / BASES_PER_MB);
    const data: EchartOption[] = [];
    for (let place = Math.ceil(window.min / window.step); place * window.step <= window.max; place += 1) {
        const at = Math.round(place * window.step);
        data.push({ name: (at / BASES_PER_MB).toFixed(decimals), value: [at, 0] });
    }
    return {
        type: "scatter",
        name: POSITION_TICKS,
        silent: true,
        symbol: "rect",
        symbolSize: [TICK_WIDTH_PX, TICK_LENGTH_PX],
        symbolOffset: [0, TICK_LENGTH_PX / 2],
        itemStyle: { color: CHART_INK },
        tooltip: { show: false },
        label: { show: true, position: "bottom", distance: 3, color: CHART_INK, formatter: "{b}" },
        data,
    };
}

/** The count of decimals of a round step, for example 1 for 0.1 and 2 for 0.25. */
function decimalsOf(step: number): number {
    const text = String(Number(step.toPrecision(6)));
    const point = text.indexOf(".");
    return point < 0 ? 0 : text.length - point - 1;
}

/** The color of the bin of one r², or the gray of a missing r². */
function binColor(r2: number | null): string {
    if (r2 === null) return LD_MISSING_COLOR;
    return (LD_BINS.find((bin, place) => r2 >= bin.low && (r2 < bin.high || place === LD_BINS.length - 1)) ?? LD_BINS[0]).color;
}

/**
 * The legend of the LD bins: a piecewise map over the r² of the points, highest bin first, with the gray entry
 * of a missing r² last. The title leads the row.
 *
 * The points of no r² draw in their own series, and the map colors the point series alone. The gray entry
 * holds no r² between 0 and 1, and the figure refuses any other r², thus the entry colors no point. A click
 * selects no bin, because the gray entry would hide nothing.
 */
function ldLegend(): EchartOption {
    const bins = [...LD_BINS].reverse().map((bin, place) => ({
        gte: bin.low,
        ...(place === 0 ? { lte: bin.high } : { lt: bin.high }),
        label: `${bin.low}–${bin.high}`,
        color: bin.color,
    }));
    return {
        type: "piecewise",
        seriesIndex: [0],
        dimension: 2,
        orient: "horizontal",
        top: 0,
        left: "center",
        selectedMode: false,
        showLabel: true,
        text: [LEGEND_TITLE, ""],
        itemSymbol: "circle",
        itemWidth: LEGEND_ICON_PX,
        itemHeight: LEGEND_ICON_PX,
        itemGap: LEGEND_ITEM_GAP_PX,
        textGap: LEGEND_TEXT_GAP_PX,
        inverse: true,
        pieces: [...bins, { lt: 0, label: LD_MISSING_NAME, color: LD_MISSING_COLOR }],
    };
}

/** The series of the points of no r²: gray, under the colored points. */
function missingSeries(data: readonly EchartOption[]): EchartOption {
    return {
        type: "scatter",
        name: LD_MISSING_NAME,
        symbolSize: POINT_PX,
        z: DENSE_NULL_Z,
        itemStyle: { color: LD_MISSING_COLOR, borderColor: CHART_INK, borderWidth: POINT_OUTLINE_PX },
        tooltip: { formatter: "{b}<br/>{a}" },
        data: [...data],
    };
}

/** The series of the stored zeros: the upward triangle at the drawn height, in the color of the bin of each. */
function zeroSeries(data: readonly EchartOption[]): EchartOption {
    return {
        type: "scatter",
        name: "p = 0",
        symbol: BELOW_RESOLUTION_SYMBOL,
        symbolSize: BELOW_RESOLUTION_SYMBOL_PX,
        itemStyle: { borderColor: CHART_INK, borderWidth: POINT_OUTLINE_PX },
        tooltip: BELOW_RESOLUTION_TOOLTIP,
        data: [...data],
    };
}

/** The series of the lead variant: one purple diamond over the points, with its name on top. */
function leadSeries(data: EchartOption): EchartOption {
    return {
        type: "scatter",
        name: LEAD_VARIANT_NAME,
        symbol: "diamond",
        symbolSize: LEAD_PX,
        z: 10,
        itemStyle: { color: LEAD_VARIANT_COLOR, borderColor: CHART_INK, borderWidth: POINT_OUTLINE_PX },
        label: { show: true, position: "top", distance: 4, color: CHART_INK, formatter: "{b}" },
        tooltip: { formatter: "{b}<br/>{a}" },
        data: [data],
    };
}

/**
 * The genes of the track inside the window, each one clipped to it, in the order of their starts. A row whose
 * start or end is not numeric draws no gene.
 *
 * A gene takes the room of its line and of its name under the line. The name centers under the line and stays
 * inside the window. The lane of a gene is the first lane whose last gene ends a gap before that room starts.
 */
function windowGenes(blockId: string, track: FigureTrack, window: PositionWindow): Result<Gene[], RenderProblem> {
    for (const column of [track.start, track.end, track.label]) {
        if (track.rows.length > 0 && !columnPresent(column, track.rows, track.columns)) {
            return err(chartProblem(blockId, `The track table holds no "${column}" column.`));
        }
    }
    const perCharacter = ((GENE_CHARACTER_SHARE * COLUMN_PLOT_FRAME.textPx) / COLUMN_PLOT_FRAME.widthPx) * (window.max - window.min);
    const spans: Array<{ start: number; end: number; name: string; place: number }> = [];
    for (const [place, row] of track.rows.entries()) {
        const a = toNumber(row[track.start]);
        const b = toNumber(row[track.end]);
        if (a === null || b === null) continue;
        const start = Math.max(Math.min(a, b), window.min);
        const end = Math.min(Math.max(a, b), window.max);
        if (start > end) continue;
        spans.push({ start, end, name: String(row[track.label] ?? ""), place });
    }
    spans.sort((a, b) => a.start - b.start || a.place - b.place);
    const laneOf = firstFreeLanes(spans.length);
    const genes: Gene[] = [];
    for (const span of spans) {
        const half = (span.name.length * perCharacter) / 2;
        const center = Math.min(Math.max((span.start + span.end) / 2, window.min + half), window.max - half);
        const from = Math.min(span.start, center - half);
        const to = Math.max(span.end, center + half) + GENE_GAP_CHARACTERS * perCharacter;
        genes.push({ start: span.start, end: span.end, name: span.name, center, lane: laneOf(from, to) });
    }
    return ok(genes);
}

/**
 * The series of the genes: one point with no symbol under the middle of each gene with its name as the label,
 * and one line for each gene. A gene symbol prints in italics, as the nomenclature asks.
 */
function geneSeries(genes: readonly Gene[], yAxisIndex: number): EchartOption {
    return {
        type: "scatter",
        name: GENE_NAMES,
        xAxisIndex: 1,
        yAxisIndex,
        silent: true,
        symbolSize: 0,
        tooltip: { show: false },
        label: { show: true, position: "bottom", distance: 2, color: CHART_INK, fontStyle: "italic", formatter: "{b}" },
        data: genes.map((gene) => ({ name: gene.name, value: [gene.center, gene.lane + GENE_LINE_PLACE] })),
        markLine: {
            silent: false,
            symbol: "none",
            label: { show: false },
            tooltip: { formatter: "{b}" },
            lineStyle: { color: CHART_INK, width: GENE_WIDTH_PX, type: "solid" },
            data: genes.map((gene) => [
                { name: gene.name, coord: [gene.start, gene.lane + GENE_LINE_PLACE] },
                { coord: [gene.end, gene.lane + GENE_LINE_PLACE] },
            ]),
        },
    };
}

/** The bands of the chart in percent of its body, and the body in pixels. */
interface BandLayout {
    readonly top: number;
    readonly plotBottom: number;
    readonly trackBottom: number;
    readonly band: number;
    readonly right: number;
    readonly bodyPx: number;
}

/**
 * The bands of one chart. A band past `LANES_IN_BODY` lanes grows the body by one lane of the default body for
 * each further lane, and each band keeps its height in pixels. The body stops at the largest body, and past it
 * the plot keeps its height and the lanes share the rest of the gene band.
 */
function bandLayout(lanes: number, withRate: boolean): BandLayout {
    const grown = Math.max(0, lanes - LANES_IN_BODY) * GENE_LANE;
    const bodyPx = Math.min(CHART_BODY_MAX_PX, (CHART_BODY_PX * (100 + grown)) / 100);
    const share = CHART_BODY_PX / bodyPx;
    const trackBottom = lanes > 0 ? TRACK_BOTTOM * share : 0;
    const top = PLOT_TOP * share;
    const axisBand = AXIS_BAND * share;
    const plot = (100 - PLOT_TOP - AXIS_BAND - (lanes > 0 ? TRACK_BOTTOM : 0) - Math.min(lanes, LANES_IN_BODY) * GENE_LANE) * share;
    const band = 100 - top - axisBand - trackBottom - plot;
    return {
        top,
        plotBottom: trackBottom + band + axisBand,
        trackBottom,
        band,
        right: withRate ? PLOT_RIGHT_WITH_RATE : PLOT_RIGHT,
        bodyPx,
    };
}

/** One share of the chart as a percent string. */
function pct(share: number): string {
    return `${Number(share.toFixed(2))}%`;
}

/** The locuszoom figure module. */
export const LOCUSZOOM_FIGURE: FigureModule = { reads: READS, derive: deriveLocusZoom };
