/**
 * The GSEA running enrichment score figure: three stacked panels over one shared rank axis. The top panel draws
 * the running score of each set, the middle panel draws a tick at each hit, and the bottom panel draws the
 * ranked metric as an area.
 */

import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import { deriveChartOption, type ChartInputs, type ChartOpts, type ChartRow, type EchartOption } from "../chart.js";
import { chartSvgAssets } from "../chart-export.js";
import { CHART_PALETTE, GUIDE_LINE_COLOR, MUTED_CHART_COLOR, SCATTER_CROWD_ROWS } from "../design.js";
import { statisticText } from "./common.js";
import { GSEA_FIGURE, GSEA_STRIDE_TARGET } from "./gsea.js";
import { FIGURE_MODULES } from "./index.js";

type Encoding = NonNullable<ChartBlock["encoding"]>;

const HASH = `sha256:${"b".repeat(64)}`;

const ENCODING: Encoding = { x: "rank", y: "running_es", group: "term", hit: "hit", metric: "ranked_metric" };

const OPTS: ChartOpts = { figures: { gsea: GSEA_FIGURE } };

/** A gsea block over the running-score table, with the given encoding and extra members. */
function block(encoding: Encoding = ENCODING, extra: Partial<ChartBlock> = {}): ChartBlock {
    return {
        kind: "chart",
        id: "g1",
        binding: { kind: "artifact-table", path: "enrichment/gsea_running_score.csv", hash: HASH },
        chartType: "gsea",
        encoding,
        ...extra,
    };
}

/** One statistic of a block, bound to a cell of the given column of the results table. */
function statistic(label: string, column: string): NonNullable<ChartBlock["statistics"]>[number] {
    return { label, value: { kind: "artifact-value", path: "enrichment/gsea_results.csv", hash: HASH, locator: { column, row: 0 } } };
}

/**
 * The rows of a GSEA running-score table, as a prerank run writes them.
 *
 * The metric falls from +10 to −10 over the ranks and it is shared by every set. The running score of a set
 * rises at each hit by the share of the absolute metric that the hit carries, and it falls at each other rank
 * by the share of one miss, thus it starts and it ends at zero.
 */
function gseaRows(ranks: number, sets: ReadonlyArray<{ name: string; hits: readonly number[] }>): ChartRow[] {
    const metric = (rank: number): number => Math.round(((ranks + 1 - 2 * rank) / ranks) * 10 * 1e6) / 1e6;
    const rows: ChartRow[] = [];
    for (const set of sets) {
        const hits = new Set(set.hits);
        let weight = 0;
        for (const rank of hits) weight += Math.abs(metric(rank));
        const miss = 1 / (ranks - hits.size);
        let score = 0;
        for (let rank = 1; rank <= ranks; rank += 1) {
            const hit = hits.has(rank);
            score += hit ? Math.abs(metric(rank)) / weight : -miss;
            rows.push({ term: set.name, rank, running_es: Math.round(score * 1e6) / 1e6, hit: hit ? 1 : 0, ranked_metric: metric(rank) });
        }
    }
    return rows;
}

/** The ranks of every `step`-th rank from `from`, `count` of them. */
function spaced(from: number, step: number, count: number): number[] {
    return Array.from({ length: count }, (_value, index) => from + index * step);
}

const EARLY = { name: "cell-cell junction assembly (GO:0007043)", hits: [4, 9, 15, 22, 40, 41, 60, 90, 150, 300] };
const LATE = { name: "septate_junction_assembly", hits: [30, 70, 110, 500, 700, 850, 900, 960, 990, 999] };
const SMALL = gseaRows(1000, [EARLY, LATE]);

function derive(rows: readonly ChartRow[], chartBlock: ChartBlock = block(), inputs: ChartInputs = {}): EchartOption {
    return deriveChartOption(chartBlock, rows, undefined, inputs, OPTS)._unsafeUnwrap();
}

function list(option: EchartOption, member: string): EchartOption[] {
    return option[member] as EchartOption[];
}

/** The series of one panel, in option order: 0 is the top panel, 1 the middle, 2 the bottom. */
function panelSeries(option: EchartOption, panel: number): EchartOption[] {
    return list(option, "series").filter((series) => series.xAxisIndex === panel);
}

/** The drawn points of one series: each item whose members are all numbers. */
function drawn(series: EchartOption): number[][] {
    return (series.data as unknown[][]).filter((item) => item.every((member) => typeof member === "number")) as number[][];
}

/** The grid of one panel as numbers: the top, the height, the left, and the right, in percent. */
function place(grid: EchartOption): { top: number; height: number; left: number; right: number } {
    const read = (value: unknown): number => Number.parseFloat(String(value));
    return { top: read(grid.top), height: read(grid.height), left: read(grid.left), right: read(grid.right) };
}

describe("the gsea figure", () => {
    it("registers under the gsea chart type", () => {
        expect(FIGURE_MODULES.gsea).toBe(GSEA_FIGURE);
    });

    it("stacks three panels at the heights 1.5 : 0.5 : 1, with one left edge and one right edge", () => {
        const grids = list(derive(SMALL), "grid").map(place);
        expect(grids).toHaveLength(3);
        const [top, middle, bottom] = grids;
        expect(top.top).toBeLessThan(middle.top);
        expect(middle.top).toBeGreaterThanOrEqual(top.top + top.height);
        expect(bottom.top).toBeGreaterThanOrEqual(middle.top + middle.height);
        expect(top.height / bottom.height).toBeCloseTo(1.5, 5);
        expect(middle.height / bottom.height).toBeCloseTo(0.5, 5);
        for (const grid of grids) {
            expect([grid.left, grid.right]).toEqual([top.left, top.right]);
        }
    });

    it("shares one rank range across the three x axes, and titles and labels the bottom axis alone", () => {
        const xAxes = list(derive(SMALL), "xAxis");
        expect(xAxes.map((axis) => [axis.gridIndex, axis.min, axis.max])).toEqual([
            [0, 1, 1000],
            [1, 1, 1000],
            [2, 1, 1000],
        ]);
        expect(xAxes.map((axis) => axis.name)).toEqual([undefined, undefined, "Rank in ordered dataset"]);
        expect(xAxes.map((axis) => (axis.axisLabel as EchartOption).show)).toEqual([false, false, undefined]);
        expect(xAxes[2]).toEqual(expect.objectContaining({ type: "value", nameLocation: "middle" }));
    });

    it("draws the running score of each set in the top panel, in the palette color and in table order", () => {
        const top = panelSeries(derive(SMALL), 0);
        expect(top.map((series) => [series.type, series.name, (series.lineStyle as EchartOption).color])).toEqual([
            ["line", "cell-cell junction assembly (GO:0007043)", CHART_PALETTE[0]],
            ["line", "septate junction assembly", CHART_PALETTE[1]],
        ]);
        // Under the stride target the line keeps every rank of the table.
        expect(drawn(top[0])).toHaveLength(1000);
        expect(drawn(top[0])[3]).toEqual([4, SMALL[3].running_es as number]);
    });

    it("draws a line at zero and a dashed mark at the maximum deviation of each set", () => {
        const top = panelSeries(derive(SMALL), 0);
        const zero = (top[0].markLine as EchartOption).data as EchartOption[];
        expect(zero[0]).toEqual(expect.objectContaining({ yAxis: 0 }));
        expect((top[0].markLine as EchartOption).lineStyle).toEqual(expect.objectContaining({ color: GUIDE_LINE_COLOR }));
        for (const [index, series] of top.entries()) {
            const points = drawn(series);
            let peak = points[0];
            for (const point of points) if (Math.abs(point[1]) > Math.abs(peak[1])) peak = point;
            const marks = (series.markLine as EchartOption).data as unknown[];
            const mark = marks[marks.length - 1] as EchartOption[];
            expect(mark.map((end) => end.coord)).toEqual([
                [peak[0], 0],
                [peak[0], peak[1]],
            ]);
            expect(mark[0].lineStyle).toEqual(expect.objectContaining({ color: CHART_PALETTE[index], type: "dashed" }));
        }
    });

    it("draws one tick at each hit of each set in the middle panel, one row for each set in its color", () => {
        const middle = panelSeries(derive(SMALL), 1);
        expect(middle.map((series) => [series.name, (series.lineStyle as EchartOption).color, series.silent])).toEqual([
            ["cell-cell junction assembly (GO:0007043)", CHART_PALETTE[0], true],
            ["septate junction assembly", CHART_PALETTE[1], true],
        ]);
        for (const [row, set] of [EARLY, LATE].entries()) {
            const ends = drawn(middle[row]);
            expect(ends).toHaveLength(set.hits.length * 2);
            expect(ends.filter((_end, index) => index % 2 === 0).map((end) => end[0])).toEqual(set.hits);
            for (const [x, y] of ends) {
                expect(x).toBeGreaterThan(0);
                expect(y).toBeGreaterThan(row);
                expect(y).toBeLessThan(row + 1);
            }
        }
        const yAxes = list(derive(SMALL), "yAxis");
        expect(yAxes[1]).toEqual(expect.objectContaining({ gridIndex: 1, min: 0, max: 2, inverse: true, show: false }));
    });

    it("draws the ranked metric once as a gray area with a line at zero in the bottom panel", () => {
        const option = derive(SMALL);
        const [metric] = panelSeries(option, 2);
        expect(metric).toEqual(
            expect.objectContaining({ type: "line", name: "Ranked metric", areaStyle: expect.objectContaining({ color: MUTED_CHART_COLOR }) }),
        );
        expect(drawn(metric)).toHaveLength(1000);
        expect(drawn(metric)[0]).toEqual([1, SMALL[0].ranked_metric as number]);
        expect(((metric.markLine as EchartOption).data as EchartOption[])[0]).toEqual(expect.objectContaining({ yAxis: 0 }));
        const yAxes = list(option, "yAxis");
        expect([yAxes[0].name, yAxes[2].name]).toEqual(["Enrichment score", "Ranked metric"]);
        expect([yAxes[0].nameRotate, yAxes[2].nameRotate]).toEqual([90, 90]);
    });

    it("titles an axis with the declared label of its column before the title of the figure", () => {
        const labeled = block(ENCODING, {
            binding: {
                kind: "artifact-table",
                path: "enrichment/gsea_running_score.csv",
                hash: HASH,
                columnLabels: { ranked_metric: "Wald statistic", rank: "Gene rank" },
            },
        });
        const option = derive(SMALL, labeled);
        expect(list(option, "yAxis")[2].name).toBe("Wald statistic");
        expect(list(option, "xAxis")[2].name).toBe("Gene rank");
        expect(panelSeries(option, 2)[0].name).toBe("Wald statistic");
    });

    it("names each set in the legend with a line icon, and draws no legend for one set", () => {
        const legend = derive(SMALL).legend as EchartOption;
        expect((legend.data as EchartOption[]).map((entry) => entry.name)).toEqual(["cell-cell junction assembly (GO:0007043)", "septate junction assembly"]);
        const single = derive(gseaRows(200, [{ name: "one", hits: [3, 7, 11] }]), block({ x: "rank", y: "running_es", hit: "hit", metric: "ranked_metric" }));
        expect(single.legend).toEqual({ show: false });
        expect(panelSeries(single, 0)).toHaveLength(1);
        expect(list(single, "yAxis")[1].max).toBe(1);
    });

    it("prints the statistics inside the top panel, at the top right for a set that peaks above zero", () => {
        const option = derive(SMALL, block(ENCODING, { statistics: [statistic("NES", "NES"), statistic("FDR", "fdr")] }), {
            statistics: [
                { label: "NES", value: 2.224448 },
                { label: "FDR", value: 0.00162 },
            ],
        });
        const [text] = list(option, "graphic");
        const style = text.style as EchartOption;
        expect(style.text).toBe(`NES = ${statisticText(2.224448, "NES")}\nFDR = ${statisticText(0.00162, "fdr")}`);
        expect(style.text).toBe("NES = 2.22\nFDR = 1.6 × 10⁻³");
        expect(style.align).toBe("right");
        const top = place(list(option, "grid")[0]);
        const offset = Number.parseFloat(String(text.top));
        expect(offset).toBeGreaterThan(top.top);
        expect(offset).toBeLessThan(top.top + top.height / 2);
        expect(Number.parseFloat(String(text.right))).toBeGreaterThan(top.right);
    });

    it("prints the statistics at the bottom left of the top panel for a set that dips under zero", () => {
        const rows = gseaRows(1000, [{ name: "down", hits: [700, 800, 900, 950, 990, 995, 999, 1000] }]);
        const option = derive(rows, block(ENCODING, { statistics: [statistic("NES", "NES")] }), { statistics: [{ label: "NES", value: -1.9 }] });
        const [text] = list(option, "graphic");
        expect((text.style as EchartOption).align).toBe("left");
        const top = place(list(option, "grid")[0]);
        const fromBottom = Number.parseFloat(String(text.bottom));
        expect(100 - fromBottom).toBeLessThan(top.top + top.height);
        expect(100 - fromBottom).toBeGreaterThan(top.top + top.height / 2);
    });

    it("thins the drawn vertices of a long table and keeps each hit, each turn, and the maximum deviation", () => {
        const ranks = 9790;
        const sets = [
            { name: "early", hits: spaced(4, 23, 60) },
            { name: "middle", hits: spaced(3000, 41, 50) },
            { name: "late", hits: spaced(8000, 31, 55) },
        ];
        const rows = gseaRows(ranks, sets);
        const option = derive(rows);
        const stride = Math.ceil(ranks / GSEA_STRIDE_TARGET);
        for (const [index, series] of panelSeries(option, 0).entries()) {
            const vertices = drawn(series);
            const kept = new Set(vertices.map((vertex) => vertex[0]));
            for (const hit of sets[index].hits) {
                expect(kept.has(hit)).toBe(true);
                // The rank before a hit is the foot of the rise, thus the line keeps it too.
                expect(kept.has(hit - 1)).toBe(true);
            }
            expect(kept.has(1)).toBe(true);
            expect(kept.has(ranks)).toBe(true);
            const own = rows.filter((row) => row.term === sets[index].name);
            let peak = own[0];
            for (const row of own) if (Math.abs(row.running_es as number) > Math.abs(peak.running_es as number)) peak = row;
            expect(kept.has(peak.rank as number)).toBe(true);
            expect(vertices.length).toBeLessThanOrEqual(Math.ceil(ranks / stride) + 2 * sets[index].hits.length + 4);
            // Each kept vertex is a cell of the table.
            for (const [rank, score] of vertices) expect(own[rank - 1].running_es).toBe(score);
        }
        const middle = panelSeries(option, 1);
        expect(middle.map((series) => drawn(series).length / 2)).toEqual(sets.map((set) => set.hits.length));
        expect(drawn(panelSeries(option, 2)[0]).length).toBeLessThanOrEqual(Math.ceil(ranks / stride) + 4);
    });

    it("stays under the export bound for three sets over the whole ranked list, thus the SVG draws", () => {
        const rows = gseaRows(9790, [
            { name: "early", hits: spaced(4, 23, 60) },
            { name: "middle", hits: spaced(3000, 41, 50) },
            { name: "late", hits: spaced(8000, 31, 55) },
        ]);
        const option = derive(rows);
        const coordinates = list(option, "series").reduce((sum, series) => sum + drawn(series).length, 0);
        expect(coordinates).toBeLessThan(SCATTER_CROWD_ROWS);
        const svgs = chartSvgAssets("g1", option)._unsafeUnwrap();
        expect(svgs).toBeDefined();
        expect(svgs?.single.bytes).toContain("Rank in ordered dataset");
    });

    it("derives the same option for the same rows", () => {
        expect(JSON.stringify(derive(SMALL))).toBe(JSON.stringify(derive(SMALL)));
    });

    it("sorts the rows of each set by rank", () => {
        // The reversed table meets the late set first, thus the late set draws first.
        const reversed = panelSeries(derive([...SMALL].reverse()), 0);
        expect(reversed.map((series) => series.name)).toEqual(["septate junction assembly", "cell-cell junction assembly (GO:0007043)"]);
        expect(drawn(reversed[0])).toEqual(drawn(panelSeries(derive(SMALL), 0)[1]));
    });
});

describe("the gsea refusals", () => {
    function refusal(rows: readonly ChartRow[], chartBlock: ChartBlock): string {
        return deriveChartOption(chartBlock, rows, undefined, {}, OPTS)._unsafeUnwrapErr().detail;
    }

    it("refuses a block with no hit channel or no metric channel, and names the channel", () => {
        expect(refusal(SMALL, block({ x: "rank", y: "running_es", group: "term", metric: "ranked_metric" }))).toBe(
            'The gsea figure needs a column for the "hit" channel.',
        );
        expect(refusal(SMALL, block({ x: "rank", y: "running_es", group: "term", hit: "hit" }))).toBe(
            'The gsea figure needs a column for the "metric" channel.',
        );
    });

    it("refuses a column that no row holds", () => {
        expect(refusal(SMALL, block({ ...ENCODING, metric: "stat" }))).toBe('The column "stat" is absent from every row.');
    });

    it("refuses a transform or an order on a channel", () => {
        expect(refusal(SMALL, block({ ...ENCODING, metric: { column: "ranked_metric", transform: "abs" } }))).toBe(
            'The gsea figure reads the "metric" channel as a plain column, thus it takes no transform and no order.',
        );
    });

    it("refuses a hit cell that is not 1 or 0", () => {
        const rows = SMALL.map((row, index) => (index === 3 ? { ...row, hit: "True" } : row));
        expect(refusal(rows, block())).toBe('The "hit" column "hit" holds "True" at rank 4. A hit is 1 or 0.');
    });

    it("refuses two metric values at one rank, because the sets share one ranked list", () => {
        const rows = SMALL.map((row, index) => (index === 1005 ? { ...row, ranked_metric: 0 } : row));
        expect(refusal(rows, block())).toBe(
            'The "metric" column "ranked_metric" holds two values at rank 6. The sets of one figure share one ranked list, thus each rank holds one metric value.',
        );
    });

    it("refuses two rows of one set at one rank", () => {
        const rows = [...SMALL, { ...SMALL[10] }];
        expect(refusal(rows, block())).toBe('The set "cell-cell junction assembly (GO:0007043)" holds two rows at rank 11. A set holds one row for each rank.');
    });

    it("refuses a member that the figure does not read", () => {
        expect(refusal(SMALL, block({ ...ENCODING, label: "term" }))).toBe('The gsea chart takes no "label" channel.');
    });
});
