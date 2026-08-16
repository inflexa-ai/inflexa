import { describe, expect, it } from "bun:test";

import type { ChartBlock, ChartComposition, ChartTransform } from "../contracts/report-blocks.js";
import { renderChart } from "./views/chart-view.js";
import { CHART_SOURCE_MEMBER, deriveChartOption, deriveChartRender, transformColumn, type ChartDataSource, type ChartRow, type EchartOption } from "./chart.js";
import { MANHATTAN_P_THRESHOLD, VOLCANO_EFFECT_THRESHOLD, VOLCANO_P_THRESHOLD } from "./chart-presets.js";
import {
    CHART_INLINE_OPTION_BOUND,
    DESIGN_CSS,
    MUTED_CHART_COLOR,
    SCATTER_CROWD_OPACITY,
    SCATTER_CROWD_SYMBOL_SIZE,
    SCATTER_HOVER_SYMBOL_SIZE,
} from "./design.js";
import { CHART_SERIES_BUILDER } from "./page.js";
import { ReferenceLedger } from "./references.js";

type Encoding = NonNullable<ChartBlock["encoding"]>;
type ChartType = NonNullable<ChartBlock["chartType"]>;

/** The declared display labels of a binding, keyed by the raw column name. */
type Labels = ChartBlock["binding"]["columnLabels"];

/** The arrangement of a bar, as the quick path states it. */
type Orientation = ChartBlock["orientation"];

/** Build a chart block. The binding declares a label only where a test states one. */
function chartBlock(
    chartType: ChartType,
    encoding: Encoding,
    extra: { id?: string; title?: string; caption?: string; labels?: Labels; orientation?: Orientation } = {},
): ChartBlock {
    return {
        kind: "chart",
        id: extra.id ?? "c1",
        binding: { kind: "artifact-table", path: "table.csv", hash: "sha256:00", ...(extra.labels !== undefined ? { columnLabels: extra.labels } : {}) },
        chartType,
        encoding,
        ...(extra.orientation !== undefined ? { orientation: extra.orientation } : {}),
        ...(extra.title !== undefined ? { title: extra.title } : {}),
        ...(extra.caption !== undefined ? { caption: extra.caption } : {}),
    };
}

/** Build a chart block that carries one composition. The binding declares a label only where a test states one. */
function composedBlock(composition: ChartComposition, extra: { id?: string; title?: string; labels?: Labels } = {}): ChartBlock {
    return {
        kind: "chart",
        id: extra.id ?? "c1",
        binding: { kind: "artifact-table", path: "table.csv", hash: "sha256:00", ...(extra.labels !== undefined ? { columnLabels: extra.labels } : {}) },
        composition,
        ...(extra.title !== undefined ? { title: extra.title } : {}),
    };
}

/** Narrow one option field to an object. */
function asObj(value: unknown): Record<string, unknown> {
    return value as Record<string, unknown>;
}

/** Narrow one option field to an array. */
function asArr(value: unknown): unknown[] {
    return value as unknown[];
}

/** Derive an option and unwrap the ok value, or fail the test on a refusal. */
function derive(block: ChartBlock, rows: ChartRow[], columns?: string[]): EchartOption {
    return deriveChartOption(block, rows, columns)._unsafeUnwrap();
}

describe("deriveChartOption bar", () => {
    const rows: ChartRow[] = [
        { day: "Mon", count: 5, cohort: "A" },
        { day: "Tue", count: 7, cohort: "A" },
        { day: "Mon", count: 3, cohort: "B" },
        { day: "Tue", count: 9, cohort: "B" },
    ];
    const block = chartBlock("bar", { x: "day", y: "count", group: "cohort" });

    it("derives the axes from the encoding", () => {
        const option = derive(block, rows);
        const xAxis = asObj(option.xAxis);
        const yAxis = asObj(option.yAxis);
        expect(xAxis.type).toBe("category");
        expect(xAxis.data).toEqual(["Mon", "Tue"]);
        expect(xAxis.name).toBe("day");
        expect(yAxis.type).toBe("value");
        expect(yAxis.name).toBe("count");
    });

    it("gives one series per group in first-appearance order, with the pairs", () => {
        const option = derive(block, rows);
        const series = asArr(option.series);
        expect(series.length).toBe(2);
        expect(asObj(series[0]).name).toBe("A");
        expect(asObj(series[1]).name).toBe("B");
        expect(asObj(series[0]).barGap).toBe(0);
        expect(asObj(series[0]).data).toEqual([
            ["Mon", 5],
            ["Tue", 7],
        ]);
        expect(asObj(series[1]).data).toEqual([
            ["Mon", 3],
            ["Tue", 9],
        ]);
    });

    it("sets no title and carries the bottom legend that the normalizer adds for two series", () => {
        const option = derive(block, rows);
        expect("title" in option).toBe(false);
        expect(option.legend).toEqual({ bottom: 0 });
    });

    it("orders the categories by first appearance, not by sort", () => {
        const dayRows: ChartRow[] = [
            { day: "Day2", count: 1 },
            { day: "Day10", count: 2 },
            { day: "Day1", count: 3 },
        ];
        const option = derive(chartBlock("bar", { x: "day", y: "count" }), dayRows);
        expect(asObj(option.xAxis).data).toEqual(["Day2", "Day10", "Day1"]);
    });

    it("is deterministic: the double derivation is byte-identical", () => {
        const first = derive(block, rows);
        const second = derive(block, rows);
        expect(first).toEqual(second);
        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });
});

describe("the bar orientation", () => {
    /** The GSEA summary of the session: a long set name, and the enrichment score beside it. */
    const nesRows: ChartRow[] = [
        { set: "HALLMARK_HYPOXIA", nes: 2.41 },
        { set: "HALLMARK_G2M_CHECKPOINT", nes: -1.74 },
        { set: "HALLMARK_GLYCOLYSIS", nes: 2.18 },
    ];

    it("renders the category on y and the value on x, with every label", () => {
        const option = derive(chartBlock("bar", { x: "set", y: "nes" }, { orientation: "horizontal" }), nesRows);
        const xAxis = asObj(option.xAxis);
        const yAxis = asObj(option.yAxis);
        expect(yAxis.type).toBe("category");
        expect(yAxis.data).toEqual(["HALLMARK_HYPOXIA", "HALLMARK_G2M_CHECKPOINT", "HALLMARK_GLYCOLYSIS"]);
        expect(xAxis.type).toBe("value");
        // The long names are the reason for the arrangement, thus no label of the category axis drops.
        expect(asObj(yAxis.axisLabel).interval).toBe(0);
        // The rotation is an x-axis rule, thus a name up the y axis reads level.
        expect("rotate" in asObj(yAxis.axisLabel)).toBe(false);
        // The runtime draws the first category at the origin, thus the axis inverts to read top-down.
        expect(yAxis.inverse).toBe(true);
    });

    it("holds the category labels inside the grid, thus a long name draws whole", () => {
        const quick = derive(chartBlock("bar", { x: "set", y: "nes" }, { orientation: "horizontal" }), nesRows);
        const composed = derive(composedBlock({ series: [{ form: "bar", orientation: "horizontal", encoding: { x: "set", y: "nes" } }] }), nesRows);
        for (const option of [quick, composed]) {
            expect(asObj(option.grid).containLabel).toBe(true);
            // The normalizer fills only an unset key, thus the margins land beside the contained labels.
            expect(asObj(option.grid).left).toBe("10%");
        }
    });

    it("leaves the grid of a vertical bar to the normalizer alone", () => {
        const option = derive(chartBlock("bar", { x: "set", y: "nes" }), nesRows);
        expect("containLabel" in asObj(option.grid)).toBe(false);
        expect("inverse" in asObj(option.xAxis)).toBe(false);
    });

    it("leads each pair with the value, because the runtime reads the first member on x", () => {
        const option = derive(chartBlock("bar", { x: "set", y: "nes" }, { orientation: "horizontal" }), nesRows);
        expect(asObj(asArr(option.series)[0]).data).toEqual([
            [2.41, "HALLMARK_HYPOXIA"],
            [-1.74, "HALLMARK_G2M_CHECKPOINT"],
            [2.18, "HALLMARK_GLYCOLYSIS"],
        ]);
    });

    it("lands the title of each column on the axis that draws it", () => {
        const option = derive(
            chartBlock("bar", { x: "set", y: "nes" }, { orientation: "horizontal", labels: { set: "Gene set", nes: "Normalized enrichment score" } }),
            nesRows,
        );
        expect(asObj(option.xAxis).name).toBe("Normalized enrichment score");
        expect(asObj(option.yAxis).name).toBe("Gene set");
        // An x axis takes the centered name, thus the value title clears the right margin of the grid.
        expect(asObj(option.xAxis).nameLocation).toBe("middle");
    });

    it("states the fault of an orientation beside a type that is not a bar", () => {
        for (const chartType of ["line", "pie", "volcano"] as const) {
            const block = chartBlock(chartType, { x: "set", y: "nes", value: "nes", group: "set" }, { id: "o1", orientation: "horizontal" });
            const problem = deriveChartOption(block, nesRows)._unsafeUnwrapErr();
            expect(problem.blockId).toBe("o1");
            expect(problem.detail).toContain(chartType);
            expect(problem.detail).toContain("orientation");
        }
    });

    it("keeps the vertical arrangement of a bar that states no orientation", () => {
        const option = derive(chartBlock("bar", { x: "set", y: "nes" }), nesRows);
        expect(JSON.stringify(option)).toBe(
            JSON.stringify({
                xAxis: {
                    type: "category",
                    data: ["HALLMARK_HYPOXIA", "HALLMARK_G2M_CHECKPOINT", "HALLMARK_GLYCOLYSIS"],
                    name: "set",
                    nameLocation: "middle",
                    nameGap: 34,
                    axisLabel: { interval: 0 },
                },
                yAxis: { type: "value", name: "nes", axisLabel: { interval: 0 } },
                series: [
                    {
                        type: "bar",
                        barGap: 0,
                        data: [
                            ["HALLMARK_HYPOXIA", 2.41],
                            ["HALLMARK_G2M_CHECKPOINT", -1.74],
                            ["HALLMARK_GLYCOLYSIS", 2.18],
                        ],
                    },
                ],
                legend: { show: false },
                grid: { top: "8%", bottom: "20%", left: "10%", right: "5%" },
                toolbox: { right: 0, top: 0, feature: { saveAsImage: { type: "png", name: "chart" } } },
            }),
        );
    });

    it("renders the NES chart horizontal, with the zero line on the value axis", () => {
        const option = derive(
            composedBlock({
                series: [{ form: "bar", orientation: "horizontal", encoding: { x: "set", y: "nes" } }],
                annotations: [{ kind: "reference-line", axis: "x", value: 0 }],
            }),
            nesRows,
        );
        const yAxis = asObj(option.yAxis);
        expect(yAxis.type).toBe("category");
        // The rows arrive strongest-first, thus the inverted axis reads them down from the top.
        expect(yAxis.data).toEqual(["HALLMARK_HYPOXIA", "HALLMARK_G2M_CHECKPOINT", "HALLMARK_GLYCOLYSIS"]);
        expect(yAxis.inverse).toBe(true);
        expect(asObj(yAxis.axisLabel).interval).toBe(0);
        expect(asObj(option.grid).containLabel).toBe(true);
        expect(asObj(option.xAxis).type).toBe("value");
        // An annotation names a rendered axis, thus the zero of a horizontal bar stands on `x`.
        const marks = asArr(asObj(asObj(asArr(option.series)[0]).markLine).data);
        expect(marks).toEqual([{ xAxis: 0, label: { position: "start" } }]);
    });

    it("swaps the pairs of a composition bar too, and keeps the category name on a named point", () => {
        const option = derive(
            composedBlock({
                series: [{ form: "bar", orientation: "horizontal", encoding: { x: "set", y: "nes" } }],
                annotations: [{ kind: "point-labels", column: "nes", order: "desc", n: 1 }],
            }),
            nesRows,
        );
        const data = asArr(asObj(asArr(option.series)[0]).data);
        expect(data[1]).toEqual([-1.74, "HALLMARK_G2M_CHECKPOINT"]);
        // The name of a bar is what it counts, thus the marked point still reads the category cell.
        expect(asObj(data[0]).name).toBe("HALLMARK_HYPOXIA");
        expect(asObj(data[0]).value).toEqual([2.41, "HALLMARK_HYPOXIA"]);
    });

    it("titles the rendered axes of a composition, thus a declared axes title names the axis it sits on", () => {
        const option = derive(
            composedBlock({
                series: [{ form: "bar", orientation: "horizontal", encoding: { x: "set", y: "nes" } }],
                axes: { x: { title: "Enrichment" }, y: { title: "Pathway" } },
            }),
            nesRows,
        );
        expect(asObj(option.xAxis).name).toBe("Enrichment");
        expect(asObj(option.yAxis).name).toBe("Pathway");
    });

    it("refuses a grid that mixes a horizontal bar with another series", () => {
        const block = composedBlock(
            {
                series: [
                    { form: "bar", orientation: "horizontal", encoding: { x: "set", y: "nes" } },
                    { form: "scatter", encoding: { x: "set", y: "nes" } },
                ],
            },
            { id: "m1" },
        );
        const problem = deriveChartOption(block, nesRows)._unsafeUnwrapErr();
        expect(problem.blockId).toBe("m1");
        expect(problem.detail).toContain("horizontal bar");
        expect(problem.detail).toContain("y axis");
    });

    it("refuses a block that carries an orientation beside a composition", () => {
        // The grammar refuses the pair. A block that reaches the renderer without a parse would otherwise
        // dispatch the composition and drop the orientation in silence.
        const block: ChartBlock = {
            kind: "chart",
            id: "b1",
            binding: { kind: "artifact-table", path: "table.csv", hash: "sha256:00" },
            composition: { series: [{ form: "bar", encoding: { x: "set", y: "nes" } }] },
            orientation: "horizontal",
        };
        const problem = deriveChartOption(block, nesRows)._unsafeUnwrapErr();
        expect(problem.blockId).toBe("b1");
        expect(problem.detail).toContain("orientation");
        expect(problem.detail).toContain("composition");
    });

    it("carries the orientation through the quick path that names its points", () => {
        // A `label` channel routes the quick path through a composition, and the arrangement crosses with it.
        const option = derive(chartBlock("bar", { x: "set", y: "nes", label: "set" }, { orientation: "horizontal" }), nesRows);
        expect(asObj(option.yAxis).type).toBe("category");
        expect(asObj(asArr(asObj(asArr(option.series)[0]).data)[0]).value).toEqual([2.41, "HALLMARK_HYPOXIA"]);
    });

    it("keeps a vertical bar beside another series, because the two share an axis pair", () => {
        const option = derive(
            composedBlock({
                series: [
                    { form: "bar", encoding: { x: "set", y: "nes" } },
                    { form: "scatter", encoding: { x: "set", y: "nes" } },
                ],
            }),
            nesRows,
        );
        expect(asArr(option.series).length).toBe(2);
    });
});

describe("deriveChartOption line", () => {
    it("sorts the series data by x", () => {
        const rows: ChartRow[] = [
            { t: 3, v: 30 },
            { t: 1, v: 10 },
            { t: 2, v: 20 },
        ];
        const option = derive(chartBlock("line", { x: "t", y: "v" }), rows);
        expect(asObj(option.xAxis).type).toBe("value");
        expect(asObj(asArr(option.series)[0]).data).toEqual([
            [1, 10],
            [2, 20],
            [3, 30],
        ]);
    });

    it("infers a category axis on a string column and sorts by code unit", () => {
        const rows: ChartRow[] = [
            { label: "b", v: 2 },
            { label: "a", v: 1 },
            { label: "c", v: 3 },
        ];
        const option = derive(chartBlock("line", { x: "label", y: "v" }), rows);
        const xAxis = asObj(option.xAxis);
        expect(xAxis.type).toBe("category");
        expect(xAxis.data).toEqual(["b", "a", "c"]);
        expect(asObj(asArr(option.series)[0]).data).toEqual([
            ["a", 1],
            ["b", 2],
            ["c", 3],
        ]);
    });
});

describe("deriveChartOption histogram", () => {
    const rows: ChartRow[] = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }, { n: 6 }, { n: 7 }, { n: 8 }];
    const block = chartBlock("histogram", { x: "n" });

    it("bins with the auto count and gives the exact midpoints", () => {
        // n = 8: Sturges = ceil(log2(8)) + 1 = 4, Freedman-Diaconis = 2, thus 4 bins.
        // The edges are [1, 2.75, 4.5, 6.25, 8], and each bin holds two values.
        const option = derive(block, rows);
        expect(asObj(asArr(option.series)[0]).data).toEqual([
            [1.875, 2],
            [3.625, 2],
            [5.375, 2],
            [7.125, 2],
        ]);
    });

    it("gives the same edges on the same rows two times", () => {
        const first = derive(block, rows);
        const second = derive(block, rows);
        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    it("holds the count ticks a whole count apart, thus no tick carries a fraction", () => {
        // The axis counts rows. `minInterval` is the one static field that bounds a tick, because the
        // option rides as inline JSON and a function formatter cannot cross it.
        expect(asObj(derive(block, rows).yAxis).minInterval).toBe(1);
        expect(asObj(derive(block, []).yAxis).minInterval).toBe(1);
    });

    it("shares the same edges across the groups", () => {
        const groupRows: ChartRow[] = [
            { n: 1, g: "G1" },
            { n: 2, g: "G1" },
            { n: 3, g: "G1" },
            { n: 4, g: "G1" },
            { n: 5, g: "G2" },
            { n: 6, g: "G2" },
            { n: 7, g: "G2" },
            { n: 8, g: "G2" },
        ];
        const option = derive(chartBlock("histogram", { x: "n", group: "g" }), groupRows);
        const series = asArr(option.series);
        const midpoints = (data: unknown): unknown[] => asArr(data).map((point) => asArr(point)[0]);
        const shared = [1.875, 3.625, 5.375, 7.125];
        expect(midpoints(asObj(series[0]).data)).toEqual(shared);
        expect(midpoints(asObj(series[1]).data)).toEqual(shared);
        expect(asObj(series[0]).name).toBe("G1");
        expect(asObj(series[0]).barGap).toBe("-100%");
        expect(asObj(series[0]).data).toEqual([
            [1.875, 2],
            [3.625, 2],
            [5.375, 0],
            [7.125, 0],
        ]);
        expect(asObj(series[1]).data).toEqual([
            [1.875, 0],
            [3.625, 0],
            [5.375, 2],
            [7.125, 2],
        ]);
    });
});

describe("deriveChartOption box", () => {
    const rows: ChartRow[] = [
        { cat: "A", val: 1 },
        { cat: "A", val: 2 },
        { cat: "A", val: 3 },
        { cat: "A", val: 4 },
        { cat: "A", val: 5 },
        { cat: "A", val: 6 },
        { cat: "A", val: 20 },
        { cat: "B", val: 10 },
        { cat: "B", val: 11 },
        { cat: "B", val: 12 },
        { cat: "B", val: 13 },
    ];
    const block = chartBlock("box", { x: "cat", y: "val" });

    it("computes the type-7 five-number summary and pairs the outlier scatter", () => {
        const option = derive(block, rows);
        const series = asArr(option.series);
        const boxData = asArr(asObj(series[0]).data);
        // The seven values [1..6, 20] give Q1 = 2.5, median = 4, Q3 = 5.5, whiskers [1, 6], and 20 outlies.
        expect(boxData[0]).toEqual([1, 2.5, 4, 5.5, 6]);
        // A category with four values renders an empty box.
        expect(boxData[1]).toBe("-");
        expect(asObj(series[1]).type).toBe("scatter");
        expect(asObj(series[1]).symbolSize).toBe(4);
        expect(asObj(series[1]).data).toEqual([[0, 20]]);
    });

    it("names the category axis from the x column", () => {
        const option = derive(block, rows);
        expect(asObj(option.xAxis).data).toEqual(["A", "B"]);
    });
});

describe("deriveChartOption heatmap", () => {
    it("builds a dense grid with a null for the absent pair", () => {
        const rows: ChartRow[] = [
            { r: "A", c: "P", v: 1 },
            { r: "A", c: "Q", v: 2 },
            { r: "B", c: "P", v: 3 },
        ];
        const option = derive(chartBlock("heatmap", { x: "r", y: "c", value: "v" }), rows);
        expect(asObj(asArr(option.series)[0]).data).toEqual([
            [0, 0, 1],
            [0, 1, 2],
            [1, 0, 3],
            [1, 1, null],
        ]);
        const visualMap = asObj(option.visualMap);
        expect(visualMap.min).toBe(1);
        expect(visualMap.max).toBe(3);
    });

    it("refuses a repeated pair", () => {
        const rows: ChartRow[] = [
            { r: "A", c: "P", v: 1 },
            { r: "A", c: "P", v: 5 },
        ];
        const problem = deriveChartOption(chartBlock("heatmap", { x: "r", y: "c", value: "v" }, { id: "hm" }), rows)._unsafeUnwrapErr();
        expect(problem.kind).toBe("invalid-chart-input");
        expect(problem.blockId).toBe("hm");
        expect(problem.detail).toContain("A");
        expect(problem.detail).toContain("P");
    });
});

describe("deriveChartOption pie", () => {
    it("gives one slice per category in first-appearance order", () => {
        const rows: ChartRow[] = [
            { cat: "X", n: 10 },
            { cat: "Y", n: 20 },
            { cat: "Z", n: 30 },
        ];
        const option = derive(chartBlock("pie", { group: "cat", value: "n" }), rows);
        const series = asObj(asArr(option.series)[0]);
        expect(series.type).toBe("pie");
        expect(series.radius).toBe("55%");
        expect(series.data).toEqual([
            { name: "X", value: 10 },
            { name: "Y", value: 20 },
            { name: "Z", value: 30 },
        ]);
    });

    it("refuses a repeated category", () => {
        const rows: ChartRow[] = [
            { cat: "X", n: 10 },
            { cat: "X", n: 5 },
        ];
        const problem = deriveChartOption(chartBlock("pie", { group: "cat", value: "n" }, { id: "pie1" }), rows)._unsafeUnwrapErr();
        expect(problem.kind).toBe("invalid-chart-input");
        expect(problem.detail).toContain("X");
    });
});

describe("deriveChartOption refusals", () => {
    it("names the missing demanded column in the detail", () => {
        const rows: ChartRow[] = [{ gene: "TP53", value: 5 }];
        const problem = deriveChartOption(chartBlock("bar", { x: "gene", y: "count" }, { id: "bar1" }), rows)._unsafeUnwrapErr();
        expect(problem.kind).toBe("invalid-chart-input");
        expect(problem.blockId).toBe("bar1");
        expect(problem.detail).toContain("count");
    });

    it("renders a zero-row chart with an empty data list", () => {
        const option = derive(chartBlock("bar", { x: "day", y: "count" }), [], ["day", "count"]);
        expect(asObj(asArr(option.series)[0]).data).toEqual([]);
    });
});

describe("the axis name placement", () => {
    /** Each chart type that names its x axis, with the rows and the encoding that give it a name. */
    const namedX: Array<{ chartType: ChartType; encoding: Encoding; rows: ChartRow[] }> = [
        { chartType: "bar", encoding: { x: "day", y: "count" }, rows: [{ day: "Mon", count: 1 }] },
        { chartType: "line", encoding: { x: "t", y: "v" }, rows: [{ t: 1, v: 2 }] },
        { chartType: "scatter", encoding: { x: "t", y: "v" }, rows: [{ t: 1, v: 2 }] },
        { chartType: "box", encoding: { x: "cat", y: "val" }, rows: [{ cat: "A", val: 1 }] },
        { chartType: "heatmap", encoding: { x: "r", y: "c", value: "v" }, rows: [{ r: "A", c: "P", v: 1 }] },
    ];

    /** The ECharts default `nameGap`. A centered name at this gap sits on top of the axis labels. */
    const DEFAULT_NAME_GAP = 15;

    for (const entry of namedX) {
        it(`centers the x axis name of a ${entry.chartType} chart under its axis`, () => {
            const xAxis = asObj(derive(chartBlock(entry.chartType, entry.encoding), entry.rows).xAxis);
            expect(xAxis.name).toBe(entry.encoding.x);
            // The ECharts default `nameLocation` of `"end"` puts the name at the right end of the axis, past
            // the right grid margin that the shared normalizer sets. The panel then clips the name. The
            // assertion also proves that the normalizer carries both fields through untouched.
            expect(xAxis.nameLocation).toBe("middle");
            expect(typeof xAxis.nameGap).toBe("number");
            expect(xAxis.nameGap as number).toBeGreaterThan(DEFAULT_NAME_GAP);
        });
    }

    it("keeps the y axis name at the default placement, which the panel does not clip", () => {
        const yAxis = asObj(derive(chartBlock("bar", { x: "day", y: "count" }), [{ day: "Mon", count: 1 }]).yAxis);
        expect(yAxis.name).toBe("count");
        // A measurement of the rendered fixture puts the y axis name inside the container at the default
        // `"end"` location. Thus the y axis needs no move, and the derivation adds no field.
        expect("nameLocation" in yAxis).toBe(false);
        expect("nameGap" in yAxis).toBe(false);
    });

    it("adds no name field to the unnamed histogram x axis", () => {
        const xAxis = asObj(derive(chartBlock("histogram", { x: "n" }), [{ n: 1 }, { n: 2 }]).xAxis);
        expect("name" in xAxis).toBe(false);
        expect("nameLocation" in xAxis).toBe(false);
    });
});

describe("the composition derivation", () => {
    const rows: ChartRow[] = [
        { t: 1, hi: 5, lo: 2, arm: "A", gene: "CA9" },
        { t: 2, hi: 7, lo: 3, arm: "A", gene: "TP53" },
        { t: 1, hi: 4, lo: 1, arm: "B", gene: "VEGFA" },
    ];

    it("gives one runtime series for each declared series", () => {
        const option = derive(
            composedBlock({
                series: [
                    { form: "line", encoding: { x: "t", y: "hi" }, name: "Upper" },
                    { form: "bar", encoding: { x: "t", y: "lo" }, name: "Lower" },
                ],
            }),
            rows,
        );
        const series = asArr(option.series);
        expect(series.length).toBe(2);
        expect(asObj(series[0]).type).toBe("line");
        expect(asObj(series[0]).name).toBe("Upper");
        expect(asObj(series[1]).type).toBe("bar");
        expect(asObj(series[1]).name).toBe("Lower");
    });

    it("gives one runtime series for each group value, in first-appearance order", () => {
        const option = derive(composedBlock({ series: [{ form: "step", encoding: { x: "t", y: "hi", group: "arm" } }] }), rows);
        const series = asArr(option.series);
        expect(series.map((entry) => asObj(entry).name)).toEqual(["A", "B"]);
        expect(asObj(series[0]).data).toEqual([
            [1, 5],
            [2, 7],
        ]);
    });

    it("emits the step flag for a step series", () => {
        const series = asObj(asArr(derive(composedBlock({ series: [{ form: "step", encoding: { x: "t", y: "hi" } }] }), rows).series)[0]);
        expect(series.type).toBe("line");
        expect(series.step).toBe("end");
    });

    it("sorts a line by x, and keeps the row order of a bar", () => {
        const unsorted: ChartRow[] = [
            { t: 3, v: 30 },
            { t: 1, v: 10 },
            { t: 2, v: 20 },
        ];
        const line = derive(composedBlock({ series: [{ form: "line", encoding: { x: "t", y: "v" } }] }), unsorted);
        const bar = derive(composedBlock({ series: [{ form: "bar", encoding: { x: "t", y: "v" } }] }), unsorted);
        expect(asObj(asArr(line.series)[0]).data).toEqual([
            [1, 10],
            [2, 20],
            [3, 30],
        ]);
        expect(asObj(asArr(bar.series)[0]).data).toEqual([
            [3, 30],
            [1, 10],
            [2, 20],
        ]);
    });

    it("names the axes from the channels, and takes a declared title and scale", () => {
        const bare = derive(composedBlock({ series: [{ form: "line", encoding: { x: "t", y: "hi" } }] }), rows);
        expect(asObj(bare.xAxis).name).toBe("t");
        expect(asObj(bare.yAxis).name).toBe("hi");
        // A series with no declared name and no group falls back to its y channel, thus it agrees with the axis.
        expect(asObj(asArr(bare.series)[0]).name).toBe("hi");

        const titled = derive(
            composedBlock({
                series: [{ form: "line", encoding: { x: "t", y: "hi" } }],
                axes: { x: { title: "Months" }, y: { title: "Level", scale: "log" } },
            }),
            rows,
        );
        expect(asObj(titled.xAxis).name).toBe("Months");
        expect(asObj(titled.yAxis).name).toBe("Level");
        expect(asObj(titled.yAxis).type).toBe("log");
    });

    it("refuses a series channel that names a column no row holds", () => {
        const block = composedBlock({ series: [{ form: "line", encoding: { x: "t", y: "invented" } }] }, { id: "cx" });
        const problem = deriveChartOption(block, rows)._unsafeUnwrapErr();
        expect(problem.kind).toBe("invalid-chart-input");
        expect(problem.blockId).toBe("cx");
        expect(problem.detail).toContain("invented");
    });

    it("gives the larger hit radius to a dense scatter", () => {
        const sparse: ChartRow[] = Array.from({ length: 10 }, (_entry, index) => ({ t: index, v: index }));
        const dense: ChartRow[] = Array.from({ length: 2001 }, (_entry, index) => ({ t: index, v: index }));
        const block = composedBlock({ series: [{ form: "scatter", encoding: { x: "t", y: "v" } }] });
        expect("symbolSize" in asObj(asArr(derive(block, sparse).series)[0])).toBe(false);
        expect(asObj(asArr(derive(block, dense).series)[0]).symbolSize).toBe(SCATTER_HOVER_SYMBOL_SIZE);
    });
});

describe("the composition transforms", () => {
    it("transforms each row, and drops the point that the transform cannot take", () => {
        const rows: ChartRow[] = [
            { gene: "A", p: 0.01 },
            { gene: "B", p: 0 },
            { gene: "C", p: -1 },
            { gene: "D", p: "not a number" },
        ];
        const option = derive(composedBlock({ series: [{ form: "scatter", encoding: { x: "gene", y: { column: "p", transform: "neg_log10" } } }] }), rows);
        expect(asObj(asArr(option.series)[0]).data).toEqual([["A", 2]]);
        // The axis carries the transform, thus it never names the untransformed column.
        expect(asObj(option.yAxis).name).toBe("neg_log10(p)");
    });

    it("takes the absolute value of each cell", () => {
        const rows: ChartRow[] = [
            { g: "A", v: -3 },
            { g: "B", v: 4 },
        ];
        const option = derive(composedBlock({ series: [{ form: "bar", encoding: { x: "g", y: { column: "v", transform: "abs" } } }] }), rows);
        expect(asObj(asArr(option.series)[0]).data).toEqual([
            ["A", 3],
            ["B", 4],
        ]);
    });

    it("ranks a column upward, and a tie shares its place", () => {
        const rows: ChartRow[] = [
            { g: "a", v: 30 },
            { g: "b", v: 10 },
            { g: "c", v: 20 },
            { g: "d", v: 20 },
        ];
        const option = derive(composedBlock({ series: [{ form: "bar", encoding: { x: "g", y: { column: "v", transform: "rank" } } }] }), rows);
        // The two ties both take the place 2, thus the next value takes the place 4.
        expect(asObj(asArr(option.series)[0]).data).toEqual([
            ["a", 4],
            ["b", 1],
            ["c", 2],
            ["d", 2],
        ]);
    });

    it("derives the same bytes two times over the same rows", () => {
        const rows: ChartRow[] = [
            { g: "a", v: 20 },
            { g: "b", v: 20 },
            { g: "c", v: 5 },
        ];
        const block = composedBlock({
            series: [{ form: "scatter", encoding: { x: { column: "v", transform: "rank" }, y: { column: "v", transform: "log10" }, label: "g" } }],
            annotations: [{ kind: "point-labels", column: "v", order: "desc", n: 2 }],
        });
        expect(JSON.stringify(derive(block, rows))).toBe(JSON.stringify(derive(block, rows)));
    });
});

describe("the declared column labels", () => {
    const rows: ChartRow[] = [
        { day: "Mon", count: 5 },
        { day: "Tue", count: 7 },
    ];

    it("names each axis of a quick path with the declared label of its column", () => {
        const block = chartBlock("bar", { x: "day", y: "count" }, { labels: { day: "Day of the week", count: "Cells counted" } });
        const option = derive(block, rows);
        expect(asObj(option.xAxis).name).toBe("Day of the week");
        expect(asObj(option.yAxis).name).toBe("Cells counted");
    });

    it("keeps the raw column name on an axis whose column declares no label", () => {
        const option = derive(chartBlock("scatter", { x: "day", y: "count" }, { labels: { count: "Cells counted" } }), rows);
        expect(asObj(option.xAxis).name).toBe("day");
        expect(asObj(option.yAxis).name).toBe("Cells counted");
    });

    it("names a composition axis with the declared label", () => {
        const block = composedBlock({ series: [{ form: "line", encoding: { x: "day", y: "count" } }] }, { labels: { count: "Cells counted" } });
        expect(asObj(derive(block, rows).yAxis).name).toBe("Cells counted");
    });

    it("keeps the declared axis title over the declared label, because the title names this one axis", () => {
        const block = composedBlock(
            { series: [{ form: "line", encoding: { x: "day", y: "count" } }], axes: { y: { title: "Cells per well" } } },
            { labels: { count: "Cells counted" } },
        );
        expect(asObj(derive(block, rows).yAxis).name).toBe("Cells per well");
    });

    it("keeps the transformed name on an axis whose source column declares a label", () => {
        const transformed: ChartRow[] = [
            { gene: "A", p: 0.01 },
            { gene: "B", p: 0.1 },
        ];
        const block = composedBlock(
            { series: [{ form: "scatter", encoding: { x: "gene", y: { column: "p", transform: "neg_log10" } } }] },
            { labels: { p: "Adjusted p-value" } },
        );
        // The axis states the plotted quantity, and the plotted quantity is the transform of the column.
        expect(asObj(derive(block, transformed).yAxis).name).toBe("neg_log10(p)");
    });

    it("names the series fallback with the declared label, thus the series and the axis agree", () => {
        const block = composedBlock({ series: [{ form: "line", encoding: { x: "day", y: "count" } }] }, { labels: { count: "Cells counted" } });
        const option = derive(block, rows);
        expect(asObj(asArr(option.series)[0]).name).toBe("Cells counted");
        expect(asObj(option.yAxis).name).toBe("Cells counted");
    });

    it("names the histogram axis with the declared label of its column", () => {
        const counts: ChartRow[] = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];
        const xAxis = asObj(derive(chartBlock("histogram", { x: "n" }, { labels: { n: "Reads per cell" } }), counts).xAxis);
        expect(xAxis.name).toBe("Reads per cell");
        expect(xAxis.nameLocation).toBe("middle");
    });

    it("keeps the bare histogram axis of a column that declares no label", () => {
        const counts: ChartRow[] = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];
        const bare = { type: "value", scale: true, axisLabel: { interval: 0 } };
        expect(JSON.stringify(derive(chartBlock("histogram", { x: "n" }), counts).xAxis)).toBe(JSON.stringify(bare));
        // A zero-row histogram takes the same axis, thus the empty container states the same quantity.
        expect(JSON.stringify(derive(chartBlock("histogram", { x: "n" }), []).xAxis)).toBe(JSON.stringify(bare));
    });

    it("ignores a label that names no column, thus the derivation gives the same bytes", () => {
        const plain = derive(chartBlock("bar", { x: "day", y: "count" }), rows);
        const stray = derive(chartBlock("bar", { x: "day", y: "count" }, { labels: { absent: "Absent column" } }), rows);
        expect(JSON.stringify(stray)).toBe(JSON.stringify(plain));
    });
});

describe("the composition tooltip and the point names", () => {
    const rows: ChartRow[] = [
        { gene: "CA9", lfc: 2.94, padj: 0.001 },
        { gene: "TP53", lfc: -2.41, padj: 0.02 },
    ];

    it("puts the label on each data item, and gives a static template formatter", () => {
        const option = derive(composedBlock({ series: [{ form: "scatter", encoding: { x: "lfc", y: "padj", label: "gene" } }] }), rows);
        expect(asObj(asArr(option.series)[0]).data).toEqual([
            { value: [2.94, 0.001], name: "CA9" },
            { value: [-2.41, 0.02], name: "TP53" },
        ]);
        const tooltip = asObj(option.tooltip);
        expect(tooltip.trigger).toBe("item");
        expect(typeof tooltip.formatter).toBe("string");
        expect(tooltip.formatter).toBe("{b}<br/>{a}: {c}");
    });

    it("gives the plain template when no point carries a name", () => {
        const option = derive(composedBlock({ series: [{ form: "scatter", encoding: { x: "lfc", y: "padj" } }] }), rows);
        expect(asObj(option.tooltip).formatter).toBe("{a}: {c}");
    });

    it("routes a quick-path scatter with a label through the composition", () => {
        const option = derive(chartBlock("scatter", { x: "lfc", y: "padj", label: "gene" }), rows);
        expect(asObj(asArr(option.series)[0]).data).toEqual([
            { value: [2.94, 0.001], name: "CA9" },
            { value: [-2.41, 0.02], name: "TP53" },
        ]);
        expect(asObj(option.tooltip).formatter).toBe("{b}<br/>{a}: {c}");
    });

    it("draws a labeled bar on the axis and the gap of the base bar rule", () => {
        const barRows: ChartRow[] = [
            { day: "Mon", count: 5 },
            { day: "Tue", count: 7 },
        ];
        const base = derive(chartBlock("bar", { x: "day", y: "count" }), barRows);
        const labeled = derive(chartBlock("bar", { x: "day", y: "count", label: "day" }), barRows);
        expect(labeled.xAxis).toEqual(base.xAxis);
        expect(asObj(asArr(labeled.series)[0]).barGap).toBe(asObj(asArr(base.series)[0]).barGap);
    });

    it("refuses a label on a chart that draws no point for one row", () => {
        const problem = deriveChartOption(chartBlock("histogram", { x: "lfc", label: "gene" }, { id: "h1" }), rows)._unsafeUnwrapErr();
        expect(problem.detail).toContain("label");
    });
});

describe("the composition annotations", () => {
    const rows: ChartRow[] = [
        { gene: "CA9", lfc: 2.94, score: 9 },
        { gene: "TP53", lfc: -2.41, score: 5 },
        { gene: "VEGFA", lfc: 1.1, score: 7 },
    ];

    it("puts a reference line and a reference band on the first series as static mark data", () => {
        const option = derive(
            composedBlock({
                series: [{ form: "scatter", encoding: { x: "lfc", y: "score" } }],
                annotations: [
                    { kind: "reference-line", axis: "y", value: 6, label: "cut" },
                    { kind: "reference-band", axis: "x", from: -1, to: 1 },
                ],
            }),
            rows,
        );
        const series = asObj(asArr(option.series)[0]);
        expect(asObj(series.markLine).silent).toBe(true);
        expect(asArr(asObj(series.markLine).data)).toEqual([{ yAxis: 6, label: { formatter: "cut" } }]);
        // A vertical band labels at its inside bottom edge, thus the text sits at the axis and not on the title.
        expect(asArr(asObj(series.markArea).data)).toEqual([[{ xAxis: -1, label: { position: "insideBottom" } }, { xAxis: 1 }]]);
    });

    it("names the declared top-N subset alone, and no other point", () => {
        const option = derive(
            composedBlock({
                series: [{ form: "scatter", encoding: { x: "lfc", y: "score", label: "gene" } }],
                annotations: [{ kind: "point-labels", column: "score", order: "desc", n: 1 }],
            }),
            rows,
        );
        const data = asArr(asObj(asArr(option.series)[0]).data);
        expect(data[0]).toEqual({ value: [2.94, 9], name: "CA9", label: { show: true, formatter: "{b}" } });
        expect(data[1]).toEqual({ value: [-2.41, 5], name: "TP53" });
        expect(data[2]).toEqual({ value: [1.1, 7], name: "VEGFA" });
    });

    it("names a marked point after the x cell when the series carries no label channel", () => {
        const option = derive(
            composedBlock({
                series: [{ form: "scatter", encoding: { x: "gene", y: "score" } }],
                annotations: [{ kind: "point-labels", column: "score", order: "asc", n: 1 }],
            }),
            rows,
        );
        const data = asArr(asObj(asArr(option.series)[0]).data);
        expect(data[1]).toEqual({ value: ["TP53", 5], name: "TP53", label: { show: true, formatter: "{b}" } });
        expect(data[0]).toEqual(["CA9", 9]);
    });

    it("carries no function text into the option", () => {
        const json = JSON.stringify(
            derive(
                composedBlock({
                    series: [{ form: "scatter", encoding: { x: "lfc", y: "score", label: "gene" } }],
                    annotations: [
                        { kind: "reference-line", axis: "y", value: 6 },
                        { kind: "point-labels", column: "score", order: "asc", n: 2 },
                    ],
                }),
                rows,
            ),
        );
        expect(json).not.toContain("function");
        expect(json).not.toContain("=>");
    });

    it("marks the smallest cell of a text p-value column", () => {
        const textRows: ChartRow[] = [
            { gene: "A", lfc: 1, p: "1e-3" },
            { gene: "B", lfc: 2, p: "9e-9" },
            { gene: "C", lfc: 3, p: "2e-4" },
        ];
        const option = derive(
            composedBlock({
                series: [{ form: "scatter", encoding: { x: "lfc", y: "lfc", label: "gene" } }],
                annotations: [{ kind: "point-labels", column: "p", order: "asc", n: 1 }],
            }),
            textRows,
        );
        // A code-unit order would put "1e-3" first, which is the largest of the three p-values.
        const data = asArr(asObj(asArr(option.series)[0]).data);
        expect(asObj(data[1]).label).toEqual({ show: true, formatter: "{b}" });
        expect("label" in asObj(data[0])).toBe(false);
        expect("label" in asObj(data[2])).toBe(false);
    });

    it("refuses a rank column that no row holds", () => {
        const block = composedBlock(
            {
                series: [{ form: "scatter", encoding: { x: "lfc", y: "score" } }],
                annotations: [{ kind: "point-labels", column: "invented", order: "asc", n: 2 }],
            },
            { id: "cp" },
        );
        expect(deriveChartOption(block, rows)._unsafeUnwrapErr().detail).toContain("invented");
    });
});

describe("the area band", () => {
    const rows: ChartRow[] = [
        { t: 1, lo: 2, hi: 5 },
        { t: 2, lo: 3, hi: 7 },
    ];

    it("gives the two stacked series that draw the band between the two columns", () => {
        const option = derive(composedBlock({ series: [{ form: "area", encoding: { x: "t", y: "hi", y0: "lo" } }] }), rows);
        const series = asArr(option.series);
        expect(series.length).toBe(2);
        // The runtime stacks the band. Thus the lower series carries the `y0` column, and the sum of the
        // two series at each x is the `y` column.
        expect(asObj(series[0]).data).toEqual([
            [1, 2],
            [2, 3],
        ]);
        expect(asObj(series[1]).data).toEqual([
            [1, 3],
            [2, 4],
        ]);
        expect(asObj(series[0]).stack).toBe(asObj(series[1]).stack);
        expect(asObj(asObj(series[1]).areaStyle).opacity).toBe(0.25);
    });

    it("refuses a band whose lower bound is over its upper bound", () => {
        const inverted: ChartRow[] = [
            { t: 1, lo: 2, hi: 5 },
            { t: 2, lo: 7, hi: 3 },
        ];
        const block = composedBlock({ series: [{ form: "area", encoding: { x: "t", y: "hi", y0: "lo" } }] }, { id: "cb" });
        const problem = deriveChartOption(block, inverted)._unsafeUnwrapErr();
        expect(problem.kind).toBe("invalid-chart-input");
        expect(problem.blockId).toBe("cb");
        expect(problem.detail).toContain("hi");
        expect(problem.detail).toContain("lo");
    });

    it("draws a plain filled line for an area series with no lower bound", () => {
        const option = derive(composedBlock({ series: [{ form: "area", encoding: { x: "t", y: "hi" } }] }), rows);
        const series = asArr(option.series);
        expect(series.length).toBe(1);
        expect(asObj(series[0]).areaStyle).toEqual({});
    });
});

describe("the preset expansion", () => {
    const rows: ChartRow[] = [
        { gene: "CA9", lfc: 2.94, p: 0.001, position: 10, chrom: "1", mean: 40, time: 1, survival: 0.9, arm: "A" },
        { gene: "TP53", lfc: -2.41, p: 0.5, position: 20, chrom: "2", mean: 60, time: 2, survival: 0.7, arm: "B" },
    ];

    it("derives a volcano as a scatter over the effect and the transformed p, with the guide lines", () => {
        const option = derive(chartBlock("volcano", { x: "lfc", y: "p", label: "gene" }), rows);
        // The classification splits the rows, and the up category holds the one significant row.
        const up = asObj(asArr(option.series)[1]);
        expect(up.type).toBe("scatter");
        expect(asArr(up.data)[0]).toEqual({ value: [2.94, 3], name: "CA9" });
        // The up category holds a point, thus it carries the guides and the empty down category does not.
        expect(asArr(asObj(up.markLine).data)).toEqual([
            { yAxis: -Math.log10(VOLCANO_P_THRESHOLD), label: { formatter: `p ${VOLCANO_P_THRESHOLD}` } },
            // A vertical guide labels at the axis end, thus its value reads clear of the y-axis title.
            { xAxis: -VOLCANO_EFFECT_THRESHOLD, label: { position: "start" } },
            { xAxis: VOLCANO_EFFECT_THRESHOLD, label: { position: "start" } },
        ]);
        // The preset knows its own quantities, thus each axis reads them in words.
        expect(asObj(option.xAxis).name).toBe("log2 fold change");
        expect(asObj(option.yAxis).name).toBe("−log10(p)");
    });

    it("gives no semantic x title to a preset channel that carries a transform", () => {
        const option = derive(chartBlock("volcano", { x: { column: "lfc", transform: "abs" }, y: "p" }), rows);
        // The channel plots the absolute effect, thus the log2 title would state the wrong quantity.
        expect(asObj(option.xAxis).name).toBe("abs(lfc)");
    });

    it("orders the survival steps by the number of a text time column", () => {
        const timeRows: ChartRow[] = [
            { time: "2", survival: "0.8" },
            { time: "10", survival: "0.5" },
            { time: "1", survival: "0.9" },
            { time: "11", survival: "0.4" },
        ];
        const option = derive(chartBlock("km", { x: "time", y: "survival" }), timeRows);
        // A CSV gives each cell as text. A code-unit order would put "10" between "1" and "2".
        expect(asObj(asArr(option.series)[0]).data).toEqual([
            ["1", "0.9"],
            ["2", "0.8"],
            ["10", "0.5"],
            ["11", "0.4"],
        ]);
    });

    it("derives a manhattan with the genome-wide guide line and one series per chromosome", () => {
        const option = derive(chartBlock("manhattan", { x: "position", y: "p", group: "chrom" }), rows);
        const series = asArr(option.series);
        expect(series.map((entry) => asObj(entry).name)).toEqual(["1", "2"]);
        expect(asArr(asObj(asObj(series[0]).markLine).data)).toEqual([
            { yAxis: -Math.log10(MANHATTAN_P_THRESHOLD), label: { formatter: `p ${MANHATTAN_P_THRESHOLD}` } },
        ]);
    });

    it("derives an MA plot with the baseline guide line", () => {
        const option = derive(chartBlock("ma", { x: "mean", y: "lfc" }), rows);
        const series = asObj(asArr(option.series)[0]);
        expect(series.type).toBe("scatter");
        expect(asArr(series.data)).toEqual([
            [40, 2.94],
            [60, -2.41],
        ]);
        expect(asArr(asObj(series.markLine).data)).toEqual([{ yAxis: 0 }]);
    });

    it("derives a survival plot as one step series for each arm, and it estimates nothing", () => {
        const option = derive(chartBlock("km", { x: "time", y: "survival", group: "arm" }), rows);
        const series = asArr(option.series);
        expect(series.map((entry) => asObj(entry).name)).toEqual(["A", "B"]);
        expect(asObj(series[0]).step).toBe("end");
        expect(asObj(series[0]).data).toEqual([[1, 0.9]]);
        expect("markLine" in asObj(series[0])).toBe(false);
    });

    it("names the missing demanded channel of a preset", () => {
        const problem = deriveChartOption(chartBlock("volcano", { x: "lfc" }, { id: "v1" }), rows)._unsafeUnwrapErr();
        expect(problem.detail).toContain("volcano");
        expect(problem.detail).toContain("y");
    });
});

describe("the volcano classification", () => {
    /** One row for each of the three categories, plus one row that sits on each guide. */
    const rows: ChartRow[] = [
        { gene: "CA9", lfc: 2.94, p: 0.001 },
        { gene: "TP53", lfc: -2.41, p: 0.002 },
        { gene: "ACTB", lfc: 0.1, p: 0.9 },
        { gene: "BIGP", lfc: 3.5, p: 0.4 },
        { gene: "ONLINE", lfc: 1, p: 0.05 },
    ];

    it("gives three series, and it mutes the null series alone", () => {
        const series = asArr(derive(chartBlock("volcano", { x: "lfc", y: "p", label: "gene" }), rows).series);
        expect(series.map((entry) => asObj(entry).name)).toEqual(["Down", "Up", "Not significant"]);
        expect("itemStyle" in asObj(series[0])).toBe(false);
        expect("itemStyle" in asObj(series[1])).toBe(false);
        expect(asObj(series[2]).itemStyle).toEqual({ color: MUTED_CHART_COLOR });
    });

    it("classifies each row against the guide pair, and a point on a guide states no finding", () => {
        const series = asArr(derive(chartBlock("volcano", { x: "lfc", y: "p", label: "gene" }), rows).series);
        const names = (entry: unknown): unknown[] => asArr(asObj(entry).data).map((point) => asObj(point).name);
        expect(names(series[0])).toEqual(["TP53"]);
        expect(names(series[1])).toEqual(["CA9"]);
        // `ACTB` fails both cuts, `BIGP` fails the p cut, and `ONLINE` sits on both guides.
        expect(names(series[2])).toEqual(["ACTB", "BIGP", "ONLINE"]);
    });

    it("moves the guide and the split together when the block declares the thresholds", () => {
        const block: ChartBlock = { ...chartBlock("volcano", { x: "lfc", y: "p", label: "gene" }), thresholds: { significance: 0.5, effect: 3 } };
        const option = derive(block, rows);
        const series = asArr(option.series);
        const names = (entry: unknown): unknown[] => asArr(asObj(entry).data).map((point) => asObj(point).name);
        // The wider cuts take `BIGP` into the up category, and they leave `CA9` under the effect cut.
        expect(names(series[1])).toEqual(["BIGP"]);
        expect(names(series[0])).toEqual([]);
        expect(names(series[2])).toEqual(["CA9", "TP53", "ACTB", "ONLINE"]);
        // The guides read the same pair, thus the split lands on the drawn lines.
        expect(asArr(asObj(asObj(series[1]).markLine).data)).toEqual([
            { yAxis: -Math.log10(0.5), label: { formatter: "p 0.5" } },
            { xAxis: -3, label: { position: "start" } },
            { xAxis: 3, label: { position: "start" } },
        ]);
    });

    it("keeps the guides off an empty classified series", () => {
        const block: ChartBlock = { ...chartBlock("volcano", { x: "lfc", y: "p" }), thresholds: { significance: 0.5, effect: 3 } };
        const series = asArr(derive(block, rows).series);
        // The down category holds no row, thus the guides ride the first category that draws a point.
        expect("markLine" in asObj(series[0])).toBe(false);
        expect(asArr(asObj(asObj(series[1]).markLine).data).length).toBe(3);
    });

    it("keeps a declared group channel over the classification", () => {
        const grouped: ChartRow[] = [
            { gene: "A", lfc: 2.9, p: 0.001, arm: "tumor" },
            { gene: "B", lfc: -2.4, p: 0.002, arm: "normal" },
        ];
        const series = asArr(derive(chartBlock("volcano", { x: "lfc", y: "p", group: "arm" }), grouped).series);
        // The author asked for the split, thus the preset draws no split of its own beside it.
        expect(series.map((entry) => asObj(entry).name)).toEqual(["tumor", "normal"]);
    });

    it("refuses a thresholds member beside a chart type that reads none", () => {
        const block: ChartBlock = { ...chartBlock("bar", { x: "gene", y: "lfc" }, { id: "t1" }), thresholds: { significance: 0.05, effect: 1 } };
        const problem = deriveChartOption(block, rows)._unsafeUnwrapErr();
        expect(problem.blockId).toBe("t1");
        expect(problem.detail).toContain("bar");
        expect(problem.detail).toContain("thresholds");
    });

    it("refuses a thresholds member beside a composition", () => {
        const block: ChartBlock = {
            ...composedBlock({ series: [{ form: "scatter", encoding: { x: "lfc", y: "p" } }] }, { id: "t2" }),
            thresholds: { significance: 0.05, effect: 1 },
        };
        const problem = deriveChartOption(block, rows)._unsafeUnwrapErr();
        expect(problem.blockId).toBe("t2");
        expect(problem.detail).toContain("thresholds");
    });

    it("derives the same bytes two times", () => {
        const block = chartBlock("volcano", { x: "lfc", y: "p", label: "gene" });
        expect(JSON.stringify(derive(block, rows))).toBe(JSON.stringify(derive(block, rows)));
    });
});

describe("the point labels across a series split", () => {
    /** Six rows over two groups. The rank column orders them, and the two groups interleave. */
    const rows: ChartRow[] = [
        { gene: "A", lfc: 2.9, score: 9, arm: "one" },
        { gene: "B", lfc: -2.4, score: 8, arm: "two" },
        { gene: "C", lfc: 1.1, score: 7, arm: "one" },
        { gene: "D", lfc: -1.2, score: 6, arm: "two" },
        { gene: "E", lfc: 0.4, score: 5, arm: "one" },
        { gene: "F", lfc: -0.3, score: 4, arm: "two" },
    ];

    /** The names of the labeled points of one option, series by series. */
    function labeledNames(option: EchartOption): string[] {
        const names: string[] = [];
        for (const entry of asArr(option.series)) {
            for (const point of asArr(asObj(entry).data)) {
                if (typeof point === "object" && point !== null && "label" in point) names.push(String(asObj(point).name));
            }
        }
        return names;
    }

    it("carries each flagged row into the series that holds it, and the count lands on the declared count", () => {
        const option = derive(
            composedBlock({
                series: [{ form: "scatter", encoding: { x: "lfc", y: "score", group: "arm", label: "gene" } }],
                annotations: [{ kind: "point-labels", column: "score", order: "desc", n: 3 }],
            }),
            rows,
        );
        const series = asArr(option.series);
        expect(series.map((entry) => asObj(entry).name)).toEqual(["one", "two"]);
        // `A` and `C` sit in the first series, and `B` sits in the second one.
        expect(labeledNames(option)).toEqual(["A", "C", "B"]);
        expect(labeledNames(option).length).toBe(3);
    });

    it("ranks the rows that a series draws, thus a dropped row spends no place", () => {
        // A stored zero in a p column takes no logarithm, thus its point drops. The rank of a naive rule
        // would spend every place on such a row, and the plot would then show no label at all.
        const zeroed: ChartRow[] = [
            { gene: "Z1", lfc: 2, p: 0 },
            { gene: "Z2", lfc: 3, p: 0 },
            { gene: "S1", lfc: 1.5, p: 0.0001 },
            { gene: "S2", lfc: 1.4, p: 0.001 },
        ];
        const option = derive(
            composedBlock({
                series: [{ form: "scatter", encoding: { x: "lfc", y: { column: "p", transform: "neg_log10" }, label: "gene" } }],
                annotations: [{ kind: "point-labels", column: "p", order: "asc", n: 2 }],
            }),
            zeroed,
        );
        expect(labeledNames(option)).toEqual(["S1", "S2"]);
    });
});

describe("the scatter symbol ladder", () => {
    /** One scatter composition over `count` rows. */
    function scatterOf(count: number): EchartOption {
        const rows: ChartRow[] = Array.from({ length: count }, (_entry, index) => ({ t: index, v: index }));
        return derive(composedBlock({ series: [{ form: "scatter", encoding: { x: "t", y: "v" } }] }), rows);
    }

    it("keeps the runtime symbol under the hover count", () => {
        expect("symbolSize" in asObj(asArr(scatterOf(10).series)[0])).toBe(false);
    });

    it("takes the larger hit symbol over the hover count", () => {
        const series = asObj(asArr(scatterOf(2001).series)[0]);
        expect(series.symbolSize).toBe(SCATTER_HOVER_SYMBOL_SIZE);
        expect("itemStyle" in series).toBe(false);
    });

    it("takes the small symbol at a reduced opacity over the crowd count", () => {
        const series = asObj(asArr(scatterOf(10001).series)[0]);
        expect(series.symbolSize).toBe(SCATTER_CROWD_SYMBOL_SIZE);
        expect(series.symbolSize).not.toBe(SCATTER_HOVER_SYMBOL_SIZE);
        expect(asObj(series.itemStyle).opacity).toBe(SCATTER_CROWD_OPACITY);
    });

    it("holds the muted color beside the crowd opacity, thus neither field drops the other", () => {
        const rows: ChartRow[] = Array.from({ length: 10001 }, (_entry, index) => ({
            t: index,
            v: index,
            sig: index === 0 ? "up" : "ns",
        }));
        const series = asArr(derive(composedBlock({ series: [{ form: "scatter", encoding: { x: "t", y: "v", group: "sig" } }] }), rows).series);
        expect(asObj(asObj(series[1]).itemStyle)).toEqual({ color: MUTED_CHART_COLOR, opacity: SCATTER_CROWD_OPACITY });
    });
});

describe("the chart text", () => {
    const rows: ChartRow[] = [
        { gene: "A", lfc: 2.9, p: 0.001, sig: "up_in_nonresponders" },
        { gene: "B", lfc: -2.4, p: 0.5, sig: "ns" },
        { gene: "C", lfc: 0.1, p: 0.9, sig: "ns" },
    ];

    it("titles the volcano axes with the quantities that the preset plots", () => {
        const option = derive(chartBlock("volcano", { x: "lfc", y: "p" }), rows);
        expect(asObj(option.xAxis).name).toBe("log2 fold change");
        expect(asObj(option.yAxis).name).toBe("−log10(p)");
    });

    it("titles the manhattan y axis, and keeps the position column on its x axis", () => {
        const positions: ChartRow[] = [
            { position: 10, p: 0.001, chrom: "1" },
            { position: 20, p: 0.5, chrom: "2" },
        ];
        const option = derive(chartBlock("manhattan", { x: "position", y: "p" }), positions);
        expect(asObj(option.yAxis).name).toBe("−log10(p)");
        expect(asObj(option.xAxis).name).toBe("position");
    });

    it("keeps a declared column label over the preset title", () => {
        const option = derive(chartBlock("volcano", { x: "lfc", y: "p" }, { labels: { lfc: "Fold change (log2)" } }), rows);
        expect(asObj(option.xAxis).name).toBe("Fold change (log2)");
    });

    it("mutes the null category of a preset, and leaves each other series on the palette", () => {
        const series = asArr(derive(chartBlock("volcano", { x: "lfc", y: "p", group: "sig" }), rows).series);
        expect(series.map((entry) => asObj(entry).name)).toEqual(["up in nonresponders", "ns"]);
        expect(asObj(series[1]).itemStyle).toEqual({ color: MUTED_CHART_COLOR });
        // The palette assigns a color by the series order, thus a series that names none keeps its place.
        expect("itemStyle" in asObj(series[0])).toBe(false);
    });

    it("mutes the null category of an authored composition too, because the value reads as the null token", () => {
        const option = derive(composedBlock({ series: [{ form: "scatter", encoding: { x: "lfc", y: "p", group: "sig" } }] }), rows);
        const series = asArr(option.series);
        expect(asObj(series[1]).name).toBe("ns");
        // An agent derives the split into a column of its own, thus the null group recedes there as well.
        expect(asObj(series[1]).itemStyle).toEqual({ color: MUTED_CHART_COLOR });
        expect("itemStyle" in asObj(series[0])).toBe(false);
    });

    it("reads the null token in each of its forms, and it folds the case", () => {
        for (const token of ["ns", "NS", "n.s.", "N.S.", "not significant", "Not Significant", "not_significant"]) {
            const tokenRows: ChartRow[] = [
                { gene: "A", lfc: 2.9, p: 0.001, sig: "up" },
                { gene: "B", lfc: -2.4, p: 0.5, sig: token },
            ];
            const series = asArr(derive(composedBlock({ series: [{ form: "scatter", encoding: { x: "lfc", y: "p", group: "sig" } }] }), tokenRows).series);
            expect(asObj(series[1]).itemStyle).toEqual({ color: MUTED_CHART_COLOR });
        }
    });

    it("leaves a category that reads as a finding on the palette", () => {
        const otherRows: ChartRow[] = [
            { gene: "A", lfc: 2.9, p: 0.001, sig: "up" },
            { gene: "B", lfc: -2.4, p: 0.5, sig: "nonsignificant" },
        ];
        const series = asArr(derive(composedBlock({ series: [{ form: "scatter", encoding: { x: "lfc", y: "p", group: "sig" } }] }), otherRows).series);
        // The token set is closed. A near miss states a category of its own, thus it keeps its palette color.
        expect("itemStyle" in asObj(series[1])).toBe(false);
    });

    it("mutes the null category of a grouped quick-path chart", () => {
        const series = asArr(derive(chartBlock("scatter", { x: "gene", y: "lfc", group: "sig" }), rows).series);
        expect(asObj(series[1]).name).toBe("ns");
        expect(asObj(series[1]).itemStyle).toEqual({ color: MUTED_CHART_COLOR });
    });

    it("labels a vertical guide at the axis end, and keeps a horizontal guide at the right edge", () => {
        const option = derive(
            composedBlock({
                series: [{ form: "scatter", encoding: { x: "lfc", y: "p" } }],
                annotations: [
                    { kind: "reference-line", axis: "x", value: 1, label: "effect" },
                    { kind: "reference-line", axis: "y", value: 0.05, label: "p" },
                ],
            }),
            rows,
        );
        const marks = asArr(asObj(asObj(asArr(option.series)[0]).markLine).data);
        expect(marks[0]).toEqual({ xAxis: 1, label: { formatter: "effect", position: "start" } });
        expect(marks[1]).toEqual({ yAxis: 0.05, label: { formatter: "p" } });
    });

    it("names a group-less preset series with the preset title, thus the tooltip reads no machine text", () => {
        const positions: ChartRow[] = [
            { position: 10, p: 0.001 },
            { position: 20, p: 0.5 },
        ];
        // A manhattan splits its rows by no rule of its own, thus one series takes the name of the y channel.
        const series = asArr(derive(chartBlock("manhattan", { x: "position", y: "p" }), positions).series);
        // The `{a}` of the tooltip template reads this name, and the y axis reads the same text.
        expect(asObj(series[0]).name).toBe("−log10(p)");
    });

    it("keeps a declared label over the preset title in the series name too", () => {
        const option = derive(chartBlock("ma", { x: "lfc", y: "p" }, { labels: { p: "Adjusted p-value" } }), rows);
        expect(asObj(asArr(option.series)[0]).name).toBe("Adjusted p-value");
        expect(asObj(option.yAxis).name).toBe("Adjusted p-value");
    });

    it("puts the guide lines on a series that no muted color paints", () => {
        // The null category appears first, thus the carrier of the marks is not the first emitted series.
        const nsFirst: ChartRow[] = [
            { gene: "B", lfc: -2.4, p: 0.5, sig: "ns" },
            { gene: "A", lfc: 2.9, p: 0.001, sig: "up_in_nonresponders" },
        ];
        const series = asArr(derive(chartBlock("volcano", { x: "lfc", y: "p", group: "sig" }), nsFirst).series);
        expect(asObj(series[0]).name).toBe("ns");
        expect(asObj(series[0]).itemStyle).toEqual({ color: MUTED_CHART_COLOR });
        // The runtime strokes a guide in the item color of its carrier, thus a muted carrier greys each guide.
        expect("markLine" in asObj(series[0])).toBe(false);
        expect(asArr(asObj(asObj(series[1]).markLine).data).length).toBe(3);
    });

    it("keeps the guide lines on the first series when every series is muted", () => {
        const allNull: ChartRow[] = [
            { gene: "B", lfc: -2.4, p: 0.5, sig: "ns" },
            { gene: "C", lfc: 0.1, p: 0.9, sig: "ns" },
        ];
        const series = asArr(derive(chartBlock("volcano", { x: "lfc", y: "p", group: "sig" }), allNull).series);
        // No series can carry a guide clear of the muted color, thus each guide still reaches the page.
        expect(asArr(asObj(asObj(series[0]).markLine).data).length).toBe(3);
    });

    it("keeps a horizontal band on its default label position", () => {
        const option = derive(
            composedBlock({
                series: [{ form: "scatter", encoding: { x: "lfc", y: "p" } }],
                annotations: [{ kind: "reference-band", axis: "y", from: 0, to: 1, label: "range" }],
            }),
            rows,
        );
        const areas = asArr(asObj(asObj(asArr(option.series)[0]).markArea).data);
        expect(areas[0]).toEqual([{ yAxis: 0, label: { formatter: "range" } }, { yAxis: 1 }]);
    });

    it("reads a category series name as words, and keeps the raw value in the data rows", () => {
        const option = derive(chartBlock("bar", { x: "gene", y: "lfc", group: "sig" }), rows);
        const series = asArr(option.series);
        expect(asObj(series[0]).name).toBe("up in nonresponders");
        // The legend text is presentation. The plotted pair keeps the cells of the row.
        expect(asObj(series[0]).data).toEqual([["A", 2.9]]);
        expect(asObj(option.xAxis).data).toEqual(["A", "B", "C"]);
    });

    it("prettifies the category half of a named series alone", () => {
        const option = derive(composedBlock({ series: [{ form: "line", encoding: { x: "gene", y: "lfc", group: "sig" }, name: "Effect_size" }] }), rows);
        // The author wrote the series name, thus it reaches the legend as written.
        expect(asObj(asArr(option.series)[0]).name).toBe("Effect_size (up in nonresponders)");
    });

    it("keeps a chart with no preset and no category byte-identical", () => {
        const option = derive(composedBlock({ series: [{ form: "scatter", encoding: { x: "lfc", y: "p" } }] }), rows);
        expect(JSON.stringify(option)).toBe(
            JSON.stringify({
                tooltip: { trigger: "item", formatter: "{a}: {c}" },
                xAxis: { type: "value", scale: true, name: "lfc", nameLocation: "middle", nameGap: 34, axisLabel: { interval: 0 } },
                yAxis: { type: "value", scale: true, name: "p", axisLabel: { interval: 0 } },
                series: [
                    {
                        type: "scatter",
                        name: "p",
                        large: true,
                        largeThreshold: 2000,
                        data: [
                            [2.9, 0.001],
                            [-2.4, 0.5],
                            [0.1, 0.9],
                        ],
                    },
                ],
                legend: { show: false },
                grid: { top: "8%", bottom: "20%", left: "10%", right: "5%" },
                toolbox: { right: 0, top: 0, feature: { saveAsImage: { type: "png", name: "chart" } } },
            }),
        );
    });
});

describe("the quick-path transform", () => {
    it("derives the transformed column, and names the axis after it", () => {
        const rows: ChartRow[] = [
            { g: "A", v: 100 },
            { g: "B", v: 0 },
            { g: "C", v: 1000 },
        ];
        const option = derive(chartBlock("bar", { x: "g", y: { column: "v", transform: "log10" } }), rows);
        expect(asObj(option.yAxis).name).toBe("log10(v)");
        // The zero cell takes no logarithm, thus its row drops and no substitute value appears.
        expect(asObj(option.xAxis).data).toEqual(["A", "C"]);
        expect(asObj(asArr(option.series)[0]).data).toEqual([
            ["A", 2],
            ["C", 3],
        ]);
    });

    it("refuses a transform over a column that no row holds", () => {
        const rows: ChartRow[] = [{ g: "A", v: 100 }];
        const problem = deriveChartOption(chartBlock("bar", { x: "g", y: { column: "invented", transform: "log10" } }, { id: "q1" }), rows)._unsafeUnwrapErr();
        expect(problem.detail).toContain("invented");
    });

    it("refuses a derived name that the bound table already holds", () => {
        // The derived column goes into a copy of each row. A write over a real column of the table would
        // plot the wrong cells under the right name.
        const rows: ChartRow[] = [{ g: "A", v: 100, "log10(v)": 7 }];
        const problem = deriveChartOption(chartBlock("bar", { x: "g", y: { column: "v", transform: "log10" } }, { id: "q2" }), rows)._unsafeUnwrapErr();
        expect(problem.kind).toBe("invalid-chart-input");
        expect(problem.detail).toContain("log10(v)");
    });
});

describe("the composition guards", () => {
    it("refuses a composition that carries no series", () => {
        // The schema holds a composition to one series at least, thus the cast is the only way to reach the
        // guard that protects the axes of the derivation.
        const empty = { series: [] } as unknown as ChartComposition;
        const problem = deriveChartOption(composedBlock(empty, { id: "ce" }), [{ t: 1 }])._unsafeUnwrapErr();
        expect(problem.kind).toBe("invalid-chart-input");
        expect(problem.blockId).toBe("ce");
        expect(problem.detail).toContain("no series");
    });
});

describe("renderChart", () => {
    it("places the JSON script as the immediate next sibling of the container", () => {
        const block = chartBlock("bar", { x: "day", y: "count" }, { id: "b1" });
        const option = derive(block, [{ day: "Mon", count: 1 }]);
        const html = renderChart(block, new ReferenceLedger(), option);
        expect(html).toContain('id="chart-b1"');
        expect(html).toContain('data-echarts-id="b1"');
        expect(html).toContain('</div><script type="application/json">');
    });

    it("escapes a </script> sequence inside a string cell", () => {
        const block = chartBlock("bar", { x: "k", y: "v" }, { id: "b2" });
        const rows: ChartRow[] = [{ k: "a</script>b", v: 1 }];
        const html = renderChart(block, new ReferenceLedger(), derive(block, rows));
        // The hostile close sequence never reaches the page as raw markup.
        expect(html).not.toContain("a</script>b");
        expect(html).toContain("a\\u003c/script>b");
    });

    it("puts the sized container class on the element that carries the option id", () => {
        const block = chartBlock("bar", { x: "day", y: "count" }, { id: "b3" });
        const html = renderChart(block, new ReferenceLedger(), derive(block, [{ day: "Mon", count: 1 }]));
        // The bootstrap finds the container by `data-echarts-id`, and the style sheet sizes it by the
        // `chart-container` class. The two must sit on one element. A class on a different element, or no
        // class at all, gives the chart runtime a box of zero height and the chart draws into nothing.
        expect(html).toMatch(/<div[^>]*\bdata-echarts-id="b3"[^>]*\bclass="chart-container"[^>]*>/);
    });

    it("wraps the chart in the corner-accent card under the mono title line", () => {
        const block = chartBlock("bar", { x: "day", y: "count" }, { id: "b4", title: "Panel title" });
        const html = renderChart(block, new ReferenceLedger(), derive(block, [{ day: "Mon", count: 1 }]));
        // The title line carries the marker of the whole-table binding, thus the card names its appendix
        // entry beside its title.
        expect(html).toContain(`<div class="report-chart-title">Panel title<span class="report-marker"><a href="#ref-1">[1]</a></span></div>`);
        expect(html).toContain(`class="report-chart-card corner-accents"`);
    });

    it("wears no window costume", () => {
        const block = chartBlock("bar", { x: "day", y: "count" }, { id: "b5", title: "Panel title" });
        const html = renderChart(block, new ReferenceLedger(), derive(block, [{ day: "Mon", count: 1 }]));
        // A report is a document. The dots, the badge, and the chrome bar make a data card read as an
        // application window, thus the card carries none of them.
        expect(html).not.toContain("window-chrome");
        expect(html).not.toContain("chrome-dot");
        expect(html).not.toContain("CORTEX");
        // Each dead class rule leaves the design source with its emitter.
        expect(DESIGN_CSS).not.toContain("window-chrome");
        expect(DESIGN_CSS).not.toContain("chrome-dot");
        expect(DESIGN_CSS).not.toContain("chrome-dots");
    });

    it("gives the card the square corners and no hover raise", () => {
        // The corner-accent card is the one geometry of a data card. A border radius on the chart, or a
        // transform under hover, brings the window costume back through the style sheet.
        const cardRules = [...DESIGN_CSS.matchAll(/\.report-chart-card[^{]*\{([^}]*)\}/g)].map((match) => match[1]);
        expect(cardRules.length).toBeGreaterThan(0);
        for (const body of cardRules) {
            expect(body).not.toContain("border-radius");
            expect(body).not.toContain("transform");
        }
    });
});

describe("the chart container style rule", () => {
    /** The declaration body of each `.chart-container` rule of a style sheet. */
    function chartContainerRules(css: string): string[] {
        return [...css.matchAll(/\.chart-container\s*\{([^}]*)\}/g)].map((match) => match[1]);
    }

    it("declares a height on the chart container", () => {
        const rules = chartContainerRules(DESIGN_CSS);
        expect(rules.length).toBeGreaterThan(0);

        // The chart runtime measures the container at initialization. A rule with no height, or a height of
        // zero, gives a box that shows no chart even though every other gate stays green.
        const heights = rules.flatMap((body) => [...body.matchAll(/(?:^|;)\s*height\s*:\s*([^;]+)/g)].map((match) => match[1].trim()));
        expect(heights.length).toBeGreaterThan(0);
        expect(heights.some((height) => /^[1-9][\d.]*(?:px|rem|em|vh|%)$/.test(height))).toBe(true);
    });
});

describe("the dense chart reads the shared payload", () => {
    const COLUMNS = ["gene", "log2fc", "padj", "arm"];

    /** A differential-expression table of `count` rows: a name, an effect, a p-value, and one of two arms. */
    function denseRows(count: number): ChartRow[] {
        const rows: ChartRow[] = [];
        for (let index = 0; index < count; index += 1) {
            rows.push({ gene: `G${index}`, log2fc: (index % 400) / 100 - 2, padj: (index + 1) / (count * 10), arm: index % 3 === 0 ? "a" : "b" });
        }
        return rows;
    }

    /** The volcano of the bound table, with a name on each point. */
    const volcano: ChartBlock = chartBlock("volcano", { x: "log2fc", y: "padj", label: "gene" });

    /** The payload that a dense chart reads: the block id, and the columns of the encoded table. */
    const target = { key: "c1", columns: COLUMNS };

    /** The data source of one derived option, or `undefined` where the option carries its rows. */
    function sourceOf(option: EchartOption): ChartDataSource | undefined {
        return option[CHART_SOURCE_MEMBER] as ChartDataSource | undefined;
    }

    it("keeps a chart under the bound byte-identical to the inline derivation", () => {
        const rows = denseRows(20);
        const render = deriveChartRender(volcano, rows, COLUMNS, target)._unsafeUnwrap();

        // A small chart carries its own rows, exactly as it did before the payload rule. The bytes are the
        // page, thus the test compares the serialization and not the shape.
        expect(render.readsPayload).toBe(false);
        expect(JSON.stringify(render.option)).toBe(JSON.stringify(derive(volcano, rows, COLUMNS)));
        expect(sourceOf(render.option)).toBeUndefined();
    });

    it("ships no per-row data past the bound, and names the payload of its artifact", () => {
        const rows = denseRows(6000);
        const inline = derive(volcano, rows, COLUMNS);
        const render = deriveChartRender(volcano, rows, COLUMNS, target)._unsafeUnwrap();

        // The inline form of this chart is the fault that the rule exists for.
        expect(JSON.stringify(inline).length).toBeGreaterThan(CHART_INLINE_OPTION_BOUND);
        expect(render.readsPayload).toBe(true);
        for (const series of asArr(render.option.series)) {
            expect(asObj(series).data).toEqual([]);
        }
        const json = JSON.stringify(render.option);
        expect(json.length).toBeLessThan(CHART_INLINE_OPTION_BOUND);
        // No cell of the table reaches the option, thus the page holds one copy of the rows.
        expect(json).not.toContain("G4001");
        expect(sourceOf(render.option)?.payload).toBe("c1");
    });

    it("describes each series by the payload columns, the transform, and the classification", () => {
        const source = sourceOf(deriveChartRender(volcano, denseRows(6000), COLUMNS, target)._unsafeUnwrap().option);

        // The preset splits the rows itself, thus each series names its category and the rule carries the
        // two cuts that the guides draw.
        expect(source?.rule).toEqual({ kind: "volcano", cut: -Math.log10(VOLCANO_P_THRESHOLD), effect: VOLCANO_EFFECT_THRESHOLD });
        expect(source?.series.map((entry) => entry.category)).toEqual([0, 1, 2]);
        for (const entry of source?.series ?? []) {
            expect(entry.x).toEqual({ column: 1 });
            expect(entry.y).toEqual({ column: 2, transform: "neg_log10" });
            expect(entry.label).toBe(0);
        }
    });

    it("names the group value and the flagged rows of a composition series", () => {
        const composed = composedBlock({
            series: [{ form: "line", encoding: { x: { column: "padj", transform: "rank" }, y: "log2fc", group: "arm", label: "gene" } }],
            annotations: [{ kind: "point-labels", column: "padj", order: "asc", n: 6 }],
        });
        const source = sourceOf(deriveChartRender(composed, denseRows(6000), COLUMNS, target)._unsafeUnwrap().option);

        expect(source?.series.map((entry) => entry.value)).toEqual(["a", "b"]);
        expect(source?.series[0].group).toEqual({ column: 3 });
        // A line draws along the x axis, thus the page sorts its points as the derivation does.
        expect(source?.series[0].sort).toBe(true);
        // The flags name the rows of the payload, thus each split carries the labels of the rows that it
        // holds and the two lists together hold the declared count.
        expect([...(source?.series[0].flags ?? []), ...(source?.series[1].flags ?? [])].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(source?.rule).toBeUndefined();
    });

    it("keeps a band inline, because no descriptor states the difference of two columns", () => {
        const band = composedBlock({
            series: [{ form: "area", encoding: { x: "log2fc", y: "padj", y0: "padj" } }],
        });
        const rows = denseRows(9000);
        const render = deriveChartRender(band, rows, COLUMNS, target)._unsafeUnwrap();

        expect(render.readsPayload).toBe(false);
        expect(JSON.stringify(render.option)).toBe(JSON.stringify(derive(band, rows, COLUMNS)));
    });

    it("keeps a base chart type inline, because its data is no per-row pair of the payload", () => {
        const histogram = chartBlock("histogram", { x: "log2fc" });
        const rows = denseRows(6000);

        // A histogram bins its rows, thus no descriptor rebuilds its bars from the columns.
        expect(deriveChartRender(histogram, rows, COLUMNS, target)._unsafeUnwrap().readsPayload).toBe(false);
    });

    it("keeps a chart inline when the payload holds no column of a channel", () => {
        const rows = denseRows(6000);
        const render = deriveChartRender(volcano, rows, COLUMNS, { key: "c1", columns: ["gene", "padj"] })._unsafeUnwrap();

        // A page-side build reads the columns of the payload. A channel that names none of them describes
        // nothing, thus the chart keeps its own rows.
        expect(render.readsPayload).toBe(false);
    });

    it("gives one option for one input, thus two derivations match", () => {
        const rows = denseRows(6000);
        const first = deriveChartRender(volcano, rows, COLUMNS, target)._unsafeUnwrap();
        const second = deriveChartRender(volcano, rows, COLUMNS, target)._unsafeUnwrap();

        expect(JSON.stringify(second.option)).toBe(JSON.stringify(first.option));
    });
});

/**
 * The shared vector of the channel transforms.
 *
 * A chart that reads the payload transforms its columns in the browser. Thus one rule has two
 * realizations: `transformColumn` here, and the `reportTransform` fragment that the chart bootstrap
 * inlines. Each entry runs through both, and the two must give one list of numbers.
 */
describe("the channel transform", () => {
    /** One entry of the vector: the cells of one column, the transform, and the values that it gives. */
    interface Entry {
        readonly cells: (string | number)[];
        readonly transform: ChartTransform;
        readonly expected: (number | null)[];
    }

    const VECTOR: readonly Entry[] = [
        // `log10` and `neg_log10` give no value for a cell that is not positive, thus such a point drops.
        { cells: [1, 10, 0.001], transform: "log10", expected: [0, 1, -3] },
        { cells: [0, -2, "0.01"], transform: "log10", expected: [null, null, -2] },
        { cells: [0.05, 1e-8, "2.7e-10"], transform: "neg_log10", expected: [-Math.log10(0.05), 8, -Math.log10(2.7e-10)] },
        { cells: ["NA", "", 0], transform: "neg_log10", expected: [null, null, null] },
        // `abs` reads a negative cell and a numeric text alike.
        { cells: [-3.5, 2, "-1.25"], transform: "abs", expected: [3.5, 2, 1.25] },
        // A competition rank shares a place on a tie, thus the place after a tie of two skips one number.
        { cells: [5, 1, 5, 2], transform: "rank", expected: [3, 1, 3, 2] },
        { cells: ["10", "9", "NA", "9"], transform: "rank", expected: [3, 1, null, 1] },
        { cells: [0, -0, 2], transform: "rank", expected: [1, 1, 3] },
    ];

    /**
     * The client transform, as the page runs it.
     *
     * The fragment is browser source text. A read of that text would state the serialization and not the
     * numbers that a chart plots, thus the test runs the fragment and calls its one entry point.
     */
    const transformOnThePage = new Function(`${CHART_SERIES_BUILDER}\nreturn reportTransform;`)() as (
        cells: (string | number)[],
        transform: ChartTransform,
    ) => (number | null)[];

    /** The server transform of one column of cells. The helper reads rows, thus each cell rides one row. */
    function transformOnTheServer(entry: Entry): (number | null)[] {
        return transformColumn(
            entry.cells.map((cell) => ({ value: cell })),
            "value",
            entry.transform,
        );
    }

    it("gives the stated values on the server", () => {
        expect(VECTOR.map(transformOnTheServer)).toEqual(VECTOR.map((entry) => entry.expected));
    });

    it("gives the same values on the page as on the server, for every entry", () => {
        const server = VECTOR.map(transformOnTheServer);
        const page = VECTOR.map((entry) => transformOnThePage(entry.cells, entry.transform));
        expect(page).toEqual(server);
    });
});
