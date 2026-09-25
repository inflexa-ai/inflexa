/**
 * The ROC figure: the empirical curve of each group, the chance diagonal, the two axes from 0 to 1, and the
 * statistics text.
 *
 * The rows are an excerpt of the ROC table of the NCCTG lung data: two logistic models of death within one
 * year, one row for each distinct predicted score.
 */

import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import { deriveChartOption, type ChartInputs, type ChartRow, type EchartOption } from "../chart.js";
import { CHART_PALETTE, GUIDE_LINE_COLOR } from "../design.js";
import { FIGURE_MODULES } from "./index.js";
import { ROC_FIGURE } from "./roc.js";

const HASH = `sha256:${"a".repeat(64)}`;

type Encoding = NonNullable<ChartBlock["encoding"]>;

const ENCODING: Encoding = { x: "fpr", y: "tpr", group: "model" };

const FULL = "ECOG + Karnofsky + age";
const ALONE = "ECOG alone";

const ROWS: ChartRow[] = [
    { fpr: 0, tpr: 0, model: FULL },
    { fpr: 0.0154, tpr: 0.0168, model: FULL },
    { fpr: 0, tpr: 0.0084, model: FULL },
    { fpr: 0.4, tpr: 0.62, model: FULL },
    { fpr: 1, tpr: 1, model: FULL },
    { fpr: 0, tpr: 0, model: ALONE },
    { fpr: 0, tpr: 0.0083, model: ALONE },
    { fpr: 0.1385, tpr: 0.3167, model: ALONE },
    { fpr: 0.6615, tpr: 0.8, model: ALONE },
    { fpr: 1, tpr: 1, model: ALONE },
];

/** An AUC statistic of a block, bound to one row of the AUC table. */
function auc(label: string, row: number): NonNullable<ChartBlock["statistics"]>[number] {
    return { label, value: { kind: "artifact-value", path: "roc_auc.csv", hash: HASH, locator: { column: "auc", row } } };
}

/** A roc block with the given encoding and extra members. */
function rocBlock(encoding: Encoding = ENCODING, extra: Partial<ChartBlock> = {}): ChartBlock {
    return { kind: "chart", id: "r1", binding: { kind: "artifact-table", path: "roc.csv", hash: HASH }, chartType: "roc", encoding, ...extra };
}

/** Derive one roc block through the figure module. */
function derive(block: ChartBlock, rows: readonly ChartRow[] = ROWS, inputs: ChartInputs = {}): EchartOption {
    return deriveChartOption(block, rows, undefined, inputs, { figures: { roc: ROC_FIGURE } })._unsafeUnwrap();
}

/** The refusal text of one roc block. */
function refusal(block: ChartBlock, rows: readonly ChartRow[] = ROWS): string {
    return deriveChartOption(block, rows, undefined, {}, { figures: { roc: ROC_FIGURE } })._unsafeUnwrapErr().detail;
}

/** The series of one option. */
function seriesOf(option: EchartOption): EchartOption[] {
    return option.series as EchartOption[];
}

describe("the roc figure", () => {
    it("registers for the roc chart type", () => {
        expect(FIGURE_MODULES.roc).toBe(ROC_FIGURE);
    });

    it("draws each group as its empirical curve, through its points in order of the false positive rate", () => {
        const curves = seriesOf(derive(rocBlock())).filter((series) => series.name !== undefined);
        expect(curves.map((series) => [series.name, series.type, series.step, (series.lineStyle as EchartOption).color])).toEqual([
            [FULL, "line", undefined, CHART_PALETTE[0]],
            [ALONE, "line", undefined, CHART_PALETTE[1]],
        ]);
        // The two points at a false positive rate of 0 sort by the true positive rate, thus the curve rises first.
        expect(curves[0].data).toEqual([
            [0, 0],
            [0, 0.0084],
            [0.0154, 0.0168],
            [0.4, 0.62],
            [1, 1],
        ]);
    });

    it("marks chance with a dashed diagonal from 0 to 1", () => {
        const chance = seriesOf(derive(rocBlock())).find((series) => series.markLine !== undefined)?.markLine as EchartOption;
        expect(chance.lineStyle).toEqual({ color: GUIDE_LINE_COLOR, width: 1, type: "dashed" });
        expect(chance.data).toEqual([[{ coord: [0, 0] }, { coord: [1, 1] }]]);
    });

    it("holds both axes from 0 to 1 with one tick step", () => {
        const option = derive(rocBlock());
        const x = option.xAxis as EchartOption;
        const y = option.yAxis as EchartOption;
        expect([x.min, x.max, x.interval, x.name]).toEqual([0, 1, 0.2, "fpr"]);
        expect([y.min, y.max, y.interval, y.name]).toEqual([0, 1, 0.2, "tpr"]);
    });

    it("prints one AUC for each curve at the bottom right of the plot", () => {
        const block = rocBlock(ENCODING, { statistics: [auc(`AUC, ${FULL}`, 0), auc(`AUC, ${ALONE}`, 1)] });
        const option = derive(block, ROWS, {
            statistics: [
                { label: `AUC, ${FULL}`, value: 0.626761473820297 },
                { label: `AUC, ${ALONE}`, value: 0.619166666666667 },
            ],
        });
        // The text is the label of a point at the corner (1, 0) of the data, thus it stays in the corner of the
        // square in every container.
        const text = seriesOf(option).find((series) => series.symbolSize === 0);
        const label = text?.label as EchartOption;
        expect(text?.data).toEqual([{ value: [1, 0], name: `AUC, ${FULL} = 0.627\nAUC, ${ALONE} = 0.619` }]);
        expect([label.formatter, label.align, label.verticalAlign]).toEqual(["{b}", "right", "bottom"]);
        expect(option.graphic).toBeUndefined();
        // Each square breaks the text into lines inside its width less the insets.
        const place = seriesOf(option).indexOf(text as EchartOption);
        for (const rule of option.media as EchartOption[]) {
            const placed = rule.option as EchartOption;
            const side = (placed.grid as EchartOption[])[0].width as number;
            expect((placed.series as EchartOption[])[place].label as EchartOption).toEqual({ width: side - 16, overflow: "break" });
        }
    });

    it("draws one unit on x equal to one unit on y: a square grid, with the legend in a band under it", () => {
        const option = derive(rocBlock());
        const grid = (option.grid as EchartOption[])[0];
        expect(grid.width).toBe(grid.height);
        const legend = option.legend as EchartOption;
        expect(legend.left).toBe(grid.left);
        expect(legend.top as number).toBeGreaterThan((grid.top as number) + (grid.height as number));
        const rules = option.media as EchartOption[];
        for (const rule of rules) {
            const placed = ((rule.option as EchartOption).grid as EchartOption[])[0];
            expect(placed.width).toBe(placed.height);
        }
    });

    it("shows no legend for one curve", () => {
        const option = derive(rocBlock({ x: "fpr", y: "tpr" }), ROWS.slice(0, 5));
        expect(option.legend).toEqual({ show: false });
    });
});

describe("the refusals of the roc figure", () => {
    it("names an absent true positive rate channel", () => {
        expect(refusal(rocBlock({ x: "fpr" }))).toBe('The roc figure needs a column for the "y" channel.');
    });

    it("refuses a rate outside 0 to 1", () => {
        expect(refusal(rocBlock(), [{ fpr: 0, tpr: 12, model: FULL }])).toBe(
            'The roc figure reads rates between 0 and 1, and the row 1 holds 12 in the "tpr" column.',
        );
    });

    it("refuses a channel that the figure does not read", () => {
        expect(refusal(rocBlock({ ...ENCODING, label: "model" }))).toBe('The roc chart takes no "label" channel.');
    });
});
