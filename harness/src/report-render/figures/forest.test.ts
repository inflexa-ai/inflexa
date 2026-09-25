/**
 * The forest figure: the rows in table order, the log axis at nice ratios, the line at no effect, the squares,
 * the interval lines, and the two text columns.
 *
 * The rows are the Cox model of the NCCTG lung table: one hazard ratio for each covariate.
 */

import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import { deriveChartOption, type ChartRow, type EchartOption } from "../chart.js";
import { CHART_INK, GUIDE_LINE_COLOR } from "../design.js";
import { FOREST_FIGURE, termLines } from "./forest.js";
import { FIGURE_MODULES } from "./index.js";

const HASH = `sha256:${"a".repeat(64)}`;

type Encoding = NonNullable<ChartBlock["encoding"]>;

const ENCODING: Encoding = { y: "term", x: "hr", low: "lower", high: "upper", p: "pvalue" };

const ROWS: ChartRow[] = [
    { term: "Age (per year)", hr: 1.0152725322439, lower: 0.99603004960191, upper: 1.03488676384906, pvalue: 0.120538258209777, n: 213 },
    { term: "Female vs male", hr: 0.531834967483113, lower: 0.375837377499962, upper: 0.752581966485737, pvalue: 0.00036433764194166, n: 213 },
    { term: "ECOG performance score", hr: 2.09636398838477, lower: 1.44080207397493, upper: 3.05020519554927, pvalue: 0.000109424049741189, n: 213 },
    { term: "Karnofsky score (physician)", hr: 1.01536757487862, lower: 0.996056535985802, upper: 1.03505300639841, pvalue: 0.119552522237802, n: 213 },
    { term: "Weight loss (lb)", hr: 0.990745350649488, lower: 0.977821803396287, upper: 1.00383970415085, pvalue: 0.165167923804808, n: 213 },
];

const TERMS = ["Age (per year)", "Female vs male", "ECOG performance score", "Karnofsky score (physician)", "Weight loss (lb)"];

/** A forest block with the given encoding. */
function forestBlock(encoding: Encoding = ENCODING): ChartBlock {
    return { kind: "chart", id: "f1", binding: { kind: "artifact-table", path: "cox_forest.csv", hash: HASH }, chartType: "forest", encoding };
}

/** Derive one forest block through the figure module. */
function derive(block: ChartBlock, rows: readonly ChartRow[] = ROWS): EchartOption {
    return deriveChartOption(block, rows, undefined, {}, { figures: { forest: FOREST_FIGURE } })._unsafeUnwrap();
}

/** The refusal text of one forest block. */
function refusal(block: ChartBlock, rows: readonly ChartRow[] = ROWS): string {
    return deriveChartOption(block, rows, undefined, {}, { figures: { forest: FOREST_FIGURE } })._unsafeUnwrapErr().detail;
}

/** The series of one option. */
function seriesOf(option: EchartOption): EchartOption[] {
    return option.series as EchartOption[];
}

/** The y axes of one option. */
function yAxes(option: EchartOption): EchartOption[] {
    return option.yAxis as EchartOption[];
}

describe("the forest figure", () => {
    it("registers for the forest chart type", () => {
        expect(FIGURE_MODULES.forest).toBe(FOREST_FIGURE);
    });

    it("reads the rows top-down in table order", () => {
        const terms = yAxes(derive(forestBlock()))[0];
        expect([terms.type, terms.inverse, terms.data]).toEqual(["category", true, TERMS.map(termLines)]);
    });

    it("sorts the rows by the order of the term channel", () => {
        const option = derive(forestBlock({ ...ENCODING, y: { column: "term", orderBy: "hr", order: "desc" } }));
        expect(yAxes(option)[0].data).toEqual([
            "ECOG performance\nscore",
            "Karnofsky score\n(physician)",
            "Age (per year)",
            "Weight loss (lb)",
            "Female vs male",
        ]);
        expect(yAxes(option)[1].data).toEqual(["2.10 (1.44–3.05)", "1.02 (1.00–1.04)", "1.02 (1.00–1.03)", "0.99 (0.98–1.00)", "0.53 (0.38–0.75)"]);
    });

    it("draws a log axis that ends at the nice ratios just past the data", () => {
        const axis = derive(forestBlock()).xAxis as EchartOption;
        expect([axis.type, axis.min, axis.max, axis.name]).toEqual(["log", 0.25, 4, "hr"]);
    });

    it("holds 1 inside the log axis where every interval lies on one side of it", () => {
        const axis = derive(forestBlock(), [{ term: "a", hr: 3, lower: 2.2, upper: 4.5, pvalue: 0.01 }]).xAxis as EchartOption;
        expect([axis.min, axis.max]).toEqual([1, 5]);
    });

    it("draws a linear axis with the line at zero where a value is not positive", () => {
        const rows = [
            { term: "a", hr: -0.4, lower: -0.9, upper: 0.1, pvalue: 0.2 },
            { term: "b", hr: 0.3, lower: 0.1, upper: 0.5, pvalue: 0.01 },
        ];
        const option = derive(forestBlock(), rows);
        const axis = option.xAxis as EchartOption;
        expect([axis.type, axis.scale]).toEqual(["value", true]);
        const line = seriesOf(option).find((series) => series.markLine !== undefined)?.markLine as EchartOption;
        expect(line.data).toEqual([{ xAxis: 0 }]);
    });

    it("draws a solid gray line at 1", () => {
        const line = seriesOf(derive(forestBlock())).find((series) => series.markLine !== undefined)?.markLine as EchartOption;
        expect(line.lineStyle).toEqual({ color: GUIDE_LINE_COLOR, width: 1, type: "solid" });
        expect(line.data).toEqual([{ xAxis: 1 }]);
        expect(line.label).toEqual({ show: false });
    });

    it("draws each estimate as a square on its row", () => {
        const squares = seriesOf(derive(forestBlock())).find((series) => series.type === "scatter") as EchartOption;
        expect([squares.symbol, (squares.itemStyle as EchartOption).color]).toEqual(["rect", CHART_INK]);
        expect((squares.data as EchartOption[]).map((item) => [item.value, item.symbolSize])).toEqual([
            [[1.0152725322439, 0], 9],
            [[0.531834967483113, 1], 9],
            [[2.09636398838477, 2], 9],
            [[1.01536757487862, 3], 9],
            [[0.990745350649488, 4], 9],
        ]);
    });

    it("sizes each square by the size channel, with the area in proportion to the value", () => {
        const rows = ROWS.slice(0, 2).map((row, index) => ({ ...row, weight: index === 0 ? 100 : 25 }));
        const squares = seriesOf(derive(forestBlock({ ...ENCODING, size: "weight" }), rows)).find((series) => series.type === "scatter") as EchartOption;
        expect((squares.data as EchartOption[]).map((item) => item.symbolSize)).toEqual([16, 8]);
    });

    it("draws the interval of each row as a line along the x axis", () => {
        const interval = seriesOf(derive(forestBlock())).find((series) => series.type === "custom") as EchartOption;
        expect([interval.renderItem, interval.encode]).toEqual(["interval", { x: [0, 2, 3], y: 1 }]);
        expect((interval.data as number[][])[1]).toEqual([0.531834967483113, 1, 0.375837377499962, 0.752581966485737, 0, 0, 0]);
    });

    it("prints the estimate with its interval and the p value in two columns at the right", () => {
        const [, estimates, pValues] = yAxes(derive(forestBlock()));
        expect([estimates.position, estimates.inverse, estimates.name, estimates.data]).toEqual([
            "right",
            true,
            "hr",
            ["1.02 (1.00–1.03)", "0.53 (0.38–0.75)", "2.10 (1.44–3.05)", "1.02 (1.00–1.04)", "0.99 (0.98–1.00)"],
        ]);
        expect([pValues.position, pValues.name, pValues.data]).toEqual(["right", "pvalue", ["0.121", "3.6 × 10⁻⁴", "1.1 × 10⁻⁴", "0.12", "0.165"]]);
    });

    it("formats the p channel as a p-value whatever its column name, and prints a stored zero as a bound", () => {
        const rows = ROWS.map((row, index) => ({ ...row, wald: index === 0 ? 0 : row.pvalue }));
        const [, , pValues] = yAxes(derive(forestBlock({ ...ENCODING, p: "wald" }), rows));
        // The smallest positive value of the column bounds the stored zero.
        expect(pValues.data).toEqual(["<2 × 10⁻⁴", "3.6 × 10⁻⁴", "1.1 × 10⁻⁴", "0.12", "0.165"]);
    });

    it("prints a row whose smallest value sits under 0.1 with two significant digits on that value", () => {
        const [, estimates] = yAxes(derive(forestBlock(), [{ term: "a", hr: 0.052, lower: 0.0123, upper: 0.23, pvalue: 0.01 }]));
        expect(estimates.data).toEqual(["0.052 (0.012–0.230)"]);
    });

    it("prints a difference with the typographic minus, and joins a negative bound with the word to", () => {
        const rows = [
            { term: "a", hr: -0.4, lower: -0.9, upper: 0.1, pvalue: 0.2 },
            { term: "b", hr: 0.3, lower: 0.1, upper: 0.5, pvalue: 0.01 },
        ];
        expect(yAxes(derive(forestBlock(), rows))[1].data).toEqual(["−0.40 (−0.90 to 0.10)", "0.30 (0.10–0.50)"]);
    });

    it("breaks a long term into two lines at most, and names the whole term of each square for the tooltip", () => {
        const option = derive(forestBlock());
        expect(yAxes(option)[0].data).toEqual([
            "Age (per year)",
            "Female vs male",
            "ECOG performance\nscore",
            "Karnofsky score\n(physician)",
            "Weight loss (lb)",
        ]);
        const squares = seriesOf(option).find((series) => series.type === "scatter") as EchartOption;
        expect((squares.data as EchartOption[]).map((item) => item.name)).toEqual(TERMS);
    });

    it("ends a term past two lines with an ellipsis", () => {
        expect(termLines("Tumor stage III or IV versus stage I or II")).toBe("Tumor stage III or\nIV versus stage I…");
        expect(termLines("Radiotherapy")).toBe("Radiotherapy");
    });

    it("prints no p column where the block names no p channel", () => {
        const { p: _p, ...encoding } = ENCODING;
        expect(yAxes(derive(forestBlock(encoding)))).toHaveLength(2);
    });

    it("prints the declared labels in the column titles", () => {
        const block = forestBlock();
        const labeled: ChartBlock = { ...block, binding: { ...block.binding, columnLabels: { hr: "Hazard ratio", pvalue: "p" } } };
        const [, estimates, pValues] = yAxes(derive(labeled));
        expect([estimates.name, pValues.name, (derive(labeled).xAxis as EchartOption).name]).toEqual(["Hazard ratio", "p", "Hazard ratio"]);
    });
});

describe("the refusals of the forest figure", () => {
    it("names an absent term channel", () => {
        expect(refusal(forestBlock({ x: "hr" }))).toBe('The forest figure needs a column for the "y" channel.');
    });

    it("refuses a term that holds two rows", () => {
        expect(refusal(forestBlock(), [ROWS[0], ROWS[0]])).toBe('The forest figure draws one row for each term, and the term "Age (per year)" holds two rows.');
    });

    it("refuses a bound on the wrong side of the estimate", () => {
        expect(refusal(forestBlock(), [{ term: "a", hr: 0.5, lower: 0.6, upper: 0.9, pvalue: 0.1 }])).toBe(
            'The row 1 holds the interval from 0.6 to 0.9 around the estimate 0.5. The "low" bound sits at or under the estimate, and the "high" bound sits at or over it.',
        );
    });

    it("refuses a transform on the estimate", () => {
        expect(refusal(forestBlock({ ...ENCODING, x: { column: "hr", transform: "log10" } }))).toBe(
            'The forest figure reads the "x" channel as a plain column, thus it takes no transform and no order.',
        );
    });
});
