import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../contracts/report-blocks.js";
import { renderChart } from "./views/chart-view.js";
import { deriveChartOption, type ChartRow, type EchartOption } from "./chart.js";
import { DESIGN_CSS } from "./design.js";

type Encoding = ChartBlock["encoding"];
type ChartType = ChartBlock["chartType"];

/** Build a chart block with a placeholder binding. The renderer never reads the binding. */
function chartBlock(chartType: ChartType, encoding: Encoding, extra: { id?: string; title?: string; caption?: string } = {}): ChartBlock {
    return {
        kind: "chart",
        id: extra.id ?? "c1",
        binding: { kind: "artifact-table", path: "table.csv", hash: "sha256:00" },
        chartType,
        encoding,
        ...(extra.title !== undefined ? { title: extra.title } : {}),
        ...(extra.caption !== undefined ? { caption: extra.caption } : {}),
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

describe("renderChart", () => {
    it("places the JSON script as the immediate next sibling of the container", () => {
        const block = chartBlock("bar", { x: "day", y: "count" }, { id: "b1" });
        const option = derive(block, [{ day: "Mon", count: 1 }]);
        const html = renderChart(block, option);
        expect(html).toContain('id="chart-b1"');
        expect(html).toContain('data-echarts-id="b1"');
        expect(html).toContain('</div><script type="application/json">');
    });

    it("escapes a </script> sequence inside a string cell", () => {
        const block = chartBlock("bar", { x: "k", y: "v" }, { id: "b2" });
        const rows: ChartRow[] = [{ k: "a</script>b", v: 1 }];
        const html = renderChart(block, derive(block, rows));
        // The hostile close sequence never reaches the page as raw markup.
        expect(html).not.toContain("a</script>b");
        expect(html).toContain("a\\u003c/script>b");
    });

    it("puts the sized container class on the element that carries the option id", () => {
        const block = chartBlock("bar", { x: "day", y: "count" }, { id: "b3" });
        const html = renderChart(block, derive(block, [{ day: "Mon", count: 1 }]));
        // The bootstrap finds the container by `data-echarts-id`, and the style sheet sizes it by the
        // `chart-container` class. The two must sit on one element. A class on a different element, or no
        // class at all, gives the chart runtime a box of zero height and the chart draws into nothing.
        expect(html).toMatch(/<div[^>]*\bdata-echarts-id="b3"[^>]*\bclass="chart-container"[^>]*>/);
    });

    it("wraps the chart in the chrome header with its three dots and the product badge", () => {
        const block = chartBlock("bar", { x: "day", y: "count" }, { id: "b4", title: "Panel title" });
        const html = renderChart(block, derive(block, [{ day: "Mon", count: 1 }]));
        expect(html).toContain(`class="window-chrome-bar"`);
        // The three dots are the window-chrome signature of the panel.
        expect(html.match(/class="chrome-dot dot-\d"/g)).toHaveLength(3);
        expect(html).toContain(`<span class="window-chrome-badge">CORTEX</span>`);
        expect(html).toContain(`<span class="window-chrome-title">Panel title</span>`);
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
