/**
 * The oncoprint: the alteration matrix of a cohort, genes by samples.
 *
 * The canonical design is the one of cBioPortal, ComplexHeatmap, and maftools. Each cell draws a gray ground,
 * and an altered cell adds one glyph in the color of its class. A bar over the matrix draws the alteration
 * count of each sample, stacked by class, and a bar at the right draws the share of altered samples of each
 * gene with its percent text. A cohort holds too many samples for their names, thus the names hide and the
 * axis title states the count.
 *
 * The figure computes two named summaries, and each one reads the rows of the bound table alone:
 *
 * - The alteration count of a sample: the count of its rows with a class, split by class.
 * - The share of a gene: the count of samples with a class in that gene, over the count of every sample of
 *   the table. A row with an empty class names a sample with no alteration, thus that sample counts in the
 *   denominator and draws the ground alone.
 *
 * Each gene name and each percent text prints. Thus a figure of more genes than the default body holds at one
 * line of text each states a taller body, and the grids keep their shares of it. A taller body grows the
 * column exports in the same ratio.
 */

import { err, ok, type Result } from "neverthrow";

import { channelColumn, channelOrder, channelTransform, type ChartBlock, type ChartChannel } from "../../contracts/report-blocks.js";
import { declaredForColumn } from "../../contracts/report-reference.js";
import { CELL_GLYPH_RENDERER } from "../chart-renderers.js";
import type { Cell, ChartRow, EchartOption } from "../chart.js";
import {
    CHART_BODY_MAX_PX,
    CHART_BODY_PX,
    CHART_EXPORT_SIZES,
    CHART_PAGE_TEXT_PX,
    CHART_PAGE_WIDTH_PX,
    CHART_SLOT_LIMIT,
    CHART_WIDE_PALETTE,
    MUTED_CHART_COLOR,
} from "../design.js";
import type { RenderProblem } from "../types.js";
import {
    categoryAxis,
    categoryName,
    chartProblem,
    columnPresent,
    firstAppearance,
    legendLineCount,
    legendLinePx,
    orderQuickCategories,
    valueAxis,
    withFigureBody,
    type ColumnLabels,
} from "./common.js";
import type { FigureContext, FigureModule } from "./index.js";

/**
 * The color of each common alteration class of the MAF standard, in the order of the legend.
 *
 * The first seven classes take the Okabe-Ito hues, and `Multi_Hit` takes its black, as maftools draws it. The
 * two rare classes take the first two hues of the wide palette past the Okabe-Ito set.
 */
export const ALTERATION_CLASS_COLORS: Readonly<Record<string, string>> = {
    Missense_Mutation: "#009e73",
    Nonsense_Mutation: "#d55e00",
    Frame_Shift_Del: "#0072b2",
    Frame_Shift_Ins: "#cc79a7",
    In_Frame_Del: "#e69f00",
    In_Frame_Ins: "#56b4e9",
    Splice_Site: "#f0e442",
    Translation_Start_Site: "#875692",
    Nonstop_Mutation: "#8db600",
    Multi_Hit: "#000000",
};

/** The colors that an unknown class takes, in order: the wide palette less each color of the fixed map. */
const UNKNOWN_CLASS_COLORS: readonly string[] = CHART_WIDE_PALETTE.filter((color) => !Object.values(ALTERATION_CLASS_COLORS).includes(color));

/** The gray ground of each cell. It is lighter than the muted color, thus a glyph of any class reads on it. */
export const CELL_GROUND_COLOR = "#e0e0e0";

/** The stack name of the count bars. Each class series names it, thus the classes of one sample stack. */
const COUNT_STACK = "alterations";

/** The title of the count axis over the matrix. */
const COUNT_TITLE = "Alterations";

/**
 * The places of the three grids, in percent of the chart: the matrix, the count bar over it, and the share bar
 * at its right. The count bar shares the left and the right edge of the matrix, and the share bar shares its
 * top and its bottom, thus each bar lines up with its row or its column. The left band holds the gene names,
 * and the band at the right of the share bar holds its percent text.
 */
const MATRIX_TOP_PCT = 22;
const MATRIX_BOTTOM_PCT = 28;
const MATRIX_GRID: EchartOption = { left: "14%", right: "17%", top: `${MATRIX_TOP_PCT}%`, bottom: `${MATRIX_BOTTOM_PCT}%` };

/** The height of one gene row on the page, in pixels: one line of the page text with a gap. */
export const ONCOPRINT_ROW_PX = 16;

/** The height of one annotation strip under the matrix, and the gap between the matrix and the strips, in percent of the chart. */
const STRIP_BAND_PCT = 3.5;
const STRIP_GAP_PCT = 1;
const COUNT_GRID: EchartOption = { left: "14%", right: "17%", top: "5%", height: "14%" };
const SHARE_GRID: EchartOption = { left: "84%", right: "8%", top: "22%", bottom: "28%" };

/**
 * The icon size and the gap of the class legend, in pixels. A cohort states some classes, and the smaller icon
 * keeps the legend to few lines at the width of a single journal column.
 */
const LEGEND_ICON_PX = 10;
const LEGEND_GAP_PX = 8;

/** The gap between the matrix and the sample title. The sample names hide, thus the title sits close to the cells. */
const SAMPLE_TITLE_GAP = 8;

/** The height of the sample title line, as a share of the text size. */
const TITLE_LINE_SHARE = 1.6;

/** The oncoprint module: the sample, the gene, the class, and the annotation tracks. */
export const ONCOPRINT_FIGURE: FigureModule = { reads: new Set(["x", "y", "value", "tracks"]), derive: deriveOncoprint };

/** One category channel of the figure: its column and its order. */
interface CategoryChannel {
    readonly column: string;
    readonly channel: ChartChannel;
}

function deriveOncoprint(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<EchartOption, RenderProblem> {
    const sample = categoryChannel(block, rows, context, "x");
    if (sample.isErr()) return err(sample.error);
    const gene = categoryChannel(block, rows, context, "y");
    if (gene.isErr()) return err(gene.error);
    const klass = categoryChannel(block, rows, context, "value");
    if (klass.isErr()) return err(klass.error);

    const samples = orderQuickCategories(context.blockId, rows, sample.value.column, channelOrder(sample.value.channel));
    if (samples.isErr()) return err(samples.error);
    const genes = orderQuickCategories(context.blockId, rows, gene.value.column, channelOrder(gene.value.channel));
    if (genes.isErr()) return err(genes.error);
    const cellCount = genes.value.length * samples.value.length;
    if (cellCount > CHART_SLOT_LIMIT) {
        // The matrix draws one cell for each gene and each sample, whether or not a row names the pair.
        return err(
            chartProblem(
                context.blockId,
                `The oncoprint holds ${genes.value.length} genes and ${samples.value.length} samples, thus ${cellCount} cells. A chart holds ${CHART_SLOT_LIMIT} slots at most, thus a table of fewer genes or fewer samples serves the reader.`,
            ),
        );
    }

    const cells = classCells(context.blockId, rows, sample.value.column, gene.value.column, klass.value.column);
    if (cells.isErr()) return err(cells.error);
    const tracks = sampleTracks(context, rows, sample.value.column, block.encoding?.tracks ?? []);
    if (tracks.isErr()) return err(tracks.error);
    const classes = legendClasses(rows, klass.value.column);
    const trackValues = firstAppearance(tracks.value.flatMap((track) => samples.value.flatMap((name) => track.values.get(String(name)) ?? [])));
    const legendColors = classColors([...classes, ...trackValues]);
    const colors = legendColors.slice(0, classes.length);
    const places = new Map(classes.map((name, place) => [name, place]));

    const data: Array<number[] | { name: string; value: number[] }> = [];
    for (const [geneIndex, geneName] of genes.value.entries()) {
        for (const [sampleIndex, sampleName] of samples.value.entries()) {
            const name = cells.value.get(cellKey(sampleName, geneName));
            if (name === undefined) {
                data.push([sampleIndex, geneIndex, -1]);
                continue;
            }
            data.push({ name: `${String(geneName)}, ${String(sampleName)}: ${categoryName(name)}`, value: [sampleIndex, geneIndex, places.get(name) ?? -1] });
        }
    }

    const sampleTitle = `${categoryAxisName(context.labels, sample.value.column)} (n = ${samples.value.length})`;
    const sampleAxis: EchartOption = { nameGap: SAMPLE_TITLE_GAP, axisLabel: { show: false }, axisTick: { show: false }, axisLine: { show: false } };
    const stripBand = tracks.value.length * STRIP_BAND_PCT;
    const stripShare = stripBand === 0 ? 0 : stripBand + STRIP_GAP_PCT;
    const legendNames = [...classes, ...trackValues].map((name) => categoryName(name));
    const band = legendBandPx(legendNames);
    const body = (genes.value.length * ONCOPRINT_ROW_PX + band) / (1 - (MATRIX_TOP_PCT + stripShare) / 100);
    const tall = body > CHART_BODY_PX;
    const bottom = tall ? (band / Math.min(body, CHART_BODY_MAX_PX)) * 100 : MATRIX_BOTTOM_PCT;
    const layout = { ...MATRIX_GRID, bottom: percentOf(bottom + stripShare) };
    const strips = stripMembers(tracks.value, samples.value, trackValues, legendColors.slice(classes.length), stripBand, bottom, sampleTitle, context.labels);
    const option: EchartOption = {
        tooltip: { trigger: "item" },
        grid: [layout, { ...COUNT_GRID }, { ...SHARE_GRID, bottom: layout.bottom }, ...strips.grid],
        xAxis: [
            { ...categoryAxis("x", samples.value, { title: strips.grid.length === 0 ? sampleTitle : undefined }), gridIndex: 0, ...sampleAxis },
            { type: "category", gridIndex: 1, data: [...samples.value], axisLabel: { show: false }, axisTick: { show: false } },
            { type: "value", gridIndex: 2, min: 0, max: 1, show: false },
            ...strips.xAxis.map((axis) => ({ ...axis, ...sampleAxis })),
        ],
        yAxis: [
            {
                ...categoryAxis("y", genes.value, { topDown: true }),
                gridIndex: 0,
                axisTick: { show: false },
                axisLine: { show: false },
                // A single journal column gives a row less than one line of text. Each gene name that would
                // cover its neighbor hides, and the share text of its row hides with it.
                axisLabel: { hideOverlap: true },
            },
            { ...valueAxis("y", COUNT_TITLE), gridIndex: 1, minInterval: 1, splitNumber: 2 },
            { type: "category", gridIndex: 2, inverse: true, data: [...genes.value], show: false },
            ...strips.yAxis,
        ],
        series: [
            {
                type: "custom",
                renderItem: CELL_GLYPH_RENDERER,
                itemPayload: { colors, ground: CELL_GROUND_COLOR },
                xAxisIndex: 0,
                yAxisIndex: 0,
                encode: { x: 0, y: 1 },
                tooltip: { formatter: "{b}" },
                data,
            },
            ...countSeries(rows, samples.value, sample.value.column, klass.value.column, classes, colors),
            shareSeries(rows, samples.value, genes.value, sample.value.column, gene.value.column, klass.value.column),
            ...strips.series,
        ],
        legend: {
            // A taller body holds the legend lines of the single column export, thus the page legend starts
            // under the sample title and the free part of the band sits under it.
            ...(tall
                ? {
                      top: percentOf(
                          100 - bottom + ((CHART_PAGE_TEXT_PX * (1 + TITLE_LINE_SHARE) + SAMPLE_TITLE_GAP) / Math.min(body, CHART_BODY_MAX_PX)) * 100,
                      ),
                  }
                : { bottom: 0 }),
            itemWidth: LEGEND_ICON_PX,
            itemHeight: LEGEND_ICON_PX,
            itemGap: LEGEND_GAP_PX,
            data: legendNames,
        },
    };
    return ok(tall ? withFigureBody(option, body) : option);
}

/**
 * The band under the matrix and the strips of a taller body, in page pixels: the sample title, and the lines of
 * the legend. The band holds the legend lines of the page and of the single column export, whose narrow width
 * wraps the legend into more lines. A column export keeps the share of the band, thus the band of the column
 * converts to page pixels in the ratio of the page body to the column height.
 */
function legendBandPx(names: readonly string[]): number {
    const bandAt = (widthPx: number, textPx: number): number =>
        legendLineCount(names, widthPx, textPx) * legendLinePx(textPx, LEGEND_GAP_PX) + textPx * (1 + TITLE_LINE_SHARE) + SAMPLE_TITLE_GAP;
    const single = CHART_EXPORT_SIZES.single;
    return Math.ceil(Math.max(bandAt(CHART_PAGE_WIDTH_PX, CHART_PAGE_TEXT_PX), (bandAt(single.widthPx, single.textPx) * CHART_BODY_PX) / single.heightPx));
}

/**
 * The column of one category channel. An absent channel, a transform, and a column that no row holds each
 * refuse, because the figure reads the cells of the column as names.
 */
function categoryChannel(
    block: ChartBlock,
    rows: readonly ChartRow[],
    context: FigureContext,
    name: "x" | "y" | "value",
): Result<CategoryChannel, RenderProblem> {
    const channel = block.encoding?.[name];
    if (channel === undefined) {
        return err(chartProblem(context.blockId, `The oncoprint figure needs a column for the "${name}" channel.`));
    }
    if (channelTransform(channel) !== undefined) {
        return err(chartProblem(context.blockId, `The oncoprint reads the "${name}" column as categories, thus the channel takes no transform.`));
    }
    if (name === "value" && channelOrder(channel) !== undefined) {
        return err(chartProblem(context.blockId, 'The "value" channel draws no category axis, thus it takes no "orderBy".'));
    }
    const column = channelColumn(channel);
    if (rows.length > 0 && !columnPresent(column, rows, context.columns)) {
        return err(chartProblem(context.blockId, `The column "${column}" is absent from every row.`));
    }
    return ok({ column, channel });
}

/** The class of one row, or `undefined` for a row that names a sample with no alteration. */
export function classOf(row: ChartRow, column: string): string | undefined {
    const cell = row[column];
    if (cell === undefined) return undefined;
    const text = String(cell).trim();
    return text === "" ? undefined : text;
}

/** The key of one cell of the matrix. Each cell keeps its type, thus the number `1` and the text `"1"` differ. */
function cellKey(sample: Cell, gene: Cell): string {
    return JSON.stringify([typeof sample, String(sample), typeof gene, String(gene)]);
}

/**
 * The class of each altered cell. A cell that two rows name with a class has no one glyph, thus it refuses:
 * the MAF standard states `Multi_Hit` for it.
 */
function classCells(blockId: string, rows: readonly ChartRow[], sample: string, gene: string, klass: string): Result<Map<string, string>, RenderProblem> {
    const cells = new Map<string, string>();
    for (const row of rows) {
        const name = classOf(row, klass);
        if (name === undefined) continue;
        const key = cellKey(row[sample], row[gene]);
        if (cells.has(key)) {
            return err(
                chartProblem(
                    blockId,
                    `The oncoprint holds the gene "${String(row[gene])}" and the sample "${String(row[sample])}" with two classes. One cell draws one class, thus the table states "Multi_Hit" for a gene with more than one class in a sample.`,
                ),
            );
        }
        cells.set(key, name);
    }
    return ok(cells);
}

/** The classes of the table in the order of the legend: the common classes in their fixed order, then each other class as it first appears. */
export function legendClasses(rows: readonly ChartRow[], column: string): string[] {
    const present = new Set<string>();
    const unknown: string[] = [];
    for (const row of rows) {
        const name = classOf(row, column);
        if (name === undefined || present.has(name)) continue;
        present.add(name);
        if (declaredForColumn(ALTERATION_CLASS_COLORS, name) === undefined) unknown.push(name);
    }
    return [...Object.keys(ALTERATION_CLASS_COLORS).filter((name) => present.has(name)), ...unknown];
}

/** The color of each class in legend order. An unknown class takes the next color of its own list, and past that list the muted color. */
export function classColors(classes: readonly string[]): string[] {
    let next = 0;
    return classes.map((name) => {
        const fixed = declaredForColumn(ALTERATION_CLASS_COLORS, name);
        if (fixed !== undefined) return fixed;
        const color = UNKNOWN_CLASS_COLORS[next] ?? MUTED_CHART_COLOR;
        next += 1;
        return color;
    });
}

/** The title of a category axis: the declared label of the column, else the column name as words. */
function categoryAxisName(labels: ColumnLabels, column: string): string {
    return declaredForColumn(labels, column) ?? categoryName(column);
}

/** The count bars over the matrix: one series for each class, stacked, with the count of the class in each sample. */
function countSeries(
    rows: readonly ChartRow[],
    samples: readonly Cell[],
    sample: string,
    klass: string,
    classes: readonly string[],
    colors: readonly string[],
): EchartOption[] {
    const places = new Map(samples.map((name, place) => [String(name), place]));
    const counts = classes.map(() => samples.map((): number | null => null));
    const classPlaces = new Map(classes.map((name, place) => [name, place]));
    for (const row of rows) {
        const name = classOf(row, klass);
        const place = places.get(String(row[sample]));
        if (name === undefined || place === undefined) continue;
        const series = counts[classPlaces.get(name) ?? -1];
        if (series !== undefined) series[place] = (series[place] ?? 0) + 1;
    }
    return classes.map((name, index) => ({
        type: "bar",
        name: categoryName(name),
        stack: COUNT_STACK,
        xAxisIndex: 1,
        yAxisIndex: 1,
        barCategoryGap: "10%",
        itemStyle: { color: colors[index] },
        tooltip: { formatter: "{b}<br/>{a}: {c}" },
        data: counts[index],
    }));
}

/**
 * The share bar at the right of the matrix: for each gene, the count of its altered samples over the count of
 * every sample of the table, with its percent text at the end of the bar.
 */
function shareSeries(rows: readonly ChartRow[], samples: readonly Cell[], genes: readonly Cell[], sample: string, gene: string, klass: string): EchartOption {
    const altered = new Map<string, Set<string>>();
    for (const row of rows) {
        if (classOf(row, klass) === undefined) continue;
        const key = String(row[gene]);
        const set = altered.get(key) ?? new Set<string>();
        set.add(String(row[sample]));
        altered.set(key, set);
    }
    const total = samples.length;
    return {
        type: "bar",
        xAxisIndex: 2,
        yAxisIndex: 2,
        silent: true,
        barCategoryGap: "30%",
        itemStyle: { color: MUTED_CHART_COLOR },
        label: { show: true, position: "right" },
        labelLayout: { hideOverlap: true },
        data: genes.map((name) => {
            const share = total === 0 ? 0 : (altered.get(String(name))?.size ?? 0) / total;
            return { value: share, label: { formatter: percentText(share) } };
        }),
    };
}

/** The percent text of one share: a whole percent, and `<1%` for a share above zero that rounds to zero. */
function percentText(share: number): string {
    const percent = Math.round(share * 100);
    return percent === 0 && share > 0 ? "<1%" : `${percent}%`;
}

/** One annotation track: its column, and the value of each sample, keyed by the text of the sample. */
interface SampleTrack {
    readonly column: string;
    readonly values: ReadonlyMap<string, string>;
}

/**
 * The value of each sample in each track column. A track draws one value for each sample, thus a sample whose
 * rows hold two values refuses. An empty cell gives no value, and its sample draws no strip cell.
 */
function sampleTracks(context: FigureContext, rows: readonly ChartRow[], sample: string, columns: readonly string[]): Result<SampleTrack[], RenderProblem> {
    const tracks: SampleTrack[] = [];
    for (const column of columns) {
        if (rows.length > 0 && !columnPresent(column, rows, context.columns)) {
            return err(chartProblem(context.blockId, `The column "${column}" is absent from every row.`));
        }
        const values = new Map<string, string>();
        for (const row of rows) {
            const cell = row[column];
            const value = cell === undefined ? "" : String(cell).trim();
            if (value === "") continue;
            const key = String(row[sample]);
            const held = values.get(key);
            if (held !== undefined && held !== value) {
                return err(
                    chartProblem(
                        context.blockId,
                        `The track column "${column}" holds two values for the sample "${key}". A track draws one value for each sample.`,
                    ),
                );
            }
            values.set(key, value);
        }
        tracks.push({ column, values });
    }
    return ok(tracks);
}

/** The grid, the axes, and the series of the annotation strips, or none of them for a block with no track. */
interface StripMembers {
    readonly grid: EchartOption[];
    readonly xAxis: EchartOption[];
    readonly yAxis: EchartOption[];
    readonly series: EchartOption[];
}

/**
 * The annotation strips under the matrix: one row of cells for each track, in one grid that shares the sample
 * axis of the matrix. Each value of a track draws its cells through the cell-glyph renderer as a ground of the
 * value color alone, thus one series of each value names its legend entry. The sample title sits under the
 * strips.
 */
function stripMembers(
    tracks: readonly SampleTrack[],
    samples: readonly Cell[],
    values: readonly string[],
    colors: readonly string[],
    band: number,
    bottom: number,
    sampleTitle: string,
    labels: ColumnLabels,
): StripMembers {
    if (tracks.length === 0) return { grid: [], xAxis: [], yAxis: [], series: [] };
    const cellsOf = new Map<string, number[][]>(values.map((value) => [value, []]));
    for (const [trackPlace, track] of tracks.entries()) {
        for (const [samplePlace, name] of samples.entries()) {
            const value = track.values.get(String(name));
            if (value !== undefined) cellsOf.get(value)?.push([samplePlace, trackPlace, -1]);
        }
    }
    const series: EchartOption[] = [];
    for (const [valuePlace, value] of values.entries()) {
        const data = cellsOf.get(value) ?? [];
        series.push({
            type: "custom",
            name: categoryName(value),
            renderItem: CELL_GLYPH_RENDERER,
            itemPayload: { colors: [], ground: colors[valuePlace] },
            // The legend reads the color of the series, and the renderer reads the ground.
            itemStyle: { color: colors[valuePlace] },
            xAxisIndex: 3,
            yAxisIndex: 3,
            encode: { x: 0, y: 1 },
            tooltip: { formatter: "{a}" },
            data,
        });
    }
    return {
        grid: [{ left: MATRIX_GRID.left, right: MATRIX_GRID.right, bottom: percentOf(bottom), height: percentOf(band) }],
        xAxis: [{ ...categoryAxis("x", samples, { title: sampleTitle }), gridIndex: 3 }],
        yAxis: [
            {
                ...categoryAxis(
                    "y",
                    tracks.map((track) => categoryAxisName(labels, track.column)),
                    { topDown: true },
                ),
                gridIndex: 3,
                axisTick: { show: false },
                axisLine: { show: false },
            },
        ],
        series,
    };
}

/** One layout percentage, rounded, thus a float residue never reaches the option. */
function percentOf(value: number): string {
    return `${Math.round(value * 1e4) / 1e4}%`;
}
