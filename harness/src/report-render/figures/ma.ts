/**
 * The MA figure, as the `plotMA` of DESeq2 draws it: the mean of the normalized counts on a log axis, the
 * log fold change on y, and the significant genes in blue over the gray genes that state no finding.
 *
 * - The x axis is logarithmic, and it ends at the decades around the positive means. A row whose mean is not
 *   positive has no place on it, and it draws no point.
 * - The `p` column splits the rows at the significance cut: the declared thresholds, or the DESeq2 default
 *   of 0.1. A row with no p draws gray, as `plotMA` draws it. The significant points take the blue of the
 *   palette, which is the default of DESeq2, and the gray points draw under them.
 * - A line sits at zero, and the y axis is symmetric around zero.
 *
 * The points come from the composition machinery, thus a table of many thousand genes reads the shared
 * payload. The rule of the split rides the payload as plain data, thus the page splits the rows as the server
 * does.
 */

import { err, ok, type Result } from "neverthrow";

import { channelTransform, type ChartBlock, type ChartComposition } from "../../contracts/report-blocks.js";
import { MA_BASELINE, type PresetClassification } from "../chart-presets.js";
import type { ChartRow, EchartOption } from "../chart.js";
import { CHART_PALETTE, MUTED_CHART_COLOR } from "../design.js";
import { formatNumberCell } from "../number-format.js";
import type { RenderProblem } from "../types.js";
import { chartProblem, plainColumn, toNumber, valueAxisTitle } from "./common.js";
import {
    axisOf,
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
    seriesOf,
    smallest,
    symmetricRange,
} from "./dense.js";
import type { FigureContext, FigureMember, FigureModule } from "./index.js";

/** The significance cut of an MA plot where the block declares none: the `alpha` default of DESeq2. */
export const MA_P_THRESHOLD = 0.1;

/** The name of the gray category. The muted rule of the renderer reads the same text. */
const MA_NULL = "Not significant";

/** The members of an MA block that the figure reads. */
const READS: ReadonlySet<FigureMember> = new Set(["x", "y", "p", "label"]);

/**
 * The two-way split of an MA plot, one row at a time: under the cut of the p column, or not.
 *
 * The significant name states the column and the cut, thus the legend states the rule of the colors. A row
 * whose mean is not positive belongs to no category, because the log axis has no place for it.
 */
function maClassification(rows: readonly ChartRow[], pColumn: string, pTitle: string, cut: number): PresetClassification {
    const significant = `${pTitle} < ${formatNumberCell(cut, "compact-scientific").text}`;
    return {
        categories: [
            { name: significant, muted: false },
            { name: MA_NULL, muted: true },
        ],
        rule: { kind: "ma", column: pColumn, cut },
        categoryOf: (x, y, index) => {
            if (x === null || y === null || x <= 0) return undefined;
            const p = toNumber(rows[index][pColumn]);
            return p !== null && p < cut ? significant : MA_NULL;
        },
    };
}

/** The decade at or under a positive value, and the decade at or over it. */
function decadeFloor(value: number): number {
    return Math.pow(10, Math.floor(Math.log10(value)));
}

function decadeCeiling(value: number): number {
    return Math.pow(10, Math.ceil(Math.log10(value)));
}

function deriveMa(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<EchartOption, RenderProblem> {
    const encoding = block.encoding ?? {};
    if (block.thresholds?.effect !== undefined) {
        // The figure splits its rows by the p column alone, thus an effect cut would move nothing.
        return err(chartProblem(context.blockId, "The ma chart reads the significance cut alone. Omit the effect cut."));
    }
    const x = demandedChannel(context.blockId, "ma", encoding, "x");
    if (x.isErr()) return err(x.error);
    if (channelTransform(x.value) !== undefined) {
        return err(chartProblem(context.blockId, 'The ma figure draws the "x" channel on a log axis, thus it takes no transform.'));
    }
    const y = demandedChannel(context.blockId, "ma", encoding, "y");
    if (y.isErr()) return err(y.error);
    const pColumn = plainColumn("ma", encoding, "p", { blockId: context.blockId, rows, columns: context.columns });
    if (pColumn.isErr()) return err(pColumn.error);

    const composition: ChartComposition = {
        series: [{ form: "scatter", encoding: { x: x.value, y: y.value, ...(encoding.label !== undefined ? { label: encoding.label } : {}) } }],
        annotations: [{ kind: "reference-line", axis: "y", value: MA_BASELINE }],
        axes: { x: { scale: "log" } },
    };
    const cut = block.thresholds?.significance ?? MA_P_THRESHOLD;
    const classification = pColumn.value === undefined ? undefined : maClassification(rows, pColumn.value, valueAxisTitle(context.labels, pColumn.value), cut);
    const composed = context.compose(composition, classification !== undefined ? { classification } : {});
    if (composed.isErr()) return err(composed.error);

    const xs = plottedValues(rows, x.value);
    const ys = plottedValues(rows, y.value);
    const means: number[] = [];
    const effects: number[] = [];
    for (let index = 0; index < rows.length; index += 1) {
        const mean = xs[index];
        const effect = ys[index];
        if (mean === null || effect === null || mean <= 0) continue;
        means.push(mean);
        effects.push(Math.abs(effect));
    }
    const low = smallest(means);
    const high = largest(means);
    const reach = niceCeiling(largest(effects) ?? 0);
    const option = composed.value;
    return ok({
        ...option,
        xAxis: { ...axisOf(option, "xAxis"), ...(low !== undefined && high !== undefined ? { min: decadeFloor(low), max: decadeCeiling(high) } : {}) },
        yAxis: { ...axisOf(option, "yAxis"), ...symmetricRange(reach) },
        series:
            classification === undefined
                ? seriesOf(option).map((series) => ({ ...series, symbolSize: DENSE_SIGNAL_SYMBOL_PX }))
                : seriesOf(option).map((series, place) =>
                      place === 0
                          ? { ...series, ...pointLayer(CHART_PALETTE[0], DENSE_SIGNAL_SYMBOL_PX, DENSE_SIGNAL_OPACITY) }
                          : { ...series, ...pointLayer(MUTED_CHART_COLOR, DENSE_NULL_SYMBOL_PX, DENSE_NULL_OPACITY, DENSE_NULL_Z) },
                  ),
    });
}

/** The MA figure module. */
export const MA_FIGURE: FigureModule = { reads: READS, derive: deriveMa };
