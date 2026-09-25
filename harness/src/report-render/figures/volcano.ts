/**
 * The volcano figure, as DESeq2 papers and EnhancedVolcano draw it: the effect on x, the transformed p on y,
 * the null points in gray under the two signal sides, and the names of the most significant signal genes.
 *
 * - The null points draw under the signal points, in gray and smaller. The down side takes the blue of the
 *   palette and the up side takes its vermilion.
 * - The legend names each side with the count of its points.
 * - The ten most significant signal points that carry a name show it. The derivation places each name clear of
 *   the other names and of the points, with a leader line to its point. The names place again for the plot and
 *   the text size of each export, and a name that finds no place clear of the earlier names does not print
 *   there.
 * - The effect axis is symmetric around zero, thus the two sides read at one scale.
 * - A row with no p draws no point and counts on no side.
 * - A row whose stored p is 0 draws an upward triangle at the top of the plotted range, on the side of its
 *   effect. It counts on that side, and it takes a name before each finite p.
 *
 * The classification and the guides read one pair of cuts, the declared thresholds or the preset defaults.
 * Thus the color split lands on the drawn lines. The points come from the composition machinery, thus a
 * table of many thousand genes reads the shared payload.
 */

import { err, ok, type Result } from "neverthrow";

import { channelColumn, type ChartBlock } from "../../contracts/report-blocks.js";
import { expandVolcano, VOLCANO_EFFECT_THRESHOLD, volcanoAxisTitles, type PresetClassification } from "../chart-presets.js";
import type { ChartRow, EchartOption } from "../chart.js";
import { CHART_PALETTE, MUTED_CHART_COLOR } from "../design.js";
import type { RenderProblem } from "../types.js";
import { transformColumn } from "./common.js";
import {
    axisOf,
    BELOW_RESOLUTION_SYMBOL,
    BELOW_RESOLUTION_SYMBOL_PX,
    BELOW_RESOLUTION_TOOLTIP,
    belowResolutionHeight,
    belowResolutionRows,
    countText,
    DENSE_NULL_OPACITY,
    DENSE_NULL_SYMBOL_PX,
    DENSE_NULL_Z,
    DENSE_SIGNAL_OPACITY,
    DENSE_SIGNAL_SYMBOL_PX,
    demandedChannel,
    largest,
    niceCeiling,
    plottedValues,
    pointLayer,
    POINT_NAMES,
    pointNameSeries,
    seriesOf,
    sizedSeries,
    symmetricRange,
} from "./dense.js";
import type { FigureContext, FigureMember, FigureModule } from "./index.js";
import { placeLeaderNames, type NamedPoint } from "./label-room.js";

/** The count of signal points that show their name. */
export const VOLCANO_LABEL_COUNT = 10;

/** The sides of a point where a volcano name sits, in the order that the figure tries them. */
const VOLCANO_NAME_SIDES = ["right", "left", "top"] as const;

/** The color of the down side and of the up side. The null side takes the muted color. */
const SIDE_COLORS = [CHART_PALETTE[0], CHART_PALETTE[1]] as const;

/** The members of a volcano block that the figure reads. */
const READS: ReadonlySet<FigureMember> = new Set(["x", "y", "label"]);

/**
 * The volcano classification with the count of each category in its name.
 *
 * The counts read the plotted pair of each row through the preset rule, which is the rule that splits the
 * series. Thus each name counts the points of its own series.
 */
function countedClassification(base: PresetClassification, xs: readonly (number | null)[], ys: readonly (number | null)[]): PresetClassification {
    const counts = new Map<string, number>(base.categories.map((category) => [category.name, 0]));
    for (let index = 0; index < xs.length; index += 1) {
        const category = base.categoryOf(xs[index], ys[index], index);
        if (category !== undefined) counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    const names = new Map(base.categories.map((category) => [category.name, `${category.name} (${countText(counts.get(category.name) ?? 0)})`]));
    return {
        categories: base.categories.map((category) => ({ ...category, name: names.get(category.name) ?? category.name })),
        categoryOf: (x, y, index) => {
            const category = base.categoryOf(x, y, index);
            return category === undefined ? undefined : names.get(category);
        },
        rule: base.rule,
    };
}

/**
 * The rows whose point shows its name: the most significant signal rows that carry a name, at most
 * `VOLCANO_LABEL_COUNT`. The order reads the plotted p, a stored zero first, and a tie keeps the order of the
 * rows.
 */
function labeledRows(
    rows: readonly ChartRow[],
    labelColumn: string | undefined,
    base: PresetClassification,
    xs: readonly (number | null)[],
    ys: readonly (number | null)[],
    zeros: ReadonlySet<number>,
): number[] {
    if (labelColumn === undefined) return [];
    const signal = new Set(base.categories.filter((category) => !category.muted).map((category) => category.name));
    const candidates: number[] = [];
    for (let index = 0; index < rows.length; index += 1) {
        const category = base.categoryOf(xs[index], ys[index], index);
        const name = rows[index][labelColumn];
        if (category !== undefined && signal.has(category) && name !== undefined && String(name).trim() !== "") candidates.push(index);
    }
    const rank = (index: number): number => (zeros.has(index) ? Number.POSITIVE_INFINITY : (ys[index] ?? 0));
    candidates.sort((a, b) => (rank(a) === rank(b) ? a - b : rank(b) - rank(a)));
    return candidates.slice(0, VOLCANO_LABEL_COUNT);
}

function deriveVolcano(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<EchartOption, RenderProblem> {
    const encoding = block.encoding ?? {};
    const x = demandedChannel(context.blockId, "volcano", encoding, "x");
    if (x.isErr()) return err(x.error);
    const y = demandedChannel(context.blockId, "volcano", encoding, "y");
    if (y.isErr()) return err(y.error);
    const expansion = expandVolcano(x.value, y.value, encoding, block.thresholds);
    const base = expansion.classification;
    const xs = plottedValues(rows, x.value);
    const pColumn = channelColumn(y.value);
    const finite = transformColumn(rows, pColumn, "neg_log10");
    const peak = largest(finite.flatMap((value, index) => (value !== null && xs[index] !== null ? [value] : []))) ?? 0;
    const zeroRows = belowResolutionRows(rows, pColumn, xs);
    const zeros = new Set(zeroRows);
    const zeroY = belowResolutionHeight(peak, base.rule.kind === "volcano" ? base.rule.cut : 0);
    // A stored zero draws at the top of the plotted range, thus the counts and the names read it there. The
    // composition reads the transformed column, which drops it, and the figure draws it in a series of its own.
    const ys = finite.map((value, index) => (zeros.has(index) ? zeroY : value));
    const counted = countedClassification(base, xs, ys);
    const composed = context.compose(expansion.composition, { preset: volcanoAxisTitles(x.value), classification: counted });
    if (composed.isErr()) return err(composed.error);

    const reach = largest(xs.flatMap((value, index) => (value !== null && ys[index] !== null ? [Math.abs(value)] : [])));
    const effect = block.thresholds?.effect ?? VOLCANO_EFFECT_THRESHOLD;
    const end = niceCeiling(Math.max(reach ?? 0, effect));
    const option = composed.value;
    const labelColumn = encoding.label;
    const names: NamedPoint[] =
        labelColumn === undefined
            ? []
            : labeledRows(rows, labelColumn, base, xs, ys, zeros).map((index) => ({
                  x: xs[index] ?? 0,
                  y: ys[index] ?? 0,
                  text: String(rows[index][labelColumn]),
              }));
    const top = zeroRows.length > 0 ? Math.max(peak, zeroY) : peak;
    // The runtime ends the p axis at its own round number at or past the peak. The round number of the figure
    // is at or past it too, thus the names measure against a span at least as long as the drawn one.
    const plot = { x: { min: -end, max: end }, y: { min: 0, max: niceCeiling(top) } };
    const text = sizedSeries([POINT_NAMES], (frame) =>
        pointNameSeries(names, placeLeaderNames(names, { xs, ys, pointPx: DENSE_SIGNAL_SYMBOL_PX }, plot, VOLCANO_NAME_SIDES, top, frame)),
    );
    const legend = typeof option.legend === "object" && option.legend !== null ? (option.legend as EchartOption) : {};
    return ok({
        ...option,
        ...text.member,
        // The legend names the three sides alone, and never the series of the point names.
        legend: { ...legend, data: seriesOf(option).map((series) => series.name) },
        xAxis: { ...axisOf(option, "xAxis"), ...symmetricRange(end) },
        yAxis: { ...axisOf(option, "yAxis"), min: 0 },
        series: [
            ...seriesOf(option).map((series, place) => ({ ...series, ...sideLayer(place, DENSE_SIGNAL_SYMBOL_PX, DENSE_NULL_SYMBOL_PX) })),
            ...zeroSeries(counted, zeroRows, xs, zeroY, labelColumn === undefined ? undefined : (index) => String(rows[index][labelColumn])),
            ...text.page,
        ],
    });
}

/** The style of the points of one side, by the place of the side: the two signal sides, then the null side. */
function sideLayer(place: number, signalPx: number, nullPx: number): EchartOption {
    return place < SIDE_COLORS.length
        ? pointLayer(SIDE_COLORS[place], signalPx, DENSE_SIGNAL_OPACITY)
        : pointLayer(MUTED_CHART_COLOR, nullPx, DENSE_NULL_OPACITY, DENSE_NULL_Z);
}

/**
 * The series of the stored zeros: one series for each side that holds one, under the name and in the style of
 * that side, with the upward triangle at the drawn height. The series follow the points of the composition,
 * thus they keep their rows inline and the points still read the shared payload.
 */
function zeroSeries(
    classification: PresetClassification,
    zeroRows: readonly number[],
    xs: readonly (number | null)[],
    zeroY: number,
    nameOf: ((index: number) => string) | undefined,
): EchartOption[] {
    return classification.categories.flatMap((category, place) => {
        const data = zeroRows
            .filter((index) => classification.categoryOf(xs[index], zeroY, index) === category.name)
            .map((index) => (nameOf === undefined ? [xs[index] ?? 0, zeroY] : { name: nameOf(index), value: [xs[index] ?? 0, zeroY] }));
        if (data.length === 0) return [];
        return [
            {
                type: "scatter",
                name: category.name,
                symbol: BELOW_RESOLUTION_SYMBOL,
                ...sideLayer(place, BELOW_RESOLUTION_SYMBOL_PX, BELOW_RESOLUTION_SYMBOL_PX),
                tooltip: BELOW_RESOLUTION_TOOLTIP,
                data,
            },
        ];
    });
}

/** The volcano figure module. */
export const VOLCANO_FIGURE: FigureModule = { reads: READS, derive: deriveVolcano };
