/**
 * The Kaplan-Meier figure: the step curves, the step band, the censor ticks, the number-at-risk table, the
 * median lines, and the statistics text.
 *
 * The rows are an excerpt of the survival curve of the NCCTG lung table, by sex, as `survfit` gives it.
 */

import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import { deriveChartOption, type ChartInputs, type ChartRow, type EchartOption } from "../chart.js";
import { CHART_PALETTE } from "../design.js";
import { FIGURE_MODULES } from "./index.js";
import { KM_FIGURE } from "./km.js";

const HASH = `sha256:${"a".repeat(64)}`;

type Encoding = NonNullable<ChartBlock["encoding"]>;

const ENCODING: Encoding = { x: "time", y: "surv", group: "strata", low: "lower", high: "upper", censor: "n_censor", risk: "n_risk" };

/** One row of the curve table. */
function row(strata: string, time: number, surv: number, lower: number, upper: number, risk: number, censor: number): ChartRow {
    return { strata, time, surv, lower, upper, n_risk: risk, n_censor: censor };
}

const ROWS: ChartRow[] = [
    row("Female", 0, 1, 1, 1, 90, 0),
    row("Female", 5, 0.989, 0.924, 0.998, 90, 0),
    row("Female", 60, 0.978, 0.914, 0.994, 89, 0),
    row("Female", 371, 0.509, 0.386, 0.619, 30, 1),
    row("Female", 426, 0.489, 0.366, 0.602, 26, 3),
    row("Female", 765, 0.083, 0.019, 0.212, 3, 1),
    row("Male", 0, 1, 1, 1, 138, 0),
    row("Male", 11, 0.971, 0.924, 0.989, 138, 0),
    row("Male", 270, 0.494, 0.406, 0.576, 59, 0),
    row("Male", 883, 0.036, 0.009, 0.097, 3, 1),
];

/** A km block with the given encoding and extra members. */
function kmBlock(encoding: Encoding = ENCODING, extra: Partial<ChartBlock> = {}): ChartBlock {
    return { kind: "chart", id: "km1", binding: { kind: "artifact-table", path: "km_curve.csv", hash: HASH }, chartType: "km", encoding, ...extra };
}

/** The log-rank statistic of a block, bound to the p column of the test table. */
const LOGRANK: NonNullable<ChartBlock["statistics"]> = [
    { label: "Log-rank p", value: { kind: "artifact-value", path: "logrank.csv", hash: HASH, locator: { column: "pvalue", row: 0 } } },
];

/** Derive one km block through the figure module. */
function derive(block: ChartBlock, rows: readonly ChartRow[] = ROWS, inputs: ChartInputs = {}): EchartOption {
    return deriveChartOption(block, rows, undefined, inputs, { figures: { km: KM_FIGURE } })._unsafeUnwrap();
}

/** The refusal text of one km block. */
function refusal(block: ChartBlock, rows: readonly ChartRow[] = ROWS): string {
    return deriveChartOption(block, rows, undefined, {}, { figures: { km: KM_FIGURE } })._unsafeUnwrapErr().detail;
}

/** The series of one option. */
function seriesOf(option: EchartOption): EchartOption[] {
    return option.series as EchartOption[];
}

/** The series of one option that draw on the grid of the given index. */
function onGrid(option: EchartOption, grid: number): EchartOption[] {
    return seriesOf(option).filter((series) => (series.xAxisIndex ?? 0) === grid);
}

describe("the km figure", () => {
    it("registers for the km chart type", () => {
        expect(FIGURE_MODULES.km).toBe(KM_FIGURE);
    });

    it("draws each group as a step line from 1 at time 0, in the palette order", () => {
        const option = derive(kmBlock());
        const lines = seriesOf(option).filter(
            (series) => series.type === "line" && series.step === "end" && series.areaStyle === undefined && series.silent !== true,
        );
        expect(lines.map((series) => series.name)).toEqual(["Female", "Male"]);
        expect(lines[0].data).toEqual([
            [0, 1],
            [5, 0.989],
            [60, 0.978],
            [371, 0.509],
            [426, 0.489],
            [765, 0.083],
        ]);
        expect(lines.map((series) => (series.lineStyle as EchartOption).color)).toEqual([CHART_PALETTE[0], CHART_PALETTE[1]]);
    });

    it("starts a curve at 1 at time 0 where the table holds no row at time 0", () => {
        const option = derive(kmBlock({ x: "time", y: "surv" }), [
            { time: 5, surv: 0.9 },
            { time: 9, surv: 0.7 },
        ]);
        expect(seriesOf(option)[0].data).toEqual([
            [0, 1],
            [5, 0.9],
            [9, 0.7],
        ]);
    });

    it("draws the band between the two bounds as a step band under each curve", () => {
        const option = derive(kmBlock());
        const band = seriesOf(option).filter((series) => series.stack === "km-band-1");
        expect(band).toHaveLength(2);
        expect(band.every((series) => series.step === "end" && series.silent === true && series.name === "Male")).toBe(true);
        expect(band[0].data).toEqual([
            [0, 1],
            [11, 0.924],
            [270, 0.406],
            [883, 0.009],
        ]);
        expect((band[1].data as number[][]).map(([time, span]) => [time, Number(span.toFixed(3))])).toEqual([
            [0, 0],
            [11, 0.065],
            [270, 0.17],
            [883, 0.088],
        ]);
        expect(band[1].areaStyle).toEqual({ color: CHART_PALETTE[1], opacity: 0.2 });
    });

    it("carries a tick on the curve at each row whose censor count is above zero", () => {
        const option = derive(kmBlock());
        const ticks = seriesOf(option).filter((series) => series.type === "scatter" && (series.xAxisIndex ?? 0) === 0);
        expect(ticks.map((series) => [series.name, series.symbol, series.data])).toEqual([
            [
                "Female",
                "rect",
                [
                    [371, 0.509],
                    [426, 0.489],
                    [765, 0.083],
                ],
            ],
            ["Male", "rect", [[883, 0.036]]],
        ]);
    });

    it("prints the number at risk under the plot at each tick of the time axis", () => {
        const option = derive(kmBlock());
        const xAxes = option.xAxis as EchartOption[];
        expect([xAxes[0].min, xAxes[0].max, xAxes[0].interval]).toEqual([0, 883, 200]);
        expect([xAxes[1].min, xAxes[1].max, xAxes[1].interval]).toEqual([0, 883, 200]);
        // The axis ends at the last time, and a label there would crowd the tick at 800.
        expect(xAxes[0].axisLabel).toEqual({ showMaxLabel: false, interval: 0 });
        expect((option.graphic as EchartOption[]).map((element) => (element.style as EchartOption).text)).toEqual(["Number at risk"]);
        const table = (option.yAxis as EchartOption[])[1];
        expect(table.inverse).toBe(true);
        expect(table.data).toEqual([
            { value: "Female", textStyle: { color: CHART_PALETTE[0] } },
            { value: "Male", textStyle: { color: CHART_PALETTE[1] } },
        ]);
        // The risk of the first row at or after each tick, and 0 past the last row of the group.
        const counts = onGrid(option, 1).map((series) => (series.data as EchartOption[]).map((item) => [item.value, item.name]));
        expect(counts).toEqual([
            [
                [[0, 0], "90"],
                [[200, 0], "30"],
                [[400, 0], "26"],
                [[600, 0], "3"],
                [[800, 0], "0"],
            ],
            [
                [[0, 1], "138"],
                [[200, 1], "59"],
                [[400, 1], "3"],
                [[600, 1], "3"],
                [[800, 1], "3"],
            ],
        ]);
    });

    it("draws no table where the block names no risk channel", () => {
        const { risk: _risk, ...encoding } = ENCODING;
        const option = derive(kmBlock(encoding));
        expect(Array.isArray(option.grid)).toBe(false);
        expect(onGrid(option, 1)).toEqual([]);
    });

    it("draws the median line at 0.5 to each curve that crosses it", () => {
        const option = derive(kmBlock());
        const median = seriesOf(option).find((series) => series.markLine !== undefined);
        const markLine = median?.markLine as EchartOption;
        expect(markLine.lineStyle).toEqual({ color: "#8c8c8c", width: 1, type: "dashed" });
        expect(markLine.data).toEqual([
            [{ coord: [0, 0.5] }, { coord: [426, 0.5] }],
            [{ coord: [426, 0.5] }, { coord: [426, 0] }],
            [{ coord: [270, 0.5] }, { coord: [270, 0] }],
        ]);
    });

    it("draws no median line where no curve crosses 0.5", () => {
        const option = derive(kmBlock({ x: "time", y: "surv", group: "arm" }), [
            { arm: "A", time: 0, surv: 1 },
            { arm: "A", time: 10, surv: 0.8 },
        ]);
        expect(seriesOf(option).some((series) => series.markLine !== undefined)).toBe(false);
    });

    it("prints the statistics at the top right of the plot", () => {
        const option = derive(kmBlock(ENCODING, { statistics: LOGRANK }), ROWS, { statistics: [{ label: "Log-rank p", value: 0.00131116452035549 }] });
        const [text, title] = option.graphic as EchartOption[];
        expect([text.right, text.top, (text.style as EchartOption).text]).toEqual(["7%", "12%", "Log-rank p = 1.3 × 10⁻³"]);
        expect((title.style as EchartOption).text).toBe("Number at risk");
    });

    it("holds the survival axis from 0 to 1", () => {
        const option = derive(kmBlock());
        const survival = (option.yAxis as EchartOption[])[0];
        expect([survival.type, survival.min, survival.max, survival.name]).toEqual(["value", 0, 1, "surv"]);
    });

    it("shows the legend at the top for two groups, and no legend for one curve", () => {
        expect((derive(kmBlock()).legend as EchartOption).top).toBe(0);
        const single = derive(kmBlock({ x: "time", y: "surv", risk: "n_risk" }), ROWS.slice(0, 6));
        expect(single.legend).toEqual({ show: false });
        expect((single.yAxis as EchartOption[])[1].data).toEqual([{ value: "", textStyle: { color: CHART_PALETTE[0] } }]);
    });
});

describe("the refusals of the km figure", () => {
    it("names an absent time channel", () => {
        expect(refusal(kmBlock({ y: "surv" }))).toBe('The km figure needs a column for the "x" channel.');
    });

    it("refuses a transform on a channel that the figure reads as it is", () => {
        expect(refusal(kmBlock({ ...ENCODING, y: { column: "surv", transform: "log10" } }))).toBe(
            'The km figure reads the "y" channel as a plain column, thus it takes no transform and no order.',
        );
    });

    it("refuses a column that no row holds", () => {
        expect(refusal(kmBlock({ ...ENCODING, censor: "n_censored" }))).toBe('The column "n_censored" is absent from every row.');
    });

    it("refuses a survival outside 0 to 1", () => {
        expect(refusal(kmBlock({ x: "time", y: "surv" }), [{ time: 0, surv: 100 }])).toBe(
            'The km figure reads a survival between 0 and 1, and the row 1 holds 100 in the "surv" column.',
        );
    });

    it("refuses a bound on the wrong side of the survival", () => {
        const rows = [row("Female", 0, 1, 1, 1, 90, 0), row("Female", 5, 0.9, 0.95, 0.99, 90, 0)];
        expect(refusal(kmBlock(), rows)).toBe(
            'The row 2 holds the interval from 0.95 to 0.99 around the survival 0.9. The "low" bound sits at or under the survival, and the "high" bound sits at or over it.',
        );
    });

    it("refuses a channel that the figure does not read", () => {
        expect(refusal(kmBlock({ ...ENCODING, label: "strata" }))).toBe('The km chart takes no "label" channel.');
    });
});
