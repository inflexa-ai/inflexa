/**
 * The QQ figure: the small points over the light band of the null expectation, the identity line, the range
 * of each axis, and the genomic inflation λ in the top left corner.
 */

import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import {
    CHART_SOURCE_MEMBER,
    deriveChartOption,
    deriveChartRender,
    type ChartDataSource,
    type ChartInputs,
    type ChartOpts,
    type ChartRow,
    type EchartOption,
} from "../chart.js";
import { CHART_INLINE_OPTION_BOUND } from "../design.js";
import { BELOW_RESOLUTION_SYMBOL } from "./dense.js";
import { FIGURE_MODULES } from "./index.js";
import { QQ_BAND_POINTS, QQ_FIGURE, QQ_POINT_PX } from "./qq.js";

type Encoding = NonNullable<ChartBlock["encoding"]>;

const HASH = `sha256:${"e".repeat(64)}`;
const OPTS: ChartOpts = { figures: { qq: QQ_FIGURE } };
const ENCODING: Encoding = { x: "expected_neg_log10_p", y: "observed_neg_log10_p", low: "ci_lower", high: "ci_upper" };

const LAMBDA: NonNullable<ChartBlock["statistics"]>[number] = {
    label: "λ",
    value: { kind: "artifact-value", path: "gwas/summary.csv", hash: HASH, locator: { column: "lambda_gc", row: 0 } },
};

function block(encoding: Encoding = ENCODING, extra: Partial<ChartBlock> = {}): ChartBlock {
    return {
        kind: "chart",
        id: "q1",
        binding: { kind: "artifact-table", path: "gwas/qq.csv", hash: HASH },
        chartType: "qq",
        encoding,
        ...extra,
    };
}

/** An excerpt of the QQ table of the BMI GWAS, in the order of the file: the expected p rises down the rows. */
const ROWS: ChartRow[] = [
    { expected_neg_log10_p: "0.0", observed_neg_log10_p: "-0.0", ci_lower: "0.0", ci_upper: "0.0" },
    { expected_neg_log10_p: "0.3", observed_neg_log10_p: "0.31", ci_lower: "0.28", ci_upper: "0.33" },
    { expected_neg_log10_p: "1.0", observed_neg_log10_p: "1.1", ci_lower: "0.95", ci_upper: "1.06" },
    { expected_neg_log10_p: "2.0", observed_neg_log10_p: "2.4", ci_lower: "1.9", ci_upper: "2.12" },
    { expected_neg_log10_p: "4.0", observed_neg_log10_p: "5.6", ci_lower: "3.6", ci_upper: "4.5" },
    { expected_neg_log10_p: "6.4", observed_neg_log10_p: "", ci_lower: "5.5", ci_upper: "7.6" },
    { expected_neg_log10_p: "6.41", observed_neg_log10_p: "19.3", ci_lower: "5.52", ci_upper: "7.61" },
];

function derive(chartBlock: ChartBlock = block(), rows: readonly ChartRow[] = ROWS, inputs: ChartInputs = {}): EchartOption {
    return deriveChartOption(chartBlock, rows, undefined, inputs, OPTS)._unsafeUnwrap();
}

function seriesOf(option: EchartOption): EchartOption[] {
    return option.series as EchartOption[];
}

describe("the QQ figure", () => {
    it("registers in the figure registry", () => {
        expect(FIGURE_MODULES.qq).toBe(QQ_FIGURE);
    });

    it("draws small points, with no legend", () => {
        const option = derive();
        const points = seriesOf(option)[0];
        expect(points.type).toBe("scatter");
        expect(points.symbolSize).toBe(QQ_POINT_PX);
        expect(option.legend).toEqual({ show: false });
    });

    it("draws the band between the two bounds in light gray under the points", () => {
        const [points, lower, upper] = seriesOf(derive());
        expect(lower.stack).toBe(upper.stack);
        expect((lower.lineStyle as EchartOption).opacity).toBe(0);
        expect(upper.areaStyle).toBeDefined();
        expect(lower.z as number).toBeLessThan((points.z as number | undefined) ?? 2);
        expect(upper.z as number).toBeLessThan((points.z as number | undefined) ?? 2);
        // The band reads each row with both bounds, whether or not the row draws a point.
        expect(lower.data).toEqual([
            [0, 0],
            [0.3, 0.28],
            [1, 0.95],
            [2, 1.9],
            [4, 3.6],
            [6.4, 5.5],
            [6.41, 5.52],
        ]);
        expect((upper.data as number[][]).map(([x, width]) => [x, Number(width.toFixed(6))])).toEqual([
            [0, 0],
            [0.3, 0.05],
            [1, 0.11],
            [2, 0.22],
            [4, 0.9],
            [6.4, 2.1],
            [6.41, 2.09],
        ]);
    });

    it("draws the identity line to the largest expected value, and gives each axis its own range", () => {
        const option = derive();
        const identity = (seriesOf(option)[0].markLine as EchartOption).data as EchartOption[][];
        expect(identity).toEqual([[{ coord: [0, 0] }, { coord: [6.41, 6.41] }]]);
        const x = option.xAxis as EchartOption;
        const y = option.yAxis as EchartOption;
        // The x axis ends past the largest expected value, and the y axis past the largest observed value.
        expect([x.min, x.max]).toEqual([0, 8]);
        expect([y.min, y.max]).toEqual([0, 20]);
    });

    it("keeps the identity line and the band inside the y axis when the observed values stay low", () => {
        const deflated = ROWS.map((row) => ({ ...row, observed_neg_log10_p: "0.5" }));
        const y = derive(block(), deflated).yAxis as EchartOption;
        expect(y.max).toBe(8);
    });

    it("prints the statistics in the top left corner", () => {
        const option = derive(block(ENCODING, { statistics: [LAMBDA] }), ROWS, { statistics: [{ label: "λ", value: 1.111615383472537 }] });
        const [text] = option.graphic as EchartOption[];
        expect((text.style as EchartOption).text).toBe("λ = 1.11");
        expect(text.left).toBeDefined();
        expect(text.top).toBeDefined();
    });

    it("draws no band where the block names no bounds", () => {
        const option = derive(block({ x: "expected_neg_log10_p", y: "observed_neg_log10_p" }));
        expect(seriesOf(option).length).toBe(1);
    });

    it("draws a stored zero of a transformed p at the top of the observed range as an upward triangle", () => {
        const rows: ChartRow[] = [
            { expected: "1", p: "0.1" },
            { expected: "2", p: "0.001" },
            { expected: "3", p: "0" },
        ];
        const option = derive(block({ x: "expected", y: { column: "p", transform: "neg_log10" } }), rows);
        const triangles = seriesOf(option).filter((entry) => entry.symbol === BELOW_RESOLUTION_SYMBOL);
        expect(triangles.length).toBe(1);
        expect(triangles[0].data).toEqual([[3, 3]]);
        expect((option.yAxis as EchartOption).max as number).toBeGreaterThanOrEqual(3);
    });

    it("thins the band to at most 400 rows, the two ends included", () => {
        // A uniform table of 4,001 expected values, and a second row at the last value.
        const rows: ChartRow[] = [];
        for (let index = 0; index <= 4000; index += 1) {
            rows.push({ expected_neg_log10_p: String(index / 10), observed_neg_log10_p: String(index / 10), ci_lower: "0", ci_upper: "1" });
        }
        rows.push({ expected_neg_log10_p: "400", observed_neg_log10_p: "400", ci_lower: "0", ci_upper: "1" });
        const lower = seriesOf(derive(block(), rows))[1];
        const xs = (lower.data as number[][]).map(([x]) => x);
        expect(QQ_BAND_POINTS).toBe(400);
        expect(xs.length).toBeLessThanOrEqual(QQ_BAND_POINTS);
        expect(xs[0]).toBe(0);
        expect(xs.at(-1)).toBe(400);
    });

    it("derives the same bytes two times", () => {
        expect(JSON.stringify(derive())).toBe(JSON.stringify(derive()));
    });
});

describe("the dense QQ plot", () => {
    const COLUMNS = ["expected_neg_log10_p", "observed_neg_log10_p", "ci_lower", "ci_upper"];

    /** A QQ table of `count` p-values under a mild inflation, in the order of the file. */
    function denseRows(count: number): ChartRow[] {
        const rows: ChartRow[] = [];
        for (let rank = count; rank >= 1; rank -= 1) {
            const expected = -Math.log10(rank / (count + 1));
            rows.push({
                expected_neg_log10_p: expected.toFixed(4),
                observed_neg_log10_p: (expected * 1.1).toFixed(4),
                ci_lower: (expected * 0.95).toFixed(4),
                ci_upper: (expected * 1.05 + 0.01).toFixed(4),
            });
        }
        return rows;
    }

    it("reads the points from the payload, and keeps the thinned band inline", () => {
        const rows = denseRows(20000);
        const render = deriveChartRender(block(), rows, COLUMNS, { key: "qq", columns: COLUMNS }, {}, OPTS)._unsafeUnwrap();
        expect(JSON.stringify(render.inline).length).toBeGreaterThan(CHART_INLINE_OPTION_BOUND);
        expect(render.readsPayload).toBe(true);
        const source = render.option[CHART_SOURCE_MEMBER] as ChartDataSource;
        expect(source.series.length).toBe(1);
        const [points, lower, upper] = seriesOf(render.option);
        expect(points.data).toEqual([]);
        // The band holds a width that no cell gives, thus it rides the page option, thinned along the axis.
        expect((lower.data as unknown[]).length).toBeLessThanOrEqual(QQ_BAND_POINTS + 1);
        expect((lower.data as unknown[]).length).toBeGreaterThan(QQ_BAND_POINTS / 2);
        expect(upper.data).toEqual(seriesOf(render.inline)[2].data);
        expect(JSON.stringify(render.option).length).toBeLessThan(CHART_INLINE_OPTION_BOUND);
    });
});
