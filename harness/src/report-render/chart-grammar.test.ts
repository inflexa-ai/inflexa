/**
 * The derivation of the wide chart grammar: the continuous channels, the interval, the order, the focus,
 * the value labels, the new forms, the facet, and the removal of the toolbox.
 */

import { describe, expect, it } from "bun:test";

import type { ChartBlock, ChartComposition } from "../contracts/report-blocks.js";
import { CHART_SOURCE_MEMBER, deriveChartOption, deriveChartRender, type ChartDataSource, type ChartRow, type EchartOption } from "./chart.js";
import { INTERVAL_RENDERER, OUTLINE_RENDERER, VIOLIN_GRID_POINTS } from "./chart-renderers.js";
import { CHART_BODY_PX, CHART_INLINE_OPTION_BOUND, DIVERGING_RAMP, FACET_ROW_PX, FOCUS_CHART_COLOR, MUTED_CHART_COLOR, SEQUENTIAL_RAMP } from "./design.js";
import { CHART_SERIES_BUILDER } from "./page.js";
import type { RenderProblem } from "./types.js";

type Encoding = NonNullable<ChartBlock["encoding"]>;
type ChartType = NonNullable<ChartBlock["chartType"]>;

/** Build a quick-path chart block. */
function quick(chartType: ChartType, encoding: Encoding, extra: Partial<Pick<ChartBlock, "focus" | "orientation" | "binding">> = {}): ChartBlock {
    return {
        kind: "chart",
        id: "c1",
        binding: extra.binding ?? { kind: "artifact-table", path: "table.csv", hash: "sha256:00" },
        chartType,
        encoding,
        ...(extra.orientation !== undefined ? { orientation: extra.orientation } : {}),
        ...(extra.focus !== undefined ? { focus: extra.focus } : {}),
    };
}

/** Build a chart block that carries one composition. */
function composed(composition: ChartComposition, focus?: string[]): ChartBlock {
    return {
        kind: "chart",
        id: "c1",
        binding: { kind: "artifact-table", path: "table.csv", hash: "sha256:00" },
        composition,
        ...(focus !== undefined ? { focus } : {}),
    };
}

function asObj(value: unknown): Record<string, unknown> {
    return value as Record<string, unknown>;
}

function asArr(value: unknown): unknown[] {
    return value as unknown[];
}

function derive(block: ChartBlock, rows: ChartRow[], columns?: string[]): EchartOption {
    return deriveChartOption(block, rows, columns)._unsafeUnwrap();
}

function refusal(block: ChartBlock, rows: ChartRow[]): RenderProblem {
    return deriveChartOption(block, rows)._unsafeUnwrapErr();
}

/** The series list of one option. */
function seriesOf(option: EchartOption): Record<string, unknown>[] {
    return asArr(option.series).map(asObj);
}

/** The visual maps of one option, as a list. */
function mapsOf(option: EchartOption): Record<string, unknown>[] {
    const maps = option.visualMap;
    if (maps === undefined) return [];
    return Array.isArray(maps) ? maps.map(asObj) : [asObj(maps)];
}

/** An embedding of `count` cells. The expression column holds no negative value, and the fold change column crosses zero. */
function embedding(count: number): ChartRow[] {
    const rows: ChartRow[] = [];
    for (let index = 0; index < count; index += 1) {
        rows.push({
            cell: `c${index}`,
            umap1: (index % 97) / 10,
            umap2: (index % 89) / 10,
            expr: (index % 13) / 2,
            lfc: (index % 9) - 4,
            depth: 10 + (index % 7),
        });
    }
    return rows;
}

describe("the continuous color and the size", () => {
    it("colors an embedding by expression on the sequential scale, and leaves the large path", () => {
        const rows = embedding(40);
        const option = derive(quick("scatter", { x: "umap1", y: "umap2", color: "expr" }), rows);
        const maps = mapsOf(option);

        expect(maps.length).toBe(1);
        expect(maps[0]).toEqual(expect.objectContaining({ type: "continuous", dimension: 2, min: 0, max: 6, inRange: { color: [...SEQUENTIAL_RAMP] } }));
        const series = seriesOf(option).filter((entry) => entry.type === "scatter");
        expect(series.length).toBe(1);
        // The large path draws one fill, thus a colored series never takes it.
        expect(series[0].large).toBeUndefined();
        expect(asArr(series[0].data)[1]).toEqual([0.1, 0.1, 0.5]);
        expect(maps[0].seriesIndex).toEqual([0]);
    });

    it("colors a fold change on the diverging scale, with zero at its center", () => {
        const option = derive(quick("scatter", { x: "umap1", y: "umap2", color: "lfc" }), embedding(40));
        const map = mapsOf(option)[0];
        expect(map.inRange).toEqual({ color: [...DIVERGING_RAMP] });
        expect(map.min).toBe(-4);
        expect(map.max).toBe(4);
    });

    it("gives a z-score heatmap the diverging scale", () => {
        const rows: ChartRow[] = [
            { gene: "A", sample: "s1", z: -1.5 },
            { gene: "A", sample: "s2", z: 0.5 },
            { gene: "B", sample: "s1", z: 2 },
            { gene: "B", sample: "s2", z: -0.25 },
        ];
        const option = derive(quick("heatmap", { x: "sample", y: "gene", value: "z" }), rows);
        const map = mapsOf(option)[0];
        expect(map.inRange).toEqual({ color: [...DIVERGING_RAMP] });
        expect([map.min, map.max]).toEqual([-2, 2]);
        // The scale stands at the right edge, thus it never covers the name of the x axis. It shows no drag
        // control, and the number helper prints its two ends under the title.
        expect([map.orient, map.right, map.calculable]).toEqual(["vertical", 0, false]);
        expect(map.text).toEqual(["z\n2", "−2"]);
        expect(asObj(option.grid).right).toBe("18%");
    });

    it("keeps a heatmap that holds no negative value on the sequential scale", () => {
        const rows: ChartRow[] = [
            { gene: "A", sample: "s1", count: 1 },
            { gene: "B", sample: "s1", count: 5 },
        ];
        const map = mapsOf(derive(quick("heatmap", { x: "sample", y: "gene", value: "count" }), rows))[0];
        expect(map.inRange).toEqual({ color: [...SEQUENTIAL_RAMP] });
        expect([map.min, map.max]).toEqual([1, 5]);
    });

    it("sizes and colors an enrichment dot plot with two visual maps", () => {
        const rows: ChartRow[] = [
            { pathway: "Hypoxia", ratio: 0.3, count: 40, padj: 0.001 },
            { pathway: "Glycolysis", ratio: 0.2, count: 25, padj: 0.01 },
            { pathway: "Apoptosis", ratio: 0.1, count: 12, padj: 0.04 },
        ];
        const option = derive(quick("scatter", { x: "ratio", y: "pathway", size: "count", color: "padj" }), rows);
        const maps = mapsOf(option);
        const size = maps.find((map) => asObj(map.inRange).symbolSize !== undefined);
        const color = maps.find((map) => asObj(map.inRange).color !== undefined);

        expect(size).toEqual(expect.objectContaining({ show: false, dimension: 3, min: 12, max: 40 }));
        // The number helper prints each end in the form of its column, thus a small p reads in the exponent form.
        expect(color).toEqual(expect.objectContaining({ dimension: 2, min: 0.001, max: 0.04, calculable: false, text: ["padj\n0.04", "1 × 10⁻³"] }));
        expect(asArr(seriesOf(option)[0].data)[0]).toEqual([0.3, "Hypoxia", 0.001, 40]);
    });

    it("colors a bar by a numeric column", () => {
        const rows: ChartRow[] = [
            { pathway: "Hypoxia", nes: 2.4, padj: 0.001 },
            { pathway: "Apoptosis", nes: -1.4, padj: 0.03 },
        ];
        const option = derive(quick("bar", { x: "pathway", y: "nes", color: "padj" }), rows);
        expect(mapsOf(option)[0]).toEqual(expect.objectContaining({ dimension: 2, seriesIndex: [0] }));
        const first = asArr(seriesOf(option)[0].data)[0];
        expect(asObj(first).value ?? first).toEqual(["Hypoxia", 2.4, 0.001]);
    });

    it("drops a row whose color cell is not numeric, and draws the others", () => {
        const rows: ChartRow[] = [
            { a: 1, b: 2, c: 0.5 },
            { a: 2, b: 3, c: "NA" },
            { a: 3, b: 4, c: 1.5 },
        ];
        const data = asArr(seriesOf(derive(quick("scatter", { x: "a", y: "b", color: "c" }), rows))[0].data);
        expect(data).toEqual([
            [1, 2, 0.5],
            [3, 4, 1.5],
        ]);
    });

    it("refuses a color beside a group, a color on a line, and a size on a bar", () => {
        const rows: ChartRow[] = [{ a: 1, b: 2, c: 3, g: "x" }];
        expect(refusal(quick("scatter", { x: "a", y: "b", color: "c", group: "g" }), rows).detail).toContain('"group"');
        expect(refusal(quick("line", { x: "a", y: "b", color: "c" }), rows).detail).toContain("line");
        expect(refusal(quick("bar", { x: "a", y: "b", size: "c" }), rows).detail).toContain("bar");
        expect(refusal(composed({ series: [{ form: "line", encoding: { x: "a", y: "b", color: "c" } }] }), rows).detail).toContain("line");
    });
});

describe("the payload of a dense colored scatter", () => {
    const COLUMNS = ["cell", "umap1", "umap2", "expr", "lfc", "depth"];
    const target = { key: "c1", columns: COLUMNS };

    /** The page twin of the series build. */
    const seriesDataOnThePage = new Function(`${CHART_SERIES_BUILDER}\nreturn reportSeriesData;`)() as (
        payload: { columns: string[]; rows: ChartRow[] },
        source: ChartDataSource["series"][number],
        rule: unknown,
    ) => unknown[];

    it("names the color and the size columns in the descriptor, and the page builds the four-member items", () => {
        const rows = embedding(9000);
        const block = quick("scatter", { x: "umap1", y: "umap2", color: "expr", size: "depth" });
        const render = deriveChartRender(block, rows, COLUMNS, target)._unsafeUnwrap();

        expect(JSON.stringify(derive(block, rows, COLUMNS)).length).toBeGreaterThan(CHART_INLINE_OPTION_BOUND);
        expect(render.readsPayload).toBe(true);
        const source = render.option[CHART_SOURCE_MEMBER] as ChartDataSource;
        expect(source.series[0].color).toEqual({ column: 3 });
        expect(source.series[0].size).toEqual({ column: 5 });

        // The page reads the decoded rows, and it builds the same items as the inline derivation.
        const page = seriesDataOnThePage({ columns: COLUMNS, rows }, source.series[0], undefined);
        const inline = asArr(seriesOf(derive(block, rows, COLUMNS))[0].data);
        expect(page.length).toBe(9000);
        expect(page[1]).toEqual([0.1, 0.1, 0.5, 11]);
        expect(JSON.stringify(page)).toBe(JSON.stringify(inline));
    });

    it("drops a row whose color cell is not numeric on the page too", () => {
        const rows = embedding(9000).map((row, index) => (index === 1 ? { ...row, expr: "NA" } : row));
        const block = quick("scatter", { x: "umap1", y: "umap2", color: "expr" });
        const source = deriveChartRender(block, rows, COLUMNS, target)._unsafeUnwrap().option[CHART_SOURCE_MEMBER] as ChartDataSource;
        const page = seriesDataOnThePage({ columns: COLUMNS, rows }, source.series[0], undefined);
        expect(JSON.stringify(page)).toBe(JSON.stringify(asArr(seriesOf(derive(block, rows, COLUMNS))[0].data)));
        expect(page.length).toBe(8999);
    });
});

describe("the interval", () => {
    const forest: ChartRow[] = [
        { study: "A", hr: 0.8, lo: 0.6, hi: 1.1 },
        { study: "B", hr: 1.3, lo: 1.0, hi: 1.7 },
        { study: "C", hr: 0.95, lo: 0.7, hi: 1.25 },
    ];

    /** The interval series of one option. */
    function intervalsOf(option: EchartOption): Record<string, unknown>[] {
        return seriesOf(option).filter((entry) => entry.renderItem === INTERVAL_RENDERER);
    }

    it("draws a forest plot: one custom series after the points, each item along x", () => {
        const option = derive(quick("scatter", { x: "hr", y: "study", low: "lo", high: "hi" }), forest);
        const series = seriesOf(option);
        expect(series.map((entry) => entry.type)).toEqual(["scatter", "custom"]);
        const interval = series[1];
        expect(interval.renderItem).toBe(INTERVAL_RENDERER);
        expect(interval.silent).toBe(true);
        // The study axis draws categories, thus the interval lies along x and names its extent there.
        expect(interval.encode).toEqual({ x: [0, 2, 3], y: 1 });
        expect(interval.data).toEqual([
            [0.8, 0, 0.6, 1.1, 0, 0, 0],
            [1.3, 1, 1.0, 1.7, 0, 0, 0],
            [0.95, 2, 0.7, 1.25, 0, 0, 0],
        ]);
        // The JSON holds the name of the renderer, and never a function.
        expect(JSON.stringify(option)).not.toContain("function");
    });

    it("puts the interval of a vertical bar on y, and the interval of a horizontal bar on x", () => {
        const rows: ChartRow[] = [
            { arm: "a", mean: 4, lo: 3, hi: 5 },
            { arm: "b", mean: 6, lo: 5, hi: 11 },
        ];
        const vertical = intervalsOf(derive(quick("bar", { x: "arm", y: "mean", low: "lo", high: "hi" }), rows))[0];
        expect(vertical.encode).toEqual({ x: 0, y: [1, 2, 3] });
        expect(vertical.data).toEqual([
            [0, 4, 3, 5, 1, 0, 0],
            [1, 6, 5, 11, 1, 0, 0],
        ]);

        const horizontal = intervalsOf(derive(quick("bar", { x: "arm", y: "mean", low: "lo", high: "hi" }, { orientation: "horizontal" }), rows))[0];
        expect(horizontal.encode).toEqual({ x: [0, 2, 3], y: 1 });
        expect(horizontal.data).toEqual([
            [4, 0, 3, 5, 0, 0, 0],
            [6, 1, 5, 11, 0, 0, 0],
        ]);
    });

    it("gives each interval of a grouped bar the band offset of its group", () => {
        const rows: ChartRow[] = [
            { arm: "a", dose: "low", mean: 4, lo: 3, hi: 5 },
            { arm: "a", dose: "high", mean: 6, lo: 5, hi: 7 },
            { arm: "b", dose: "low", mean: 3, lo: 2, hi: 4 },
            { arm: "b", dose: "high", mean: 5, lo: 4, hi: 6 },
        ];
        const intervals = intervalsOf(derive(quick("bar", { x: "arm", y: "mean", group: "dose", low: "lo", high: "hi" }), rows));
        const offsets = intervals.map((entry) => asArr(asArr(entry.data)[0])[5]);
        expect(offsets).toEqual([-0.2, 0.2]);
        // The interval of a group carries the name of the group, thus the legend names each group one time.
        expect(intervals.map((entry) => entry.name)).toEqual(["low", "high"]);
        expect(asObj(derive(quick("bar", { x: "arm", y: "mean", group: "dose", low: "lo", high: "hi" }), rows).legend).data).toEqual([
            { name: "low", icon: "rect" },
            { name: "high", icon: "rect" },
        ]);
    });

    it("refuses a bound on the wrong side of its value, and names the row", () => {
        const rows: ChartRow[] = [
            { study: "A", hr: 0.8, lo: 0.6, hi: 1.1 },
            { study: "B", hr: 1.3, lo: 1.4, hi: 1.7 },
        ];
        const problem = refusal(quick("scatter", { x: "hr", y: "study", low: "lo", high: "hi" }), rows);
        expect(problem.blockId).toBe("c1");
        expect(problem.detail).toContain("row 2");
    });

    it("refuses an interval on a line", () => {
        expect(refusal(quick("line", { x: "t", y: "v", low: "lo", high: "hi" }), [{ t: 1, v: 2, lo: 1, hi: 3 }]).detail).toContain("line");
    });

    it("keeps a dense interval scatter inline, and each interval draws", () => {
        const rows: ChartRow[] = [];
        for (let index = 0; index < 5000; index += 1) {
            rows.push({ x: index, y: index % 50, lo: (index % 50) - 1, hi: (index % 50) + 1 });
        }
        const block = quick("scatter", { x: "x", y: "y", low: "lo", high: "hi" });
        const render = deriveChartRender(block, rows, ["x", "y", "lo", "hi"], { key: "c1", columns: ["x", "y", "lo", "hi"] })._unsafeUnwrap();
        expect(JSON.stringify(render.option).length).toBeGreaterThan(CHART_INLINE_OPTION_BOUND);
        expect(render.readsPayload).toBe(false);
        expect(asArr(intervalsOf(render.option)[0].data).length).toBe(5000);
        // One drawn series, thus the legend shows nothing, and the interval shows no orphan entry.
        expect(render.option.legend).toEqual({ show: false });
    });
});

describe("the category order", () => {
    it("sorts both axes of a heatmap by the leaf order of two columns", () => {
        const rows: ChartRow[] = [
            { gene: "A", sample: "s1", z: 1, gx: 2, sx: 3 },
            { gene: "B", sample: "s2", z: 2, gx: 1, sx: 1 },
            { gene: "C", sample: "s3", z: 3, gx: 3, sx: 2 },
        ];
        const option = derive(
            quick("heatmap", { x: { column: "sample", orderBy: "sx" }, y: { column: "gene", orderBy: "gx", order: "desc" }, value: "z" }),
            rows,
        );
        expect(asObj(option.xAxis).data).toEqual(["s2", "s3", "s1"]);
        expect(asObj(option.yAxis).data).toEqual(["C", "A", "B"]);
    });

    it("keeps first appearance on a tie, and compares a text key as text", () => {
        const rows: ChartRow[] = [
            { k: "a", v: 1, rank: "b" },
            { k: "b", v: 2, rank: "a" },
            { k: "c", v: 3, rank: "b" },
        ];
        expect(asObj(derive(quick("bar", { x: { column: "k", orderBy: "rank" }, y: "v" }), rows).xAxis).data).toEqual(["b", "a", "c"]);
        const numericText: ChartRow[] = [
            { k: "a", v: 1, rank: "10" },
            { k: "b", v: 2, rank: "9" },
        ];
        // Two numeric texts compare as numbers, thus `9` sorts before `10`.
        expect(asObj(derive(quick("bar", { x: { column: "k", orderBy: "rank" }, y: "v" }), numericText).xAxis).data).toEqual(["b", "a"]);
    });

    it("sorts the categories of a box and of a violin", () => {
        const rows: ChartRow[] = [];
        for (const [k, rank] of [
            ["late", 2],
            ["early", 1],
        ] as const) {
            for (let index = 0; index < 6; index += 1) rows.push({ k, v: index, rank });
        }
        expect(asObj(derive(quick("box", { x: { column: "k", orderBy: "rank" }, y: "v" }), rows).xAxis).data).toEqual(["early", "late"]);
        expect(asObj(derive(quick("violin", { x: { column: "k", orderBy: "rank" }, y: "v" }), rows).xAxis).data).toEqual(["early", "late"]);
    });

    it("refuses a category whose rows hold two different keys, and names the category", () => {
        const rows: ChartRow[] = [
            { k: "a", v: 1, rank: 1 },
            { k: "a", v: 2, rank: 2 },
        ];
        const problem = refusal(quick("bar", { x: { column: "k", orderBy: "rank" }, y: "v" }), rows);
        expect(problem.detail).toContain('"a"');
    });

    it("refuses an order on a channel that draws no category axis", () => {
        const rows: ChartRow[] = [{ k: "a", v: 1, rank: 1 }];
        expect(refusal(quick("bar", { x: "k", y: { column: "v", orderBy: "rank" } }), rows).detail).toContain("orderBy");
        expect(refusal(quick("scatter", { x: { column: "v", orderBy: "rank" }, y: "v" }), rows).detail).toContain("orderBy");
        expect(refusal(quick("pie", { group: { column: "k", orderBy: "rank" }, value: "v" }), rows).detail).toContain("orderBy");
    });
});

describe("the focus", () => {
    const rows: ChartRow[] = [
        { pathway: "Hypoxia", nes: 2.4 },
        { pathway: "Glycolysis", nes: 2.1 },
        { pathway: "Apoptosis", nes: -1.4 },
        { pathway: "p53", nes: -1.9 },
    ];

    it("gives the two named bars the one focus color, and mutes each other bar", () => {
        const data = asArr(seriesOf(derive(quick("bar", { x: "pathway", y: "nes" }, { focus: ["Hypoxia", "p53"] }), rows))[0].data).map(asObj);
        expect(data.map((item) => asObj(item.itemStyle).color)).toEqual([FOCUS_CHART_COLOR, MUTED_CHART_COLOR, MUTED_CHART_COLOR, FOCUS_CHART_COLOR]);
    });

    it("colors each series of a grouped chart by its group value", () => {
        const grouped: ChartRow[] = [
            { day: 1, size: 2, arm: "treated" },
            { day: 1, size: 3, arm: "control" },
            { day: 2, size: 4, arm: "sham" },
        ];
        const series = seriesOf(derive(quick("line", { x: "day", y: "size", group: "arm" }, { focus: ["treated"] }), grouped));
        expect(series.map((entry) => asObj(entry.itemStyle).color)).toEqual([FOCUS_CHART_COLOR, MUTED_CHART_COLOR, MUTED_CHART_COLOR]);
        const viaComposition = seriesOf(
            derive(composed({ series: [{ form: "scatter", encoding: { x: "day", y: "size", group: "arm" } }] }, ["sham"]), grouped),
        );
        expect(viaComposition.map((entry) => asObj(entry.itemStyle).color)).toEqual([MUTED_CHART_COLOR, MUTED_CHART_COLOR, FOCUS_CHART_COLOR]);
    });

    it("refuses a focus value that no category holds", () => {
        expect(refusal(quick("bar", { x: "pathway", y: "nes" }, { focus: ["Hypoxia", "Mitosis"] }), rows).detail).toContain('"Mitosis"');
    });

    it("refuses a focus on a pie, on an ungrouped scatter, and beside a color channel", () => {
        expect(refusal(quick("pie", { group: "pathway", value: "nes" }, { focus: ["Hypoxia"] }), rows).detail).toContain("pie");
        expect(refusal(quick("scatter", { x: "nes", y: "nes" }, { focus: ["Hypoxia"] }), rows).detail).toContain("group");
        expect(refusal(quick("bar", { x: "pathway", y: "nes", color: "nes" }, { focus: ["Hypoxia"] }), rows).detail).toContain('"color"');
    });
});

describe("the value labels of a small bar chart", () => {
    function bars(count: number): ChartRow[] {
        const rows: ChartRow[] = [];
        for (let index = 0; index < count; index += 1) rows.push({ k: `k${index}`, v: 1234.5678 * (index + 1) });
        return rows;
    }

    it("labels each of six bars with the shown form of its value, as a static string", () => {
        const option = derive(quick("bar", { x: "k", y: "v" }), bars(6));
        const data = asArr(seriesOf(option)[0].data).map(asObj);
        expect(data.length).toBe(6);
        expect(data[0]).toEqual({ value: ["k0", 1234.5678], label: { show: true, position: "top", formatter: "1,235" } });
        expect(JSON.stringify(option)).not.toContain("function");
    });

    it("puts the label of a horizontal bar at its right end", () => {
        const data = asArr(seriesOf(derive(quick("bar", { x: "k", y: "v" }, { orientation: "horizontal" }), bars(2)))[0].data).map(asObj);
        expect(asObj(data[0].label).position).toBe("right");
        expect(data[0].value).toEqual([1234.5678, "k0"]);
    });

    it("labels no bar of a chart of thirty bars", () => {
        const data = asArr(seriesOf(derive(quick("bar", { x: "k", y: "v" }), bars(30)))[0].data);
        expect(data.every((item) => Array.isArray(item))).toBe(true);
    });

    it("counts the items across the series", () => {
        const rows: ChartRow[] = [];
        for (let index = 0; index < 7; index += 1) {
            rows.push({ k: `k${index}`, g: "a", v: index }, { k: `k${index}`, g: "b", v: index });
        }
        // Fourteen bars in two series pass the bound, thus no series carries a label.
        for (const entry of seriesOf(derive(quick("bar", { x: "k", y: "v", group: "g" }), rows))) {
            expect(asArr(entry.data).every((item) => Array.isArray(item))).toBe(true);
        }
    });

    it("labels no stacked part", () => {
        const rows: ChartRow[] = [
            { k: "a", g: "x", v: 1 },
            { k: "a", g: "y", v: 2 },
        ];
        const option = derive(quick("stacked-bar", { x: "k", y: "v", group: "g" }), rows);
        expect(JSON.stringify(option)).not.toContain('"label"');
    });
});

describe("the violin", () => {
    /** Twenty values for each category, from a fixed formula. */
    function violinRows(): ChartRow[] {
        const rows: ChartRow[] = [];
        for (let index = 0; index < 20; index += 1) {
            rows.push({ cluster: "a", score: Math.round(10 * Math.sin(index * 1.7)) / 10 + index / 10 });
            rows.push({ cluster: "b", score: 2 + (index % 5) / 2 });
        }
        return rows;
    }

    /** The outline series of one option. */
    function outlinesOf(option: EchartOption): Record<string, unknown>[] {
        return seriesOf(option).filter((entry) => entry.renderItem === OUTLINE_RENDERER);
    }

    it("gives one deterministic outline for each category, symmetric about the category", () => {
        const block = quick("violin", { x: "cluster", y: "score" });
        const first = derive(block, violinRows());
        const second = derive(block, violinRows());
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));

        const outline = outlinesOf(first)[0];
        expect(outline.encode).toEqual({ x: 0, y: [1, 2] });
        const items = asArr(outline.data).map((item) => asArr(item) as number[]);
        expect(items.length).toBe(2);
        const item = items[0];
        expect(item.length).toBe(4 + 2 * VIOLIN_GRID_POINTS);
        expect(item[0]).toBe(0);
        // The grid runs from the minimum to the maximum of the category.
        expect(item[5]).toBe(item[1]);
        expect(item[item.length - 1]).toBe(item[2]);
        // The widest half-width of the chart is 0.4 of one band.
        const widths = items.flatMap((entry) => entry.filter((_value, index) => index >= 4 && index % 2 === 0));
        expect(Math.max(...widths)).toBe(0.4);
    });

    it("carries the median and the quartiles of each category as the inner mark", () => {
        const option = derive(quick("violin", { x: "cluster", y: "score" }), violinRows());
        const inner = seriesOf(option).filter((entry) => entry.renderItem === INTERVAL_RENDERER);
        expect(inner.length).toBe(1);
        const item = asArr(asArr(inner[0].data)[1]) as number[];
        // The second category holds 2, 2.5, 3, 3.5, and 4, four times each: the type-7 quartiles are 2.5 and 3.5.
        expect(item).toEqual([1, 3, 2.5, 3.5, 1, 0, 1]);
    });

    it("draws nothing for a category of four values, and draws the others", () => {
        const rows = [...violinRows(), ...[1, 2, 3, 4].map((score) => ({ cluster: "thin", score }))];
        const items = asArr(outlinesOf(derive(quick("violin", { x: "cluster", y: "score" }), rows))[0].data).map((item) => asArr(item)[0]);
        expect(items).toEqual([0, 1]);
    });

    it("falls to the standard deviation for a category whose quartiles are equal", () => {
        const rows: ChartRow[] = [];
        for (let index = 0; index < 20; index += 1) rows.push({ cluster: "tied", score: index === 0 ? 0 : index === 19 ? 10 : 5 });
        const items = asArr(outlinesOf(derive(quick("violin", { x: "cluster", y: "score" }), rows))[0].data);
        expect(items.length).toBe(1);
    });

    it("gives one outline series for each group, offset inside the band", () => {
        const rows = violinRows().map((row, index) => ({ ...row, arm: index % 2 === 0 ? "treated" : "control" }));
        const outlines = outlinesOf(derive(quick("violin", { x: "cluster", y: "score", group: "arm" }), rows));
        expect(outlines.map((entry) => entry.name)).toEqual(["treated", "control"]);
        const offsets = outlines.map((entry) => asArr(asArr(entry.data)[0])[3]);
        expect(offsets).toEqual([-0.2, 0.2]);
    });

    it("refuses an orientation on a violin", () => {
        expect(refusal(quick("violin", { x: "cluster", y: "score" }, { orientation: "horizontal" }), violinRows()).detail).toContain("violin");
    });
});

describe("the stacked forms and the radar", () => {
    const parts: ChartRow[] = [
        { k: "a", g: "x", v: 3 },
        { k: "a", g: "y", v: 1 },
        { k: "a", g: "z", v: 4 },
        { k: "b", g: "x", v: 0 },
        { k: "b", g: "y", v: 0 },
    ];

    it("names one stack on each group series of a stacked bar", () => {
        const series = seriesOf(derive(quick("stacked-bar", { x: "k", y: "v", group: "g" }), parts));
        expect(series.map((entry) => entry.stack)).toEqual(["total", "total", "total"]);
        expect(series[0].data).toEqual([3, 0]);
        expect(series[2].data).toEqual([4, null]);
    });

    it("stacks the shares of a normalized bar, ends the value axis at one, and draws no bar for a zero total", () => {
        const option = derive(quick("normalized-bar", { x: "k", y: "v", group: "g" }), parts);
        const series = seriesOf(option);
        expect(series.map((entry) => asArr(entry.data)[0])).toEqual([0.375, 0.125, 0.5]);
        expect(series.map((entry) => asArr(entry.data)[1])).toEqual([null, null, null]);
        expect(asObj(option.yAxis).max).toBe(1);
    });

    it("refuses a negative part, and a stacked form with no group", () => {
        expect(refusal(quick("normalized-bar", { x: "k", y: "v", group: "g" }), [...parts, { k: "c", g: "x", v: -1 }]).detail).toContain("row 6");
        expect(refusal(quick("stacked-bar", { x: "k", y: "v" }), parts).detail).toContain('"group"');
    });

    it("draws a radar of five indicators and two polygons, and names both groups in the legend", () => {
        const rows: ChartRow[] = [];
        for (const [g, scale] of [
            ["tumor", 1],
            ["normal", 2],
        ] as const) {
            for (const [index, k] of ["a", "b", "c", "d", "e"].entries()) rows.push({ k, g, v: (index + 1) * scale });
        }
        const option = derive(quick("radar", { x: "k", y: "v", group: "g" }), rows);
        expect(asArr(asObj(option.radar).indicator)).toEqual(["a", "b", "c", "d", "e"].map((name) => ({ name, max: 10 })));
        const data = asArr(seriesOf(option)[0].data).map(asObj);
        expect(data.map((item) => item.name)).toEqual(["tumor", "normal"]);
        expect(data[0].value).toEqual([1, 2, 3, 4, 5]);
        expect(asObj(option.legend).data).toEqual(["tumor", "normal"]);
        expect(option.xAxis).toBeUndefined();
    });

    it("keeps an empty violin, stacked bar, normalized bar, and radar with no problem", () => {
        for (const chartType of ["violin", "stacked-bar", "normalized-bar", "radar"] as const) {
            expect(deriveChartOption(quick(chartType, { x: "k", y: "v", group: "g" }), []).isOk()).toBe(true);
        }
    });
});

describe("the facet", () => {
    function facetRows(panels: number): ChartRow[] {
        const rows: ChartRow[] = [];
        for (let panel = 0; panel < panels; panel += 1) {
            for (let index = 0; index < 5; index += 1) rows.push({ sample: `s${panel}`, x: index + panel, y: index * (panel + 1) });
        }
        return rows;
    }

    it("splits four facets into four grids of two rows, with one shared range and four labels", () => {
        const option = derive(quick("scatter", { x: "x", y: "y", facet: "sample" }), facetRows(4));
        const grids = asArr(option.grid).map(asObj);
        expect(grids.length).toBe(4);
        expect(new Set(grids.map((grid) => grid.top)).size).toBe(2);
        const xAxes = asArr(option.xAxis).map(asObj);
        const yAxes = asArr(option.yAxis).map(asObj);
        expect(xAxes.length).toBe(4);
        expect(new Set(xAxes.map((axis) => `${String(axis.min)}:${String(axis.max)}`)).size).toBe(1);
        expect(new Set(yAxes.map((axis) => `${String(axis.min)}:${String(axis.max)}`)).size).toBe(1);
        expect(yAxes[0].max).toBeGreaterThanOrEqual(16);
        const series = seriesOf(option);
        expect(series.map((entry) => entry.xAxisIndex)).toEqual([0, 1, 2, 3]);
        const graphic = asArr(option.graphic).map(asObj);
        const labels = graphic.filter((element) => asObj(element.style).fontWeight === "bold");
        expect(labels.map((label) => asObj(label.style).text)).toEqual(["s0", "s1", "s2", "s3"]);
    });

    it("gives each panel of one row one width, and names each shared axis one time for the whole chart", () => {
        const option = derive(quick("scatter", { x: "x", y: "y", facet: "sample" }), facetRows(5));
        const grids = asArr(option.grid).map(asObj);
        expect(new Set(grids.map((grid) => grid.width)).size).toBe(1);
        // A name on one panel narrows that panel alone, thus no panel carries a name.
        for (const axis of [...asArr(option.xAxis), ...asArr(option.yAxis)].map(asObj)) {
            expect(axis.name).toBeUndefined();
            // A narrow panel draws fewer ticks, and a label that overlaps its neighbor hides.
            expect(axis.splitNumber).toBe(3);
            expect(asObj(axis.axisLabel).hideOverlap).toBe(true);
        }
        const titles = asArr(option.graphic)
            .map(asObj)
            .filter((element) => asObj(element.style).fontWeight !== "bold")
            .map((element) => asObj(element.style).text);
        expect(titles).toEqual(["x", "y"]);
    });

    it("prints each category label of a panel, and turns the labels that do not fit their band", () => {
        const donors = ["patient_101", "patient_1015", "patient_1016", "patient_1039", "patient_107", "patient_1244", "patient_1256", "patient_1488"];
        const rows: ChartRow[] = [];
        for (const condition of ["control", "stimulated"]) for (const [index, sample] of donors.entries()) rows.push({ condition, sample, n: index + 1 });
        const option = derive(quick("bar", { x: "sample", y: "n", facet: "condition" }), rows);
        for (const axis of asArr(option.xAxis).map(asObj)) {
            const label = asObj(axis.axisLabel);
            expect(label.hideOverlap).toBeUndefined();
            expect(label.interval).toBe(0);
            // Two panels share 900 pixels less the bands, thus each donor takes about 52 pixels, and a name of
            // twelve characters needs 86: the label turns 45 degrees.
            expect(label.rotate).toBe(45);
        }
        const short = derive(
            quick("bar", { x: "sample", y: "n", facet: "condition" }),
            rows.map((row) => ({ ...row, sample: String(row.sample).slice(-3) })),
        );
        expect(asObj(asObj(asArr(short.xAxis)[0]).axisLabel).rotate).toBeUndefined();
    });

    it("gives one facet the full width", () => {
        const grids = asArr(derive(quick("bar", { x: "sample", y: "y", facet: "sample" }), facetRows(1)).grid).map(asObj);
        expect(grids.length).toBe(1);
        // The band at the left holds the shared y title, and the panel takes the rest of the width.
        expect(grids[0].left).toBe("5%");
        expect(grids[0].width).toBe("95%");
        // The labels and the names of a panel stay inside the box of its grid.
        expect(grids[0].outerBoundsMode).toBe("same");
    });

    it("refuses thirteen facets and names the count, and refuses a facet on a pie", () => {
        expect(refusal(quick("scatter", { x: "x", y: "y", facet: "sample" }), facetRows(13)).detail).toContain("13");
        expect(refusal(quick("pie", { group: "sample", value: "y", facet: "sample" }), facetRows(2)).detail).toContain("pie");
    });

    it("keeps its rows inline past the bound", () => {
        const rows: ChartRow[] = [];
        for (let index = 0; index < 8000; index += 1) rows.push({ x: index, y: index % 97, sample: index % 2 === 0 ? "a" : "b" });
        const render = deriveChartRender(quick("scatter", { x: "x", y: "y", facet: "sample" }), rows, ["x", "y", "sample"], {
            key: "c1",
            columns: ["x", "y", "sample"],
        })._unsafeUnwrap();
        expect(render.readsPayload).toBe(false);
        expect(render.bodyPx).toBe(CHART_BODY_PX);
        expect(asArr(seriesOf(render.option)[0].data).length).toBe(4000);
    });

    it("grows the chart body one row of height for each further row of facet panels", () => {
        const render = deriveChartRender(quick("scatter", { x: "x", y: "y", facet: "sample" }), facetRows(7), undefined, {
            key: "c1",
            columns: [],
        })._unsafeUnwrap();
        expect(render.bodyPx).toBe(CHART_BODY_PX + 2 * FACET_ROW_PX);
    });
});

describe("the title of an axis", () => {
    const TERMS = ["proteasomal ubiquitin-independent protein catabolic process (GO:0010499)", "cell-cell junction assembly (GO:0007043)"];
    const rows: ChartRow[] = TERMS.map((term, index) => ({ term, nes: index === 0 ? 1.9 : -1.2 }));
    const binding = { kind: "artifact-table" as const, path: "table.csv", hash: "sha256:00", columnLabels: { term: "GO biological process" } };

    it("moves each axis title off its labels, and leaves an axis with no title as it is", () => {
        const option = derive(quick("bar", { x: "term", y: "nes" }, { orientation: "horizontal", binding }), rows);
        const axis = asObj(option.yAxis);
        expect(axis.name).toBe("GO biological process");
        // The grid of a horizontal bar holds its labels, and such a grid turns the move off by default.
        expect(asObj(option.grid).containLabel).toBe(true);
        expect(axis.nameMoveOverlap).toBe(true);
        expect(asObj(option.xAxis).nameMoveOverlap).toBe(true);
        const plain = derive(quick("bar", { x: "term", y: "nes" }, { orientation: "horizontal" }), rows);
        expect(asObj(plain.yAxis).nameMoveOverlap).toBeUndefined();
    });
});

describe("the report chart carries no toolbox", () => {
    it("holds no toolbox member, and the legend and the axis rules of the discipline stay", () => {
        const rows: ChartRow[] = [
            { k: "a", g: "x", v: 1 },
            { k: "a", g: "y", v: 2 },
        ];
        const option = derive(quick("bar", { x: "k", y: "v", group: "g" }), rows);
        expect(option.toolbox).toBeUndefined();
        expect(option.legend).toEqual({
            bottom: 0,
            data: [
                { name: "x", icon: "rect" },
                { name: "y", icon: "rect" },
            ],
        });
        expect(asObj(asObj(option.xAxis).axisLabel).interval).toBe(0);
        const render = deriveChartRender(quick("bar", { x: "k", y: "v", group: "g" }), rows, undefined, { key: "c1", columns: [] })._unsafeUnwrap();
        expect(render.option.toolbox).toBeUndefined();
        expect(render.inline.toolbox).toBeUndefined();
    });
});

describe("the bar with a wide channel", () => {
    const rows: ChartRow[] = [
        { arm: "a", mean: 40, lo: 38, hi: 42, score: 0.2 },
        { arm: "b", mean: 30, lo: 27, hi: 33, score: 0.9 },
    ];

    it("keeps zero in the value axis of a bar with an interval or a color, thus each bar keeps its true height", () => {
        const interval = derive(quick("bar", { x: "arm", y: "mean", low: "lo", high: "hi" }), rows);
        const colored = derive(quick("bar", { x: "arm", y: "mean", color: "score" }), rows);
        const horizontal = derive(quick("bar", { x: "arm", y: "mean", low: "lo", high: "hi" }, { orientation: "horizontal" }), rows);
        // A value axis with `scale` fits the data extent, thus the bar of 30 would stand on a baseline of 30.
        expect("scale" in asObj(interval.yAxis)).toBe(false);
        expect("scale" in asObj(colored.yAxis)).toBe(false);
        expect("scale" in asObj(horizontal.xAxis)).toBe(false);
        // A scatter keeps its fitted axis.
        expect(asObj(derive(quick("scatter", { x: "mean", y: "hi", color: "score" }), rows).yAxis).scale).toBe(true);
    });

    it("sets the category gap that the slot offsets of an interval read, on each bar series", () => {
        const grouped: ChartRow[] = [
            { arm: "a", dose: "low", mean: 4, lo: 3, hi: 5 },
            { arm: "a", dose: "high", mean: 6, lo: 5, hi: 7 },
        ];
        for (const option of [
            derive(quick("bar", { x: "arm", y: "mean", group: "dose", low: "lo", high: "hi" }), grouped),
            derive(quick("bar", { x: "arm", y: "mean" }), grouped),
        ]) {
            const bars = seriesOf(option).filter((entry) => entry.type === "bar");
            expect(bars.length).toBeGreaterThan(0);
            for (const bar of bars) expect(bar.barCategoryGap).toBe("20%");
        }
    });

    it("gives no value label to a bar with an interval, and draws the interval over the bars", () => {
        const option = derive(quick("bar", { x: "arm", y: "mean", low: "lo", high: "hi" }), rows);
        const [bar, interval] = seriesOf(option);
        expect(asArr(bar.data).every((item) => Array.isArray(item))).toBe(true);
        expect(interval.renderItem).toBe(INTERVAL_RENDERER);
        expect(interval.z).toBe(3);
    });

    it("puts the label of a negative bar under its end, on either orientation", () => {
        const signed: ChartRow[] = [
            { k: "up", v: 2.4 },
            { k: "down", v: -1.9 },
        ];
        const vertical = asArr(seriesOf(derive(quick("bar", { x: "k", y: "v" }), signed))[0].data).map((item) => asObj(asObj(item).label).position);
        const horizontal = asArr(seriesOf(derive(quick("bar", { x: "k", y: "v" }, { orientation: "horizontal" }), signed))[0].data).map(
            (item) => asObj(asObj(item).label).position,
        );
        expect(vertical).toEqual(["top", "bottom"]);
        expect(horizontal).toEqual(["right", "left"]);
    });

    it("widens the value axis of a labeled bar chart, thus a label past a bar end stays inside the plot", () => {
        const signed: ChartRow[] = [
            { k: "up", v: 2.4 },
            { k: "down", v: -1.9 },
        ];
        expect(asObj(derive(quick("bar", { x: "k", y: "v" }), signed).yAxis).boundaryGap).toEqual(["15%", "15%"]);
        expect(asObj(derive(quick("bar", { x: "k", y: "v" }, { orientation: "horizontal" }), signed).xAxis).boundaryGap).toEqual(["15%", "15%"]);
        expect(asObj(derive(composed({ series: [{ form: "bar", encoding: { x: "k", y: "v" } }] }), signed).yAxis).boundaryGap).toEqual(["15%", "15%"]);
        const busy: ChartRow[] = [];
        for (let index = 0; index < 30; index += 1) busy.push({ k: `k${index}`, v: index - 10 });
        expect(asObj(derive(quick("bar", { x: "k", y: "v" }), busy).yAxis).boundaryGap).toBeUndefined();
    });
});

describe("the composition refusals of the wide grammar", () => {
    const rows: ChartRow[] = [
        { k: "a", v: 1, w: 2, c1: 0.1, c2: 0.5, s1: 3, s2: 4, g: "x", rank: 1 },
        { k: "b", v: 3, w: 1, c1: 0.2, c2: 0.6, s1: 5, s2: 6, g: "y", rank: 2 },
    ];

    it("refuses an order on a series after the first, because the axes read the first series alone", () => {
        const problem = refusal(
            composed({
                series: [
                    { form: "bar", encoding: { x: "k", y: "v" } },
                    { form: "line", encoding: { x: { column: "k", orderBy: "rank" }, y: "w" } },
                ],
            }),
            rows,
        );
        expect(problem.detail).toContain("series 2");
        expect(problem.detail).toContain("orderBy");
    });

    it("refuses two series that color by two columns, or size by two columns", () => {
        const colors = composed({
            series: [
                { form: "scatter", encoding: { x: "v", y: "w", color: "c1" } },
                { form: "scatter", encoding: { x: "w", y: "v", color: "c2" } },
            ],
        });
        const sizes = composed({
            series: [
                { form: "scatter", encoding: { x: "v", y: "w", size: "s1" } },
                { form: "scatter", encoding: { x: "w", y: "v", size: "s2" } },
            ],
        });
        expect(refusal(colors, rows).detail).toContain('"color"');
        expect(refusal(sizes, rows).detail).toContain('"size"');
        // One column on two series shares one scale, thus it derives.
        const shared = composed({
            series: [
                { form: "scatter", encoding: { x: "v", y: "w", color: "c1" } },
                { form: "scatter", encoding: { x: "w", y: "v", color: "c1" } },
            ],
        });
        expect(deriveChartOption(shared, rows).isOk()).toBe(true);
    });

    it("refuses a focus on a grouped area or step series", () => {
        for (const form of ["area", "step"] as const) {
            const problem = refusal(composed({ series: [{ form, encoding: { x: "v", y: "w", group: "g" } }] }, ["x"]), rows);
            expect(problem.detail).toContain(form);
            expect(problem.detail).toContain("focus");
        }
    });

    it("refuses a radar whose table holds no positive value", () => {
        const flat: ChartRow[] = [
            { k: "a", g: "x", v: 0 },
            { k: "b", g: "x", v: -2 },
        ];
        expect(refusal(quick("radar", { x: "k", y: "v", group: "g" }), flat).detail).toContain("positive");
    });
});

describe("the second review round", () => {
    it("keeps the color scale of a faceted chart clear of the rightmost panel", () => {
        const rows: ChartRow[] = [];
        for (const sample of ["s1", "s2", "s3"]) {
            for (let index = 0; index < 4; index += 1) rows.push({ sample, x: index, y: index * 2, c: index / 4 });
        }
        const option = derive(quick("scatter", { x: "x", y: "y", color: "c", facet: "sample" }), rows);
        const grids = asArr(option.grid).map(asObj);
        const ends = grids.map((grid) => Number.parseFloat(String(grid.left)) + Number.parseFloat(String(grid.width)));
        // The scale stands at the right edge in a band of 18 percent, thus every panel ends before the band.
        expect(Math.max(...ends)).toBeLessThanOrEqual(82);
        expect(mapsOf(option)[0].right).toBe(0);
    });

    it("reads the color and the size scale from the drawn points, and never from a dropped row", () => {
        const rows: ChartRow[] = [
            { a: 1, b: 2, c: 1, s: 3 },
            { a: 2, b: 3, c: 5, s: 7 },
            // No x cell, thus the point drops, and its color and size widen no scale.
            { b: 4, c: 1000, s: 900 },
        ];
        const maps = mapsOf(derive(quick("scatter", { x: "a", y: "b", color: "c", size: "s" }), rows));
        const color = maps.find((map) => asObj(map.inRange).color !== undefined);
        const size = maps.find((map) => asObj(map.inRange).symbolSize !== undefined);
        expect([color?.min, color?.max]).toEqual([1, 5]);
        expect([size?.min, size?.max]).toEqual([3, 7]);
    });

    it("refuses a category whose order cell is absent, and names the category and the column", () => {
        const rows: ChartRow[] = [
            { k: "a", v: 1, rank: 1 },
            { k: "b", v: 2 },
        ];
        const problem = refusal(quick("bar", { x: { column: "k", orderBy: "rank" }, y: "v" }), rows);
        expect(problem.detail).toContain('"b"');
        expect(problem.detail).toContain('"rank"');
    });

    it("spends no point label on a row whose color cell is not numeric", () => {
        const rows: ChartRow[] = [
            { gene: "G1", x: 1, y: 1, c: "NA", score: 10 },
            { gene: "G2", x: 2, y: 2, c: 1, score: 9 },
            { gene: "G3", x: 3, y: 3, c: 2, score: 8 },
            { gene: "G4", x: 4, y: 4, c: 3, score: 1 },
        ];
        const option = derive(
            composed({
                series: [{ form: "scatter", encoding: { x: "x", y: "y", color: "c", label: "gene" } }],
                annotations: [{ kind: "point-labels", column: "score", order: "desc", n: 2 }],
            }),
            rows,
        );
        const marked = asArr(seriesOf(option)[0].data)
            .map(asObj)
            .filter((item) => item.label !== undefined)
            .map((item) => item.name);
        expect(marked).toEqual(["G2", "G3"]);
    });
});

describe("the third review round", () => {
    const ranked: ChartRow[] = [
        { k: "A", v: 1, rank: 3 },
        { k: "B", v: 2, rank: 1 },
        { k: "C", v: 3, rank: 2 },
    ];

    /** The x cells of one series, in data order. */
    function xOrder(option: EchartOption): unknown[] {
        return asArr(seriesOf(option)[0].data).map((item) => asArr(Array.isArray(item) ? item : asObj(item).value)[0]);
    }

    it("draws a line along the order of its category axis, on the quick path and on a composition", () => {
        const quickLine = derive(quick("line", { x: { column: "k", orderBy: "rank" }, y: "v" }), ranked);
        expect(asObj(quickLine.xAxis).data).toEqual(["B", "C", "A"]);
        expect(xOrder(quickLine)).toEqual(["B", "C", "A"]);
        for (const form of ["line", "area", "step"] as const) {
            const composedLine = derive(composed({ series: [{ form, encoding: { x: { column: "k", orderBy: "rank" }, y: "v" } }] }), ranked);
            expect(asObj(composedLine.xAxis).data).toEqual(["B", "C", "A"]);
            expect(xOrder(composedLine)).toEqual(["B", "C", "A"]);
        }
    });

    it("widens the shared value limit of a faceted bar that carries value labels, away from zero", () => {
        const rows: ChartRow[] = [];
        for (const panel of ["p1", "p2"]) for (const k of ["a", "b"]) rows.push({ panel, k, v: k === "a" ? 10 : 4 });
        const option = derive(quick("bar", { x: "k", y: "v", facet: "panel" }), rows);
        for (const axis of asArr(option.yAxis).map(asObj)) {
            // The label of the bar at 10 needs room over the bar, and the axis keeps its zero.
            expect(Number(axis.max)).toBeGreaterThanOrEqual(11.5);
            expect(axis.min).toBe(0);
        }
    });

    it("refuses a stacked form, a radar, or a violin whose categories and groups pass the slot bound, and names the count", () => {
        const rows: ChartRow[] = [];
        for (let index = 0; index < 400; index += 1) rows.push({ k: `c${index}`, g: `g${index % 300}`, v: 1 });
        // 400 categories and 300 groups give 120000 slots, past the bound of 100000.
        for (const chartType of ["stacked-bar", "normalized-bar", "radar", "violin"] as const) {
            expect(refusal(quick(chartType, { x: "k", y: "v", group: "g" }), rows).detail).toContain("120000");
        }
    });

    it("derives a violin over many categories, one outline for each category", () => {
        const rows: ChartRow[] = [];
        for (let category = 0; category < 2000; category += 1) {
            for (let index = 0; index < 5; index += 1) rows.push({ k: `c${category}`, v: index + (category % 3) });
        }
        const outline = seriesOf(derive(quick("violin", { x: "k", y: "v" }), rows)).find((entry) => entry.renderItem === OUTLINE_RENDERER);
        expect(asArr(outline?.data).length).toBe(2000);
    });
});

describe("the slot bound of a heatmap", () => {
    it("refuses a heatmap whose x categories times y categories pass the bound, and derives one under it", () => {
        const wide: ChartRow[] = [];
        for (let index = 0; index < 400; index += 1) wide.push({ sample: `s${index}`, gene: `g${index % 300}`, z: 1 });
        // 400 samples and 300 genes give 120000 cells, past the bound of 100000.
        const problem = refusal(quick("heatmap", { x: "sample", y: "gene", value: "z" }), wide);
        expect(problem.kind).toBe("invalid-chart-input");
        expect(problem.detail).toContain("120000");

        const small = wide.slice(0, 20);
        const option = derive(quick("heatmap", { x: "sample", y: "gene", value: "z" }), small);
        expect(asArr(asObj(option.xAxis).data).length).toBe(20);
        expect(asArr(seriesOf(option)[0].data).length).toBe(20 * 20);
    });
});

describe("the size scale of a mixed composition", () => {
    it("gives each size map one shared range, whatever the place of the size in the item", () => {
        const rows: ChartRow[] = [
            { a: 1, b: 2, c: 0.5, s: 1 },
            // The color cell is not numeric, thus the colored series drops this row and the other series draws it.
            { a: 2, b: 3, c: "NA", s: 100 },
        ];
        const option = derive(
            composed({
                series: [
                    { form: "scatter", encoding: { x: "a", y: "b", color: "c", size: "s" } },
                    { form: "scatter", encoding: { x: "b", y: "a", size: "s" } },
                ],
            }),
            rows,
        );
        const sizes = mapsOf(option).filter((map) => asObj(map.inRange).symbolSize !== undefined);
        // The colored series holds the size at dimension 3, and the other series at dimension 2.
        expect(sizes.map((map) => map.dimension).sort()).toEqual([2, 3]);
        // One size column reads one range, thus equal values draw at one size in both series.
        for (const map of sizes) expect([map.min, map.max]).toEqual([1, 100]);
    });
});

describe("a line over the ordered axis of an earlier series", () => {
    /** The x cells of one series, in data order. */
    function xCells(series: Record<string, unknown>): unknown[] {
        return asArr(series.data).map((item) => asArr(Array.isArray(item) ? item : asObj(item).value)[0]);
    }

    /** A composition whose first series, a bar, sorts the shared category axis, and whose second series is a line. */
    const block = composed({
        series: [
            { form: "bar", encoding: { x: { column: "k", orderBy: "rank" }, y: "v" } },
            { form: "line", encoding: { x: "k", y: "w" } },
        ],
    });

    it("draws the line in the order of the shared axis", () => {
        const rows: ChartRow[] = [
            { k: "A", v: 1, w: 3, rank: 3 },
            { k: "B", v: 2, w: 1, rank: 1 },
            { k: "C", v: 3, w: 2, rank: 2 },
        ];
        const option = derive(block, rows);
        expect(asObj(option.xAxis).data).toEqual(["B", "C", "A"]);
        expect(xCells(seriesOf(option)[1])).toEqual(["B", "C", "A"]);
    });

    it("keeps its rows inline past the bound, because the page build sorts a line by its cells", () => {
        const rows: ChartRow[] = [];
        for (let index = 0; index < 6000; index += 1) rows.push({ k: `c${index}`, v: index + 0.123456, w: index + 0.654321, rank: 6000 - index });
        const columns = ["k", "v", "w", "rank"];
        const render = deriveChartRender(block, rows, columns, { key: "c1", columns })._unsafeUnwrap();
        expect(JSON.stringify(render.option).length).toBeGreaterThan(CHART_INLINE_OPTION_BOUND);
        expect(render.readsPayload).toBe(false);
        expect(xCells(seriesOf(render.option)[1]).slice(0, 3)).toEqual(["c5999", "c5998", "c5997"]);
    });
});
