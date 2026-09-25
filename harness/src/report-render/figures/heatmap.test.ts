/**
 * The heatmap over excerpts of the pasilla top-gene heatmap and the sample distance table.
 */

import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import { deriveChartOption, deriveChartRender, type ChartRow, type EchartOption } from "../chart.js";
import { CHART_BODY_MAX_PX, CHART_BODY_PX, CHART_PALETTE, DIVERGING_RAMP, SEQUENTIAL_RAMP } from "../design.js";
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
