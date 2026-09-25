/**
 * The volcano figure: the null points under the two signal sides, the counts in the legend, the labels of the
 * most significant signal points, and the symmetric effect axis.
 */

import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import { VOLCANO_EFFECT_THRESHOLD, VOLCANO_P_THRESHOLD } from "../chart-presets.js";
import { CHART_SOURCE_MEMBER, deriveChartOption, deriveChartRender, type ChartDataSource, type ChartOpts, type ChartRow, type EchartOption } from "../chart.js";
import { exportOption } from "../chart-renderers.js";
import { CHART_EXPORT_SIZES, CHART_INLINE_OPTION_BOUND, CHART_PALETTE, MUTED_CHART_COLOR } from "../design.js";
import { CHART_SERIES_BUILDER } from "../page.js";
import { BELOW_RESOLUTION_SYMBOL, DENSE_NULL_SYMBOL_PX, DENSE_NULL_Z, DENSE_SIGNAL_SYMBOL_PX, niceCeiling, POINT_NAMES } from "./dense.js";
import { EXPORT_PLOT_FRAMES, leaderNameBox, overlaps, PAGE_PLOT_FRAME, type LeaderName, type NameFrame } from "./label-room.js";
import { FIGURE_MODULES } from "./index.js";
import { VOLCANO_FIGURE, VOLCANO_LABEL_COUNT } from "./volcano.js";

type Encoding = NonNullable<ChartBlock["encoding"]>;

const HASH = `sha256:${"a".repeat(64)}`;
const OPTS: ChartOpts = { figures: { volcano: VOLCANO_FIGURE } };
const ENCODING: Encoding = { x: "log2FoldChange", y: "padj", label: "gene_symbol" };

function block(encoding: Encoding = ENCODING, extra: Partial<ChartBlock> = {}): ChartBlock {
    return {
        kind: "chart",
        id: "v1",
        binding: { kind: "artifact-table", path: "bulk_rnaseq/de_results.csv", hash: HASH },
        chartType: "volcano",
        encoding,
        ...extra,
    };
}

/**
 * An excerpt of the pasilla table of DESeq2: twelve signal genes, one signal gene with no symbol, a gene past
 * the effect cut with no significant p, null genes, and a gene with no adjusted p.
 */
const ROWS: ChartRow[] = [
    { gene_symbol: "Kal1", log2FoldChange: -4.619, padj: 1.7e-159 },
    { gene_symbol: "Ant2", log2FoldChange: 2.9, padj: 8.17e-110 },
    { gene_symbol: "", log2FoldChange: 3.3, padj: 1e-108 },
    { gene_symbol: "Hml", log2FoldChange: -2.197, padj: 3.45e-106 },
    { gene_symbol: "sesB", log2FoldChange: -3.18, padj: 1.03e-103 },
    { gene_symbol: "CG3770", log2FoldChange: -2.56, padj: 1.77e-73 },
    { gene_symbol: "Oadh", log2FoldChange: -4.162, padj: 1.06e-68 },
    { gene_symbol: "gas", log2FoldChange: -3.511, padj: 2.67e-57 },
    { gene_symbol: "sv2", log2FoldChange: -2.445, padj: 6.62e-55 },
    { gene_symbol: "Ama", log2FoldChange: 2.68, padj: 7.04e-46 },
    { gene_symbol: "LpR2", log2FoldChange: 2.328, padj: 4.62e-37 },
    { gene_symbol: "Rgk1", log2FoldChange: -3.642, padj: 1.26e-36 },
    { gene_symbol: "Ugt317A1", log2FoldChange: -1.575, padj: 3.13e-35 },
    { gene_symbol: "l(1)G0196", log2FoldChange: 0.9, padj: 4.17e-33 },
    { gene_symbol: "Sirup", log2FoldChange: 5.934, padj: 0.4 },
    { gene_symbol: "a", log2FoldChange: 0.0023, padj: 0.997 },
    { gene_symbol: "abd-A", log2FoldChange: -0.491, padj: "" },
    { gene_symbol: "bgm", log2FoldChange: 0.21, padj: 0.61 },
];

function derive(chartBlock: ChartBlock = block(), rows: readonly ChartRow[] = ROWS): EchartOption {
    return deriveChartOption(chartBlock, rows, undefined, {}, OPTS)._unsafeUnwrap();
}

function seriesOf(option: EchartOption): EchartOption[] {
    return option.series as EchartOption[];
}

/** The names of the points of one series that carry a shown label. */
function labeled(series: EchartOption): string[] {
    return (series.data as unknown[])
        .filter((item): item is EchartOption => typeof item === "object" && item !== null && !Array.isArray(item) && "label" in item)
        .map((item) => String(item.name));
}

describe("the volcano figure", () => {
    it("registers in the figure registry", () => {
        expect(FIGURE_MODULES.volcano).toBe(VOLCANO_FIGURE);
    });

    it("draws the null points under the two signal sides, gray and smaller", () => {
        const [down, up, ns] = seriesOf(derive());
        expect(down.itemStyle).toEqual({ color: CHART_PALETTE[0], opacity: expect.any(Number) });
        expect(up.itemStyle).toEqual({ color: CHART_PALETTE[1], opacity: expect.any(Number) });
        expect(ns.itemStyle).toEqual({ color: MUTED_CHART_COLOR, opacity: expect.any(Number) });
        expect(ns.z).toBe(DENSE_NULL_Z);
        // The runtime draws a scatter at the order 2 where the series names none, thus the null layer sits under.
        expect(down.z === undefined || (down.z as number) > DENSE_NULL_Z).toBe(true);
        expect(ns.symbolSize).toBe(DENSE_NULL_SYMBOL_PX);
        expect(up.symbolSize).toBe(DENSE_SIGNAL_SYMBOL_PX);
        expect(ns.symbolSize as number).toBeLessThan(up.symbolSize as number);
    });

    it("names each side in the legend with the count of its points", () => {
        const names = seriesOf(derive())
            .slice(0, 3)
            .map((series) => series.name);
        // The gene with no adjusted p draws no point, thus it counts on no side.
        expect(names).toEqual(["Down (9)", "Up (4)", "Not significant (4)"]);
        expect((derive().legend as EchartOption).data).toEqual([
            { name: "Down (9)", icon: "circle" },
            { name: "Up (4)", icon: "circle" },
            { name: "Not significant (4)", icon: "circle" },
        ]);
    });

    it("names the ten most significant signal points that carry a name, in the order of their p", () => {
        const series = seriesOf(derive());
        const names = series.at(-1) as EchartOption;
        expect(names.name).toBe(POINT_NAMES);
        // The page frame reads a window 1280 pixels wide, thus the runtime hides a name that still overlaps another
        // on a narrower window.
        expect(names.labelLayout).toEqual({ hideOverlap: true });
        // `l(1)G0196` is significant under the effect cut, and the gene with no symbol names nothing, thus
        // neither takes a place. `Rgk1` is the eleventh signal gene with a name.
        expect((names.data as EchartOption[]).map((item) => item.name)).toEqual(["Kal1", "Ant2", "Hml", "sesB", "CG3770", "Oadh", "gas", "sv2", "Ama", "LpR2"]);
        expect(VOLCANO_LABEL_COUNT).toBe(10);
        // The points carry no label of the runtime, thus no name hides and no name draws two times.
        for (const points of series.slice(0, 3)) {
            expect(labeled(points)).toEqual([]);
            expect(points.labelLayout).toBeUndefined();
        }
    });

    it("places each name clear of each other name and of each point, with a leader line to its point", () => {
        const names = seriesOf(derive()).at(-1) as EchartOption;
        const items = names.data as EchartOption[];
        const plot = { x: { min: -6, max: 6 }, y: { min: 0, max: 200 } };
        const boxes = items.map((item) => {
            const [x, y] = item.value as number[];
            const placed: LeaderName = { x, y, side: (item.label as EchartOption).position as LeaderName["side"] };
            return leaderNameBox(placed, String(item.name), plot, PAGE_PLOT_FRAME);
        });
        for (const [index, box] of boxes.entries()) {
            for (const other of boxes.slice(index + 1)) expect(overlaps(box, other)).toBe(false);
            for (const row of ROWS) {
                const p = Number(row.padj);
                if (row.padj === "" || !(p > 0)) continue;
                const [x, y] = [Number(row.log2FoldChange), -Math.log10(p)];
                expect(x > box.left && x < box.right && y > box.bottom && y < box.top).toBe(false);
            }
        }
        const leaders = (names.markLine as EchartOption).data as Array<Array<{ coord: number[] }>>;
        expect(leaders).toHaveLength(10);
        expect(leaders[0][0].coord).toEqual([-4.619, -Math.log10(1.7e-159)]);
        expect(leaders[0][1].coord).toEqual(items[0].value as number[]);
    });

    it("draws the effect axis symmetric around zero, and the p axis from zero", () => {
        const option = derive();
        const x = option.xAxis as EchartOption;
        // The largest effect is 5.934, and the axis ends at the round number past it on both sides.
        expect(x.min).toBe(-6);
        expect(x.max).toBe(6);
        expect((option.yAxis as EchartOption).min).toBe(0);
    });

    it("keeps the guides and the split on one pair of cuts", () => {
        const option = derive(block(ENCODING, { thresholds: { significance: 1e-60, effect: 3 } }));
        const names = seriesOf(option)
            .slice(0, 3)
            .map((series) => series.name);
        // Under the tighter cuts `Kal1`, `sesB`, and `Oadh` stay down, the unnamed gene stays up, and `Ant2` falls to null.
        expect(names).toEqual(["Down (3)", "Up (1)", "Not significant (13)"]);
        const guides = seriesOf(option)
            .slice(0, 3)
            .flatMap((series) => ((series.markLine as EchartOption | undefined)?.data as EchartOption[] | undefined) ?? []);
        expect(guides.map((guide) => guide.yAxis ?? guide.xAxis)).toEqual([-Math.log10(1e-60), -3, 3]);
        const defaults = seriesOf(derive())
            .slice(0, 3)
            .flatMap((series) => ((series.markLine as EchartOption | undefined)?.data as EchartOption[] | undefined) ?? []);
        expect(defaults.map((guide) => guide.yAxis ?? guide.xAxis)).toEqual([
            -Math.log10(VOLCANO_P_THRESHOLD),
            -VOLCANO_EFFECT_THRESHOLD,
            VOLCANO_EFFECT_THRESHOLD,
        ]);
    });

    it("prints the label of the p guide in the typographic form of the number helper", () => {
        const guideLabel = (option: EchartOption): unknown =>
            seriesOf(option)
                .flatMap((series) => ((series.markLine as EchartOption | undefined)?.data as EchartOption[] | undefined) ?? [])
                .find((guide) => guide.yAxis !== undefined)?.label as unknown;
        expect((guideLabel(derive(block(ENCODING, { thresholds: { significance: 1e-7, effect: 1 } }))) as EchartOption).formatter).toBe("p 1 × 10⁻⁷");
        expect((guideLabel(derive()) as EchartOption).formatter).toBe("p 0.05");
    });

    it("refuses a group channel, because the figure splits its rows by the cuts", () => {
        const problem = deriveChartOption(block({ ...ENCODING, group: "gene_symbol" }), ROWS, undefined, {}, OPTS)._unsafeUnwrapErr();
        expect(problem.detail).toBe('The volcano chart takes no "group" channel.');
    });

    it("refuses a block with no p channel", () => {
        const problem = deriveChartOption(block({ x: "log2FoldChange" }), ROWS, undefined, {}, OPTS)._unsafeUnwrapErr();
        expect(problem.detail).toBe('The volcano chart needs a column for the "y" channel.');
    });

    it("draws a gene whose stored p is 0 at the top of the p axis as an upward triangle, counts it, and names it", () => {
        const rows: ChartRow[] = [...ROWS, { gene_symbol: "Zero1", log2FoldChange: -2.5, padj: 0 }, { gene_symbol: "Zero2", log2FoldChange: 0.3, padj: "0" }];
        const option = derive(block(), rows);
        const series = seriesOf(option);
        // A stored zero states a p under the resolution of the test, thus each one draws and counts on its side.
        expect(series.slice(0, 3).map((entry) => entry.name)).toEqual(["Down (10)", "Up (4)", "Not significant (5)"]);
        const triangles = series.filter((entry) => entry.symbol === BELOW_RESOLUTION_SYMBOL);
        expect(BELOW_RESOLUTION_SYMBOL).toBe("triangle");
        expect(triangles.map((entry) => entry.name)).toEqual(["Down (10)", "Not significant (5)"]);
        // The largest finite transformed p of the table is the top of the plotted range.
        const top = -Math.log10(1.7e-159);
        expect(triangles[0].data).toEqual([{ name: "Zero1", value: [-2.5, top] }]);
        expect(triangles[0].itemStyle).toEqual(series[0].itemStyle);
        expect(triangles[1].data).toEqual([{ name: "Zero2", value: [0.3, top] }]);
        // The legend names the three sides alone.
        expect(((option.legend as EchartOption).data as EchartOption[]).map((entry) => entry.name)).toEqual(["Down (10)", "Up (4)", "Not significant (5)"]);
        // The zero is the most significant p, thus its gene takes the first name.
        const names = series.find((entry) => entry.name === POINT_NAMES) as EchartOption;
        expect((names.data as EchartOption[]).map((item) => item.name)).toEqual([
            "Zero1",
            "Kal1",
            "Ant2",
            "Hml",
            "sesB",
            "CG3770",
            "Oadh",
            "gas",
            "sv2",
            "Ama",
        ]);
    });

    it("draws a stored zero one unit over the significance line where no finite p passes the line", () => {
        const rows: ChartRow[] = [
            { gene_symbol: "a", log2FoldChange: 2, padj: 0.5 },
            { gene_symbol: "z", log2FoldChange: 2, padj: 0 },
        ];
        const triangles = seriesOf(derive(block(), rows)).filter((entry) => entry.symbol === BELOW_RESOLUTION_SYMBOL);
        expect(triangles.map((entry) => entry.name)).toEqual(["Up (1)"]);
        expect(triangles[0].data).toEqual([{ name: "z", value: [2, -Math.log10(VOLCANO_P_THRESHOLD) + 1] }]);
    });

    it("derives the same bytes two times", () => {
        expect(JSON.stringify(derive())).toBe(JSON.stringify(derive()));
    });

    it("plots each coordinate as a number where the table gives its cells as text", () => {
        const text = ROWS.map((row) => Object.fromEntries(Object.entries(row).map(([key, cell]) => [key, String(cell)])));
        const points = seriesOf(derive(block(), text))
            .slice(0, 3)
            .flatMap((series) => series.data as unknown[]);
        const pairs = points.map((item) => (Array.isArray(item) ? item : (item as EchartOption).value) as unknown[]);
        expect(pairs.length).toBe(17);
        expect(pairs.every((pair) => typeof pair[0] === "number" && typeof pair[1] === "number")).toBe(true);
        expect(pairs).toContainEqual([-4.619, -Math.log10(1.7e-159)]);
    });
});

describe("the volcano names at each size", () => {
    const option = derive();
    const x = option.xAxis as EchartOption;
    const peak = Math.max(...ROWS.flatMap((row) => (row.padj === "" || !(Number(row.padj) > 0) ? [] : [-Math.log10(Number(row.padj))])));
    const plot = { x: { min: x.min as number, max: x.max as number }, y: { min: 0, max: niceCeiling(peak) } };

    /** The page option, and the export option of each export size, with the frame where its names place. */
    const renders: Array<readonly [string, EchartOption, NameFrame]> = [
        ["page", option, PAGE_PLOT_FRAME],
        ...Object.entries(CHART_EXPORT_SIZES).map(
            ([kind, size]) =>
                [kind, exportOption(option, size.textPx, size.widthPx, size.heightPx), EXPORT_PLOT_FRAMES[kind as keyof typeof CHART_EXPORT_SIZES]] as const,
        ),
    ];

    for (const [kind, render, frame] of renders) {
        it(`prints no name over another name at the ${kind} size`, () => {
            const items = (seriesOf(render).find((entry) => entry.name === POINT_NAMES)?.data ?? []) as EchartOption[];
            expect(items.length).toBeGreaterThan(0);
            const boxes = items.map((item) => {
                const [nameX, nameY] = item.value as number[];
                const placed: LeaderName = { x: nameX, y: nameY, side: (item.label as EchartOption).position as LeaderName["side"] };
                return leaderNameBox(placed, String(item.name), plot, frame);
            });
            for (const [index, box] of boxes.entries()) {
                for (const other of boxes.slice(index + 1)) expect(overlaps(box, other)).toBe(false);
            }
        });
    }
});

describe("the dense volcano", () => {
    const COLUMNS = ["gene_symbol", "log2FoldChange", "padj"];
    const target = { key: "de", columns: COLUMNS };

    /** A table of `count` genes: a spread of effects, and p-values from the very small to one. */
    function denseRows(count: number): ChartRow[] {
        const rows: ChartRow[] = [];
        for (let index = 0; index < count; index += 1) {
            rows.push({
                gene_symbol: `G${index}`,
                log2FoldChange: ((index % 800) - 400) / 100,
                padj: index % 97 === 0 ? "" : Math.pow(10, -((index * 7) % 30)),
            });
        }
        return rows;
    }

    const seriesDataOnThePage = new Function(`${CHART_SERIES_BUILDER}\nreturn reportSeriesData;`)() as (
        payload: { columns: string[]; rows: ChartRow[] },
        source: ChartDataSource["series"][number],
        rule: unknown,
    ) => unknown[];

    it("reads the payload past the bound, and the page builds the points and the labels of the inline form", () => {
        const rows = denseRows(9000);
        const render = deriveChartRender(block(), rows, COLUMNS, target, {}, OPTS)._unsafeUnwrap();
        expect(JSON.stringify(render.inline).length).toBeGreaterThan(CHART_INLINE_OPTION_BOUND);
        expect(render.readsPayload).toBe(true);
        const source = render.option[CHART_SOURCE_MEMBER] as ChartDataSource;
        expect(source.series.map((entry) => entry.category)).toEqual([0, 1, 2]);
        // The style of each layer rides the page option, thus the page draws the same layers.
        expect(seriesOf(render.option).map((series) => series.z)).toEqual(seriesOf(render.inline).map((series) => series.z));
        for (const [index, entry] of source.series.entries()) {
            const page = seriesDataOnThePage({ columns: COLUMNS, rows }, entry, source.rule);
            expect(JSON.stringify(page)).toBe(JSON.stringify(seriesOf(render.inline)[index].data));
        }
        // The names ride the page option after the points, thus the page draws them over the payload points.
        expect(source.series.flatMap((entry) => entry.flags ?? [])).toEqual([]);
        const names = seriesOf(render.option).at(-1) as EchartOption;
        expect(names).toEqual(seriesOf(render.inline).at(-1) as EchartOption);
        // The ten most significant genes of this table share one p row across the plot, thus the names that find
        // no place clear of the earlier names draw nothing.
        expect(names.name).toBe(POINT_NAMES);
        expect((names.data as unknown[]).length).toBeGreaterThan(0);
        expect((names.data as unknown[]).length).toBeLessThanOrEqual(VOLCANO_LABEL_COUNT);
    });

    it("builds numbers on the page from a payload of text cells, as the server does", () => {
        const rows = denseRows(9000).map((row) => ({ ...row, log2FoldChange: String(row.log2FoldChange), padj: String(row.padj) }));
        const render = deriveChartRender(block(), rows, COLUMNS, target, {}, OPTS)._unsafeUnwrap();
        const source = render.option[CHART_SOURCE_MEMBER] as ChartDataSource;
        for (const [index, entry] of source.series.entries()) {
            const page = seriesDataOnThePage({ columns: COLUMNS, rows }, entry, source.rule);
            expect(JSON.stringify(page)).toBe(JSON.stringify(seriesOf(render.inline)[index].data));
            const pairs = (page as unknown[]).map((item) => (Array.isArray(item) ? item : (item as EchartOption).value) as unknown[]);
            expect(pairs.length).toBeGreaterThan(0);
            expect(pairs.every((pair) => typeof pair[0] === "number")).toBe(true);
        }
    });
});
