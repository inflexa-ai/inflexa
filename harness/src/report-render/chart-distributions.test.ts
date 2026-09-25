/**
 * The points of a box and of a violin, and the facet of the two stacked bars.
 *
 * The rows are excerpts of the gallery: the QC columns of PBMC 3k by cluster, and the cell-type composition of
 * the Kang IFN-β data by donor and condition.
 */

import { describe, expect, it } from "bun:test";
import * as echarts from "echarts";

import type { ChartBlock } from "../contracts/report-blocks.js";
import { deriveChartOption, type ChartRow, type EchartOption } from "./chart.js";
import { renderChartSvg } from "./chart-export.js";
import { CHART_EXPORT_SIZES, CHART_INK } from "./design.js";

type Encoding = NonNullable<ChartBlock["encoding"]>;
type ChartType = NonNullable<ChartBlock["chartType"]>;

const HASH = `sha256:${"a".repeat(64)}`;

function block(chartType: ChartType, encoding: Encoding, extra: Partial<ChartBlock> = {}): ChartBlock {
    return { kind: "chart", id: "c1", binding: { kind: "artifact-table", path: "t.csv", hash: HASH }, chartType, encoding, ...extra };
}

/** `count` cells of one cluster, with a percent of mitochondrial counts that walks a fixed sequence. */
function cells(cluster: string, count: number, group?: string): ChartRow[] {
    return Array.from({ length: count }, (_value, index) => ({
        cluster,
        pct_counts_mt: Number((1 + ((index * 37) % 50) / 10).toFixed(2)),
        ...(group !== undefined ? { sample: group } : {}),
    }));
}

/** A small cluster and a cluster past the point limit. */
const QC_ROWS: ChartRow[] = [...cells("Megakaryocytes", 15), ...cells("CD4 T", 201)];

function seriesOf(option: EchartOption): EchartOption[] {
    return option.series as EchartOption[];
}

function pointsOf(option: EchartOption): number[][] {
    const points = seriesOf(option).find((entry) => entry.type === "scatter" && entry.silent === true);
    return (points?.data ?? []) as number[][];
}

describe("the points of a box and of a violin", () => {
    for (const chartType of ["box", "violin"] as const) {
        it(`draws each value of every ${chartType} category as a jittered point where each category holds 200 values or fewer`, () => {
            const rows = [...cells("Megakaryocytes", 15), ...cells("CD4 T", 200)];
            const option = deriveChartOption(block(chartType, { x: "cluster", y: "pct_counts_mt" }), rows)._unsafeUnwrap();
            const points = pointsOf(option);
            expect(points).toHaveLength(215);
            expect(points.filter((point) => point[0] === 0)).toHaveLength(15);
            expect(points.filter((point) => point[0] === 1)).toHaveLength(200);
            expect(option.xAxis).toEqual(expect.objectContaining({ jitter: 24, jitterOverlap: false }));
        });

        it(`draws no point on any ${chartType} category where one category holds more than 200 values`, () => {
            const option = deriveChartOption(block(chartType, { x: "cluster", y: "pct_counts_mt" }), QC_ROWS)._unsafeUnwrap();
            // The cluster of 201 values draws no points, thus the cluster of 15 values draws none either.
            expect(pointsOf(option)).toEqual([]);
            expect((option.xAxis as EchartOption).jitter).toBeUndefined();
        });

        it(`draws the points of a grouped ${chartType} on the slot axis, with no axis jitter`, () => {
            const rows = [...cells("B", 10, "s1"), ...cells("B", 10, "s2")];
            const option = deriveChartOption(block(chartType, { x: "cluster", y: "pct_counts_mt", group: "sample" }), rows)._unsafeUnwrap();
            const [categories] = option.xAxis as EchartOption[];
            expect(categories.jitter).toBeUndefined();
            expect(slotSeries(option).map((entry) => (entry.data as unknown[]).length)).toEqual([10, 10]);
        });
    }

    it("draws no outlier mark for a box category whose points draw each value", () => {
        const rows = [...cells("Megakaryocytes", 15), { cluster: "Megakaryocytes", pct_counts_mt: 90 }];
        const option = deriveChartOption(block("box", { x: "cluster", y: "pct_counts_mt" }), rows)._unsafeUnwrap();
        expect(seriesOf(option).map((entry) => entry.type)).toEqual(["boxplot", "scatter"]);
        expect(pointsOf(option)).toContainEqual([0, 90]);
    });

    it("pairs the outlier mark with each box of a chart where one category passes the limit", () => {
        const rows = [
            ...cells("CD4 T", 201),
            { cluster: "CD4 T", pct_counts_mt: 90 },
            ...cells("Megakaryocytes", 15),
            { cluster: "Megakaryocytes", pct_counts_mt: 80 },
        ];
        const option = deriveChartOption(block("box", { x: "cluster", y: "pct_counts_mt" }), rows)._unsafeUnwrap();
        const outliers = seriesOf(option).find((entry) => entry.type === "scatter");
        expect(outliers).toEqual(
            expect.objectContaining({
                symbolSize: 4,
                itemStyle: { color: CHART_INK },
                data: [
                    [0, 90],
                    [1, 80],
                ],
            }),
        );
    });

    it("keeps the axis plain where each category passes the limit", () => {
        const option = deriveChartOption(block("box", { x: "cluster", y: "pct_counts_mt" }), cells("CD4 T", 201))._unsafeUnwrap();
        expect(pointsOf(option)).toEqual([]);
        expect((option.xAxis as EchartOption).jitter).toBeUndefined();
    });

    it("gives the same SVG bytes for two exports of a jittered chart", () => {
        // Two hundred tied values overflow the band of a column export, thus the runtime places some points at random.
        const tied = ["A", "B", "C", "D"].flatMap((cluster) => Array.from({ length: 200 }, () => ({ cluster, pct_counts_mt: 2 })));
        const option = deriveChartOption(block("box", { x: "cluster", y: "pct_counts_mt" }), tied)._unsafeUnwrap();
        const first = renderChartSvg(echarts, option, CHART_EXPORT_SIZES.single)._unsafeUnwrap();
        const second = renderChartSvg(echarts, option, CHART_EXPORT_SIZES.single)._unsafeUnwrap();
        expect(second).toBe(first);
    });
});

/** The normalized counts of two genes in two conditions, three or four replicates in each slot, from the pasilla table. */
const COUNTS: ChartRow[] = [
    { gene: "Kal1", condition: "untreated", count: 1341.43 },
    { gene: "Kal1", condition: "untreated", count: 1237.78 },
    { gene: "Kal1", condition: "untreated", count: 1140.91 },
    { gene: "Kal1", condition: "untreated", count: 1238.69 },
    { gene: "Kal1", condition: "treated", count: 42.8 },
    { gene: "Kal1", condition: "treated", count: 49.92 },
    { gene: "Kal1", condition: "treated", count: 62.45 },
    { gene: "Ant2", condition: "untreated", count: 396.19 },
    { gene: "Ant2", condition: "untreated", count: 364.08 },
    { gene: "Ant2", condition: "untreated", count: 429.57 },
    { gene: "Ant2", condition: "treated", count: 1802.2 },
    { gene: "Ant2", condition: "treated", count: 1650.1 },
    { gene: "Ant2", condition: "treated", count: 1733.4 },
];

/** The series on the hidden slot axis: the points and the median lines of a grouped chart or of a thin slot. */
function slotSeries(option: EchartOption): EchartOption[] {
    return seriesOf(option).filter((entry) => entry.xAxisIndex === 1);
}

/** The median lines of an option as `[from x, to x, y]`. */
function medianLines(option: EchartOption): number[][] {
    return slotSeries(option).flatMap((entry) =>
        (((entry.markLine as EchartOption | undefined)?.data ?? []) as Array<Array<{ coord: number[] }>>).map(([from, to]) => [
            from.coord[0],
            to.coord[0],
            from.coord[1],
        ]),
    );
}

describe("the thin slots of a box and of a violin", () => {
    for (const chartType of ["box", "violin"] as const) {
        it(`draws each value of a grouped ${chartType} as a point inside the slot of its group, and never an empty chart`, () => {
            const option = deriveChartOption(block(chartType, { x: "gene", y: "count", group: "condition" }), COUNTS)._unsafeUnwrap();
            const axes = option.xAxis as EchartOption[];
            expect(axes[1]).toEqual(expect.objectContaining({ type: "value", min: -0.5, max: 1.5, show: false }));
            const points = slotSeries(option).map((entry) => [entry.name, (entry.data as number[][]).length]);
            expect(points).toEqual([
                ["untreated", 7],
                ["treated", 6],
            ]);
            // The untreated slot sits left of the center of each category, and the treated slot right of it.
            const [untreated, treated] = slotSeries(option).map((entry) => entry.data as number[][]);
            for (const [x] of untreated) expect(x - Math.round(x)).toBeLessThan(0);
            for (const [x] of treated) expect(x - Math.round(x)).toBeGreaterThan(0);
            expect(untreated.map((point) => point[1]).sort((a, b) => a - b)).toEqual([364.08, 396.19, 429.57, 1140.91, 1237.78, 1238.69, 1341.43]);
        });

        it(`draws the median of each ${chartType} slot of fewer than five values as a short line`, () => {
            const option = deriveChartOption(block(chartType, { x: "gene", y: "count", group: "condition" }), COUNTS)._unsafeUnwrap();
            const lines = medianLines(option);
            const expected = [1238.235, 396.19, 49.92, 1733.4];
            expect(lines).toHaveLength(expected.length);
            for (const [index, line] of lines.entries()) expect(line[2]).toBeCloseTo(expected[index], 9);
            for (const [from, to] of lines) expect(to).toBeGreaterThan(from);
        });

        it(`keeps the median line of a thin ${chartType} slot where one slot passes the point limit`, () => {
            const rows = [...cells("CD4 T", 201), ...cells("Megakaryocytes", 3)];
            const option = deriveChartOption(block(chartType, { x: "cluster", y: "pct_counts_mt" }), rows)._unsafeUnwrap();
            expect(pointsOf(option)).toEqual([]);
            expect(medianLines(option).map((line) => line[2])).toEqual([3.4]);
        });
    }
});

/** The composition of two donors under two conditions: the shares of each donor sum to one in each condition. */
const COMPOSITION: ChartRow[] = [
    { sample: "101", condition: "control", cell_type: "B cells", n_cells: 106, proportion: 0.25 },
    { sample: "101", condition: "control", cell_type: "NK cells", n_cells: 318, proportion: 0.75 },
    { sample: "107", condition: "control", cell_type: "B cells", n_cells: 50, proportion: 0.5 },
    { sample: "107", condition: "control", cell_type: "NK cells", n_cells: 50, proportion: 0.5 },
    { sample: "101", condition: "stimulated", cell_type: "NK cells", n_cells: 90, proportion: 0.9 },
    { sample: "101", condition: "stimulated", cell_type: "B cells", n_cells: 10, proportion: 0.1 },
    { sample: "107", condition: "stimulated", cell_type: "B cells", n_cells: 30, proportion: 0.3 },
    { sample: "107", condition: "stimulated", cell_type: "NK cells", n_cells: 70, proportion: 0.7 },
];

describe("the facet of the stacked bars", () => {
    it("draws one stacked panel for each condition, with every group in one order in each panel", () => {
        const option = deriveChartOption(
            block("stacked-bar", { x: "sample", y: "n_cells", group: "cell_type", facet: "condition" }),
            COMPOSITION,
        )._unsafeUnwrap();
        expect(option.grid as EchartOption[]).toHaveLength(2);
        const series = seriesOf(option);
        expect(series.map((entry) => [entry.name, entry.xAxisIndex, entry.stack])).toEqual([
            ["B cells", 0, "total-0"],
            ["NK cells", 0, "total-0"],
            ["B cells", 1, "total-1"],
            ["NK cells", 1, "total-1"],
        ]);
        // The stimulated panel holds its own parts in the category order of the table.
        expect(series[3].data).toEqual([90, 70]);
        // Each panel reads one value range over the largest total of any panel.
        const values = (option.yAxis as EchartOption[]).map((axis) => [axis.min, axis.max]);
        expect(values).toEqual([
            [0, 500],
            [0, 500],
        ]);
        const labels = (option.graphic as EchartOption[]).map((element) => (element.style as EchartOption).text);
        expect(labels).toEqual(expect.arrayContaining(["control", "stimulated"]));
    });

    it("draws the shares of each panel on a value axis from 0 to 1", () => {
        const option = deriveChartOption(
            block("normalized-bar", { x: "sample", y: "n_cells", group: "cell_type", facet: "condition" }),
            COMPOSITION,
        )._unsafeUnwrap();
        const series = seriesOf(option);
        expect(series[0].data).toEqual([0.25, 0.5]);
        expect(series[2].data).toEqual([0.1, 0.3]);
        for (const axis of option.yAxis as EchartOption[]) expect(axis).toEqual(expect.objectContaining({ min: 0, max: 1 }));
    });

    it("refuses a pair that repeats inside one panel", () => {
        const rows = [...COMPOSITION, { sample: "101", condition: "control", cell_type: "B cells", n_cells: 1, proportion: 0 }];
        expect(
            deriveChartOption(block("stacked-bar", { x: "sample", y: "n_cells", group: "cell_type", facet: "condition" }), rows)._unsafeUnwrapErr().detail,
        ).toBe("The stacked-bar chart holds the pair (101, B cells) more than one time.");
    });

    it("keeps the refusal of a facet on a chart type that draws no panels", () => {
        expect(deriveChartOption(block("pie", { group: "cell_type", value: "n_cells", facet: "condition" }), COMPOSITION)._unsafeUnwrapErr().detail).toBe(
            'The pie chart takes no "facet" channel. A facet is legal on a scatter, a line, a bar, and the two stacked forms.',
        );
    });
});
