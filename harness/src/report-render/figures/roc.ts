/**
 * The ROC figure: the empirical curve of each group, the dashed diagonal of chance, and the statistics text.
 *
 * A row of the table is one operating point of a classifier: its false positive rate and its true positive
 * rate at one threshold. The curve runs through the points of its group in order of the false positive rate,
 * then of the true positive rate, thus the steps of an empirical curve read as steps, and a tie of scores
 * reads as the diagonal segment that the field draws for it. The figure adds no point that the table does not
 * hold.
 *
 * The two axes hold one quantity, a rate from 0 to 1, thus they share the range, the tick step, and the unit:
 * the plot is a square, and the diagonal of chance runs at 45 degrees. The legend sits in a band under the
 * square, thus a narrow column export keeps the square large. The statistics text is the label of a point at
 * the corner (1, 0) of the data, thus it stays in the corner of the square in each container.
 */

import { err, ok, type Result } from "neverthrow";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import type { Cell, ChartRow, EchartOption } from "../chart.js";
import type { RenderProblem } from "../types.js";
import {
    categoricalPalette,
    categoryName,
    chartProblem,
    demandedColumn,
    firstAppearance,
    GUIDE_LINE_STYLE,
    plainColumn,
    STATISTICS_POINT_INSET_PX,
    statisticsSeries,
    toNumber,
    valueAxis,
    valueAxisTitle,
    type ChannelSource,
} from "./common.js";
import { squareLayout } from "./equal-units.js";
import type { FigureContext, FigureMember, FigureModule } from "./index.js";

/** The members of a roc block that the figure reads. */
const ROC_READS: ReadonlySet<FigureMember> = new Set<FigureMember>(["x", "y", "group", "statistics"]);

/** The ROC curve figure. */
export const ROC_FIGURE: FigureModule = { reads: ROC_READS, derive: deriveRoc };

/** The tick step of both rate axes. */
const RATE_STEP = 0.2;

/** The margins of the square of a ROC curve, in pixels: the tick labels and the title of each axis. */
const ROC_MARGINS = { top: 16, bottom: 56, left: 64, right: 12 } as const;

/** The stroke width of a curve, in pixels. */
const CURVE_WIDTH_PX = 1.5;

/** One curve: the name of its group, and its points in drawing order. */
interface RocCurve {
    readonly name: string;
    readonly points: number[][];
}

/** Derive the figure of one roc block. */
function deriveRoc(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<EchartOption, RenderProblem> {
    const encoding = block.encoding ?? {};
    const source: ChannelSource = { blockId: context.blockId, rows, columns: context.columns };
    const fpr = demandedColumn("roc", encoding, "x", source);
    if (fpr.isErr()) return err(fpr.error);
    const tpr = demandedColumn("roc", encoding, "y", source);
    if (tpr.isErr()) return err(tpr.error);
    const group = plainColumn("roc", encoding, "group", source);
    if (group.isErr()) return err(group.error);
    const curves = rocCurves(rows, fpr.value, tpr.value, group.value, context.blockId);
    if (curves.isErr()) return err(curves.error);

    const palette = categoricalPalette(curves.value.length);
    const series: EchartOption[] = curves.value.map((curve, index) => {
        const color = palette[index % palette.length];
        return {
            type: "line",
            name: categoryName(curve.name),
            showSymbol: false,
            itemStyle: { color },
            lineStyle: { color, width: CURVE_WIDTH_PX },
            data: curve.points,
        };
    });
    series.push({
        type: "line",
        silent: true,
        tooltip: { show: false },
        data: [],
        markLine: {
            silent: true,
            symbol: "none",
            label: { show: false },
            lineStyle: { ...GUIDE_LINE_STYLE },
            data: [[{ coord: [0, 0] }, { coord: [1, 1] }]],
        },
    });
    const statistics = statisticsSeries(context.statistics, [1, 0], "bottom-right");
    const squareLabel = statistics.length > 0 ? { series: series.length, insetPx: STATISTICS_POINT_INSET_PX } : undefined;
    series.push(...statistics);
    const keyed = curves.value.length > 1;
    const names = curves.value.map((curve) => categoryName(curve.name));
    const layout = squareLayout({
        panels: 1,
        margins: ROC_MARGINS,
        side: 0,
        legend: keyed,
        legendBand: { place: "bottom", entries: names },
        ...(squareLabel !== undefined ? { squareLabel } : {}),
    });
    return ok({
        grid: layout.grid,
        legend: keyed && layout.legend !== undefined ? { ...layout.legend, data: names } : { show: false },
        xAxis: { ...valueAxis("x", valueAxisTitle(context.labels, fpr.value), { min: 0, max: 1 }), interval: RATE_STEP },
        yAxis: { ...valueAxis("y", valueAxisTitle(context.labels, tpr.value), { min: 0, max: 1 }), interval: RATE_STEP },
        series,
        media: layout.media,
    });
}

/**
 * The curves of one table: one for each group in the order of its first row. A row whose rate is not numeric
 * draws nothing, and a rate outside 0 to 1 refuses, because the axes hold 0 to 1 and a clip would hide it.
 * The sort is stable, thus two rows at one point keep the order of the table.
 */
function rocCurves(rows: readonly ChartRow[], fpr: string, tpr: string, group: string | undefined, blockId: string): Result<RocCurve[], RenderProblem> {
    const groupOf = (row: ChartRow): Cell => (group === undefined ? "" : (row[group] ?? ""));
    const names = firstAppearance(rows.map((row) => String(groupOf(row))));
    const byName = new Map<string, number[][]>(names.map((name) => [name, []]));
    for (const [index, row] of rows.entries()) {
        const x = toNumber(row[fpr]);
        const y = toNumber(row[tpr]);
        if (x === null || y === null) continue;
        for (const [value, column] of [
            [x, fpr],
            [y, tpr],
        ] as const) {
            if (value < 0 || value > 1) {
                return err(
                    chartProblem(blockId, `The roc figure reads rates between 0 and 1, and the row ${index + 1} holds ${value} in the "${column}" column.`),
                );
            }
        }
        byName.get(String(groupOf(row)))?.push([x, y]);
    }
    return ok(names.map((name) => ({ name, points: (byName.get(name) ?? []).sort((a, b) => a[0] - b[0] || a[1] - b[1]) })));
}
