/**
 * The heatmap over excerpts of the pasilla top-gene heatmap and the sample distance table.
 */

import { describe, expect, it } from "bun:test";
import * as echarts from "echarts";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import { chartSvgAssets } from "../chart-export.js";
import { deriveChartOption, deriveChartRender, type ChartInputs, type ChartRow, type EchartOption } from "../chart.js";
import { CHART_BODY_MAX_PX, CHART_BODY_PX, CHART_INK, CHART_PALETTE, DIVERGING_RAMP, SEQUENTIAL_RAMP } from "../design.js";
import { HEATMAP_CELL_GAP_PX, HEATMAP_LABEL_LIMIT, HEATMAP_ROW_PX, TRACK_BAND_GAP_PX, TRACK_LEGEND_LINE_PX } from "./heatmap.js";

type Encoding = NonNullable<ChartBlock["encoding"]>;

const HASH = `sha256:${"e".repeat(64)}`;

function block(encoding: Encoding, labels?: Record<string, string>): ChartBlock {
    return {
        kind: "chart",
        id: "h1",
        binding: { kind: "artifact-table", path: "heat.csv", hash: HASH, ...(labels !== undefined ? { columnLabels: labels } : {}) },
        chartType: "heatmap",
        encoding,
    };
}

function asObj(value: unknown): EchartOption {
    return value as EchartOption;
}

/** Two genes of the pasilla top-gene heatmap over its seven samples. */
const TOP_GENES: ChartRow[] = [
    ["Kal1", "untreated1", 0.8472503432276401, 24, 3, "untreated", "single-read"],
    ["Kal1", "untreated2", 0.799915233570179, 24, 5, "untreated", "single-read"],
    ["Kal1", "untreated3", 0.7519530648648491, 24, 6, "untreated", "paired-end"],
    ["Kal1", "untreated4", 0.8003501139903757, 24, 4, "untreated", "paired-end"],
    ["Kal1", "treated1", -1.1688342780962147, 24, 0, "treated", "single-read"],
    ["Kal1", "treated2", -1.0801130638947576, 24, 1, "treated", "paired-end"],
    ["Kal1", "treated3", -0.9505214136620721, 24, 2, "treated", "paired-end"],
    ["Treh", "untreated1", -0.5686117310915749, 0, 3, "untreated", "single-read"],
    ["Treh", "untreated2", -0.7009584045470125, 0, 5, "untreated", "single-read"],
    ["Treh", "untreated3", -0.9492834397940749, 0, 6, "untreated", "paired-end"],
    ["Treh", "untreated4", -0.9543371550757658, 0, 4, "untreated", "paired-end"],
    ["Treh", "treated1", 1.142082469564719, 0, 0, "treated", "single-read"],
    ["Treh", "treated2", 1.0720643446397156, 0, 1, "treated", "paired-end"],
    ["Treh", "treated3", 0.959043916304015, 0, 2, "treated", "paired-end"],
].map(([gene_symbol, sample, zscore, gene_order, sample_order, condition, type]) => ({
    gene_symbol,
    sample,
    zscore,
    gene_order,
    sample_order,
    condition,
    type,
})) as ChartRow[];

const TRACKED: Encoding = {
    x: { column: "sample", orderBy: "sample_order" },
    y: { column: "gene_symbol", orderBy: "gene_order" },
    value: "zscore",
    tracks: ["condition", "type"],
};

describe("the heatmap with annotation tracks", () => {
    const option = deriveChartOption(block(TRACKED, { zscore: "z-score" }), TOP_GENES)._unsafeUnwrap();
    const series = option.series as EchartOption[];
    const maps = option.visualMap as EchartOption[];

    it("draws the matrix in the run order, top-down, on the diverging ramp", () => {
        const [xAxis, yAxis] = [(option.xAxis as EchartOption[])[0], (option.yAxis as EchartOption[])[0]];
        expect(xAxis.data).toEqual(["treated1", "treated2", "treated3", "untreated1", "untreated4", "untreated2", "untreated3"]);
        expect(yAxis.data).toEqual(["Treh", "Kal1"]);
        expect(yAxis.inverse).toBe(true);
        expect(maps[0]).toEqual(expect.objectContaining({ seriesIndex: 0, inRange: { color: [...DIVERGING_RAMP] } }));
        expect(maps[0].min).toBe(-(maps[0].max as number));
        expect(maps[0].text).toEqual(["z-score\n1.17", "−1.17"]);
    });

    it("separates the cells with a thin white gap, and draws no axis line", () => {
        expect(series[0].itemStyle).toEqual({ borderColor: "#ffffff", borderWidth: HEATMAP_CELL_GAP_PX });
        const xAxis = (option.xAxis as EchartOption[])[0];
        expect([asObj(xAxis.axisLine).show, asObj(xAxis.axisTick).show]).toEqual([false, false]);
    });

    it("draws one strip of category colors for each track over the matrix, in the x order", () => {
        const grids = option.grid as EchartOption[];
        expect(grids.length).toBe(2);
        expect((grids[1].top as number) < (grids[0].top as number)).toBe(true);
        expect(grids[0].left).toBe(grids[1].left);
        expect(series.slice(1).map((entry) => [entry.name, entry.xAxisIndex, entry.data])).toEqual([
            [
                "condition",
                1,
                [
                    [0, 0, 0],
                    [1, 0, 0],
                    [2, 0, 0],
                    [3, 0, 1],
                    [4, 0, 1],
                    [5, 0, 1],
                    [6, 0, 1],
                ],
            ],
            [
                "type",
                1,
                [
                    [0, 1, 0],
                    [1, 1, 1],
                    [2, 1, 1],
                    [3, 1, 0],
                    [4, 1, 1],
                    [5, 1, 0],
                    [6, 1, 1],
                ],
            ],
        ]);
        expect((option.yAxis as EchartOption[])[1].data).toEqual(["condition", "type"]);
    });

    it("keys each track in a legend of its own, with colors that no other track takes", () => {
        expect(maps.slice(1).map((map) => [map.type, map.seriesIndex, map.text, map.pieces])).toEqual([
            [
                "piecewise",
                1,
                ["condition"],
                [
                    { value: 0, label: "treated", color: CHART_PALETTE[0] },
                    { value: 1, label: "untreated", color: CHART_PALETTE[1] },
                ],
            ],
            [
                "piecewise",
                2,
                ["type"],
                [
                    { value: 0, label: "single-read", color: CHART_PALETTE[2] },
                    { value: 1, label: "paired-end", color: CHART_PALETTE[3] },
                ],
            ],
        ]);
        expect(maps.slice(1).every((map) => map.selectedMode === false)).toBe(true);
    });

    it("gives the track legends a band of their own, one line apart, clear of the strips", () => {
        const legends = maps.slice(1).map((map) => map.top as number);
        const strips = (option.grid as EchartOption[])[1].top as number;
        expect(legends[1] - legends[0]).toBe(TRACK_LEGEND_LINE_PX);
        expect(strips - legends[1]).toBe(TRACK_LEGEND_LINE_PX + TRACK_BAND_GAP_PX);
    });

    it("refuses a track column that holds two values for one sample", () => {
        const rows = TOP_GENES.map((row, index) => (index === 7 ? { ...row, condition: "treated" } : row));
        expect(deriveChartOption(block(TRACKED), rows)._unsafeUnwrapErr().detail).toBe(
            'The track column "condition" holds two values, "untreated" and "treated", for the x category "untreated1". A track holds one value for each x category.',
        );
    });
});

describe("the rules of the heatmap matrix", () => {
    it("draws a distance matrix on the sequential ramp, thus the zero diagonal draws dark", () => {
        const rows: ChartRow[] = [
            { sample_a: "untreated1", sample_b: "untreated1", distance: 0 },
            { sample_a: "untreated1", sample_b: "untreated2", distance: 26.760110810181036 },
            { sample_a: "untreated2", sample_b: "untreated1", distance: 26.760110810181036 },
            { sample_a: "untreated2", sample_b: "untreated2", distance: 0 },
        ];
        const map = asObj(deriveChartOption(block({ x: "sample_a", y: "sample_b", value: "distance" }), rows)._unsafeUnwrap().visualMap);
        expect(map.inRange).toEqual({ color: [...SEQUENTIAL_RAMP] });
        expect([map.min, map.max]).toEqual([0, 26.760110810181036]);
    });

    it("hides the sample names past 40 samples, and states the count in the axis title", () => {
        const rows: ChartRow[] = Array.from({ length: HEATMAP_LABEL_LIMIT + 1 }, (_row, index) => ({ sample: `s${index}`, gene: "TP53", z: index - 20 }));
        const xAxis = asObj(deriveChartOption(block({ x: "sample", y: "gene", value: "z" }), rows)._unsafeUnwrap().xAxis);
        expect(asObj(xAxis.axisLabel).show).toBe(false);
        expect(xAxis.name).toBe("sample (n = 41)");
        const small = asObj(deriveChartOption(block({ x: "sample", y: "gene", value: "z" }), rows.slice(0, HEATMAP_LABEL_LIMIT))._unsafeUnwrap().xAxis);
        expect(small.name).toBeUndefined();
    });

    it("refuses a channel that the heatmap does not read", () => {
        expect(deriveChartOption(block({ x: "sample", y: "gene", value: "z", color: "z" }), [{ sample: "s", gene: "g", z: 1 }])._unsafeUnwrapErr().detail).toBe(
            'The heatmap chart takes no "color" channel.',
        );
    });
});

describe("the height of a heatmap of many rows", () => {
    /** A matrix of `genes` rows over the seven pasilla samples, with the two tracks. */
    function genesRows(genes: number): ChartRow[] {
        const rows: ChartRow[] = [];
        for (let gene = 0; gene < genes; gene += 1) {
            for (const [place, row] of TOP_GENES.slice(0, 7).entries()) rows.push({ ...row, gene_symbol: `G${gene}`, gene_order: gene, zscore: gene - place });
        }
        return rows;
    }

    /** The height of one matrix row on the page, in pixels. */
    function rowPx(rows: ChartRow[], genes: number): number {
        const render = deriveChartRender(block(TRACKED), rows, undefined, { key: "h1", columns: [] })._unsafeUnwrap();
        const grid = (render.option.grid as EchartOption[])[0];
        const bottom = (Number.parseFloat(String(grid.bottom)) * render.bodyPx) / 100;
        return (render.bodyPx - (grid.top as number) - bottom) / genes;
    }

    it("states a body tall enough that each row takes one line of text, thus each row name prints", () => {
        const rows = genesRows(40);
        const render = deriveChartRender(block(TRACKED), rows, undefined, { key: "h1", columns: [] })._unsafeUnwrap();
        expect(render.bodyPx).toBeGreaterThan(CHART_BODY_PX);
        expect(rowPx(rows, 40)).toBeGreaterThanOrEqual(HEATMAP_ROW_PX);
        // The same rows give the same body.
        expect(deriveChartRender(block(TRACKED), rows, undefined, { key: "h1", columns: [] })._unsafeUnwrap().bodyPx).toBe(render.bodyPx);
    });

    it("keeps the default body for a matrix that fits it, and stops the body at the largest body", () => {
        expect(deriveChartRender(block(TRACKED), TOP_GENES, undefined, { key: "h1", columns: [] })._unsafeUnwrap().bodyPx).toBe(CHART_BODY_PX);
        expect(deriveChartRender(block(TRACKED), genesRows(200), undefined, { key: "h1", columns: [] })._unsafeUnwrap().bodyPx).toBe(CHART_BODY_MAX_PX);
    });
});

/** The tree of one axis as a block declares it: the edge table and its three columns. */
function treeOf(path: string): NonNullable<NonNullable<ChartBlock["trees"]>["x"]> {
    return { binding: { kind: "artifact-table", path, hash: HASH }, parent: "parent", child: "child", height: "height" };
}

/** Edge rows from `[parent, child, height]` triples. */
function edgeRows(edges: ReadonlyArray<readonly [string, string, number]>): ChartRow[] {
    return edges.map(([parent, child, height]) => ({ parent, child, height }));
}

/** The pasilla sample tree: average linkage of the seven samples on the z-scores of the top 40 genes. */
const SAMPLE_TREE = edgeRows([
    ["s12", "s10", 11.738902],
    ["s12", "s11", 11.738902],
    ["s11", "untreated1", 2.049651],
    ["s11", "s9", 2.049651],
    ["s10", "treated1", 1.709858],
    ["s10", "s7", 1.709858],
    ["s9", "untreated4", 1.563189],
    ["s9", "s8", 1.563189],
    ["s8", "untreated2", 1.119775],
    ["s8", "untreated3", 1.119775],
    ["s7", "treated2", 1.052487],
    ["s7", "treated3", 1.052487],
]);

/** A gene tree over the two genes of the excerpt, which names Kal1 first. */
const GENE_TREE = edgeRows([
    ["g1", "Kal1", 4.86],
    ["g1", "Treh", 4.86],
]);

/** A heatmap block of the excerpt with the given trees and encoding. */
function treed(
    trees: NonNullable<ChartBlock["trees"]>,
    encoding: Encoding = { x: "sample", y: "gene_symbol", value: "zscore", tracks: ["condition", "type"] },
): ChartBlock {
    return { ...block(encoding, { zscore: "z-score" }), trees };
}

/** The inputs of a block with a tree on each axis. */
const BOTH: ChartInputs = { trees: { x: { rows: SAMPLE_TREE }, y: { rows: GENE_TREE } } };

/** The series of one option that draws a dendrogram, with the grid of each. */
function treeSeries(option: EchartOption): Array<{ series: EchartOption; grid: EchartOption; xAxis: EchartOption; yAxis: EchartOption }> {
    const grids = option.grid as EchartOption[];
    const xAxes = option.xAxis as EchartOption[];
    const yAxes = option.yAxis as EchartOption[];
    return (option.series as EchartOption[])
        .filter((entry) => entry.type === "lines")
        .map((series) => {
            const xAxis = xAxes[series.xAxisIndex as number];
            return { series, xAxis, yAxis: yAxes[series.yAxisIndex as number], grid: grids[xAxis.gridIndex as number] };
        });
}

describe("the dendrograms of the heatmap", () => {
    const option = deriveChartOption(treed({ x: treeOf("sample_tree.csv"), y: treeOf("gene_tree.csv") }), TOP_GENES, undefined, BOTH)._unsafeUnwrap();
    const [xTree, yTree] = treeSeries(option);
    const grids = option.grid as EchartOption[];

    it("puts each axis in the depth-first leaf order of its tree", () => {
        expect((option.xAxis as EchartOption[])[0].data).toEqual(["treated1", "treated2", "treated3", "untreated1", "untreated4", "untreated2", "untreated3"]);
        expect((option.yAxis as EchartOption[])[0].data).toEqual(["Kal1", "Treh"]);
    });

    it("draws each edge as one elbow from the child up to the height of the parent and across to the place of the parent", () => {
        expect(xTree.series).toEqual(
            expect.objectContaining({
                type: "lines",
                coordinateSystem: "cartesian2d",
                polyline: true,
                silent: true,
                lineStyle: expect.objectContaining({ color: CHART_INK, opacity: 1 }),
            }),
        );
        const elbows = (xTree.series.data as Array<{ coords: number[][] }>).map((item) => item.coords);
        expect(elbows).toHaveLength(SAMPLE_TREE.length);
        // The root joins s10 (over treated1 and the pair of treated2 and treated3) and s11 (over the untreated samples).
        expect(elbows[0]).toEqual([
            [0.75, 1.709858],
            [0.75, 11.738902],
            [2.3125, 11.738902],
        ]);
        // A leaf rises from height zero at its place.
        expect(elbows[2]).toEqual([
            [3, 0],
            [3, 2.049651],
            [3.875, 2.049651],
        ]);
    });

    it("draws the tree of x above the tracks and the matrix, across the columns of the matrix", () => {
        const strips = grids[1];
        expect((xTree.grid.top as number) + (xTree.grid.height as number)).toBeLessThan(strips.top as number);
        expect((strips.top as number) < (grids[0].top as number)).toBe(true);
        expect([xTree.grid.left, xTree.grid.right]).toEqual([grids[0].left, grids[0].right]);
        expect([xTree.xAxis.min, xTree.xAxis.max, xTree.yAxis.min, xTree.yAxis.max]).toEqual([-0.5, 6.5, 0, 11.738902]);
        expect([xTree.xAxis.show, xTree.yAxis.show]).toEqual([false, false]);
    });

    it("draws the tree of y at the left of the row names, over the rows of the matrix, with the root at the left", () => {
        expect((yTree.grid.left as number) + (yTree.grid.width as number)).toBeLessThan(grids[0].left as number);
        expect([yTree.grid.top, yTree.grid.bottom]).toEqual([grids[0].top, grids[0].bottom]);
        expect([yTree.yAxis.min, yTree.yAxis.max, yTree.yAxis.inverse]).toEqual([-0.5, 1.5, true]);
        expect([yTree.xAxis.min, yTree.xAxis.max, yTree.xAxis.inverse]).toEqual([0, 4.86, true]);
        // Each row name starts beside the leaves, thus a smaller export text keeps the names at the tree.
        const names = asObj((option.yAxis as EchartOption[])[0].axisLabel);
        expect(names.align).toBe("left");
        expect((grids[0].left as number) - (names.margin as number)).toBe((yTree.grid.left as number) + (yTree.grid.width as number) + 4);
        const legends = (option.visualMap as EchartOption[]).slice(1).map((map) => map.left);
        expect(legends).toEqual([(grids[0].left as number) - (names.margin as number), (grids[0].left as number) - (names.margin as number)]);
        const elbows = (yTree.series.data as Array<{ coords: number[][] }>).map((item) => item.coords);
        // Along y the place is the second coordinate, and the height is the first.
        expect(elbows[0]).toEqual([
            [0, 0],
            [4.86, 0],
            [4.86, 0.5],
        ]);
    });

    it("keeps the strips and their legends in the x order of the tree", () => {
        const condition = (option.series as EchartOption[]).find((entry) => entry.name === "condition");
        expect(condition?.data).toEqual([
            [0, 0, 0],
            [1, 0, 0],
            [2, 0, 0],
            [3, 0, 1],
            [4, 0, 1],
            [5, 0, 1],
            [6, 0, 1],
        ]);
    });

    it("draws the distance heatmap with one tree on both axes, and each axis takes its leaf order", () => {
        const names = ["untreated1", "untreated2", "untreated3", "untreated4", "treated1", "treated2", "treated3"];
        const matrix = [
            [0.0, 26.76, 31.0, 26.63, 33.25, 35.24, 36.23],
            [26.76, 0.0, 25.9, 25.73, 29.74, 35.53, 36.17],
            [31.0, 25.9, 0.0, 20.51, 38.49, 31.18, 31.58],
            [26.63, 25.73, 20.51, 0.0, 37.16, 28.94, 28.31],
            [33.25, 29.74, 38.49, 37.16, 0.0, 28.84, 30.45],
            [35.24, 35.53, 31.18, 28.94, 28.84, 0.0, 15.32],
            [36.23, 36.17, 31.58, 28.31, 30.45, 15.32, 0.0],
        ];
        const rows: ChartRow[] = names.flatMap((a, i) => names.map((b, j) => ({ sample_a: a, sample_b: b, distance: matrix[i][j] })));
        const distanceTree = edgeRows([
            ["d12", "d10", 38.493144],
            ["d12", "d11", 38.493144],
            ["d11", "untreated1", 30.99595],
            ["d11", "d9", 30.99595],
            ["d10", "treated1", 30.452104],
            ["d10", "d7", 30.452104],
            ["d9", "untreated2", 25.904956],
            ["d9", "d8", 25.904956],
            ["d8", "untreated3", 20.511885],
            ["d8", "untreated4", 20.511885],
            ["d7", "treated2", 15.319818],
            ["d7", "treated3", 15.319818],
        ]);
        const tree = treeOf("sample_distance_tree.csv");
        const distances = treed({ x: tree, y: tree }, { x: "sample_a", y: "sample_b", value: "distance" });
        const drawn = deriveChartOption(distances, rows, undefined, { trees: { x: { rows: distanceTree }, y: { rows: distanceTree } } })._unsafeUnwrap();
        const order = ["treated1", "treated2", "treated3", "untreated1", "untreated2", "untreated3", "untreated4"];
        expect((drawn.xAxis as EchartOption[])[0].data).toEqual(order);
        expect((drawn.yAxis as EchartOption[])[0].data).toEqual(order);
        expect(treeSeries(drawn).map((entry) => (entry.series.data as unknown[]).length)).toEqual([12, 12]);
        expect(asObj(drawn.legend).show).toBe(false);
    });

    it("exports each tree as vector lines at the single and the double column width", () => {
        const render = deriveChartRender(
            treed({ x: treeOf("sample_tree.csv"), y: treeOf("gene_tree.csv") }),
            TOP_GENES,
            undefined,
            { key: "h1", columns: [] },
            BOTH,
        )._unsafeUnwrap();
        const svgs = chartSvgAssets(echarts, "h1", render.inline, render.bodyPx)._unsafeUnwrap();
        for (const svg of [svgs?.single.bytes ?? "", svgs?.double.bytes ?? ""]) {
            expect(svg.match(/<polyline /g)?.length).toBe(SAMPLE_TREE.length + GENE_TREE.length);
        }
    });

    it("grows the y tree with the matrix of a taller body", () => {
        const genes = 40;
        const rows: ChartRow[] = [];
        const edges: Array<readonly [string, string, number]> = [];
        for (let gene = 0; gene < genes; gene += 1) {
            for (const row of TOP_GENES.slice(0, 7)) rows.push({ ...row, gene_symbol: `G${gene}`, zscore: gene });
            // A caterpillar tree: each inner node holds one gene and the rest of the tree.
            if (gene < genes - 1)
                edges.push([`n${gene}`, `G${gene}`, genes - gene], [`n${gene}`, gene < genes - 2 ? `n${gene + 1}` : `G${gene + 1}`, genes - gene]);
        }
        const tall = treed({ y: treeOf("gene_tree.csv") });
        const render = deriveChartRender(tall, rows, undefined, { key: "h1", columns: [] }, { trees: { y: { rows: edgeRows(edges) } } })._unsafeUnwrap();
        expect(render.bodyPx).toBeGreaterThan(CHART_BODY_PX);
        const [yTall] = treeSeries(render.option);
        const matrixGrid = (render.option.grid as EchartOption[])[0];
        expect([yTall.grid.top, yTall.grid.bottom]).toEqual([matrixGrid.top, matrixGrid.bottom]);
        expect((render.option.yAxis as EchartOption[])[0].data).toEqual(Array.from({ length: genes }, (_gene, index) => `G${index}`));
    });
});

describe("the refusals of a heatmap tree", () => {
    /** The refusal of a block with a sample tree of the given edges. */
    function refusal(edges: ChartRow[], encoding?: Encoding): string {
        return deriveChartOption(treed({ x: treeOf("sample_tree.csv") }, encoding), TOP_GENES, undefined, { trees: { x: { rows: edges } } })._unsafeUnwrapErr()
            .detail;
    }

    it("refuses a leaf that is no category, and a category that no leaf names", () => {
        const extra = edgeRows([...SAMPLE_TREE.map((row) => [row.parent, row.child, row.height] as [string, string, number]), ["s9", "untreated5", 1.563189]]);
        expect(refusal(extra)).toBe('The tree of x holds the leaf "untreated5", which is no category of the x axis.');
        const missing = SAMPLE_TREE.filter((row) => row.child !== "untreated3");
        expect(refusal(missing)).toBe('The tree of x holds no leaf for the x category "untreated3".');
    });

    it("refuses two roots, a cycle, and a node with two parents", () => {
        expect(refusal([...SAMPLE_TREE, { parent: "other", child: "lone", height: 1 }])).toBe(
            'The tree of x holds more than one root, for example "s12" and "other". A tree holds one root.',
        );
        expect(refusal([...SAMPLE_TREE, { parent: "c1", child: "c2", height: 1 }, { parent: "c2", child: "c1", height: 1 }])).toBe(
            'The tree of x holds a cycle through the node "c1".',
        );
        expect(
            refusal([
                { parent: "a", child: "b", height: 1 },
                { parent: "b", child: "a", height: 1 },
            ]),
        ).toBe('The tree of x holds a cycle through the node "a".');
        expect(refusal([...SAMPLE_TREE, { parent: "s7", child: "untreated1", height: 1.052487 }])).toBe(
            'The tree of x gives the node "untreated1" two parents, "s11" and "s7".',
        );
    });

    it("refuses a child over its parent, a node with two heights, and a height that is no number", () => {
        const over = SAMPLE_TREE.map((row) => (row.parent === "s7" ? { ...row, height: 3 } : row));
        expect(refusal(over)).toBe('The tree of x puts the node "s7" at the height 3, over the height 1.709858 of its parent "s10".');
        const split = SAMPLE_TREE.map((row, index) => (index === 1 ? { ...row, height: 12 } : row));
        expect(refusal(split)).toBe('The tree of x gives the node "s12" two heights, 11.738902 and 12.');
        const text = SAMPLE_TREE.map((row, index) => (index === 0 ? { ...row, height: "tall" } : row));
        expect(refusal(text)).toBe('The tree of x gives the node "s12" the height "tall", which is not a number.');
    });

    it("refuses an empty tree and an edge with no child", () => {
        expect(refusal([])).toBe("The tree of x holds no edge.");
        expect(refusal(SAMPLE_TREE.map((row, index) => (index === 3 ? { ...row, child: "" } : row)))).toBe(
            "The tree of x holds an edge with no child at row 4.",
        );
    });

    it("refuses an orderBy on an axis that takes the order of its tree, because two orders conflict", () => {
        expect(refusal(SAMPLE_TREE, { ...TRACKED })).toBe('The x axis takes the leaf order of its tree, thus the "x" channel takes no "orderBy".');
    });

    it("refuses a block whose tree the value entry does not carry", () => {
        const problem = deriveChartOption(treed({ x: treeOf("sample_tree.csv") }), TOP_GENES)._unsafeUnwrapErr();
        expect(problem).toEqual({ blockId: "h1", kind: "missing-value", detail: "The chart declares a tree of x, and its value entry carries no tree of x." });
    });
});
