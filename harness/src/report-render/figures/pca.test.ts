/**
 * The PCA of samples and the shape draw of the plain scatter, over the pasilla sample scores.
 */

import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import { deriveChartOption, deriveChartRender, type ChartRow, type EchartOption } from "../chart.js";
import { CHART_BODY_PX, CHART_EXPORT_SIZES, CHART_INK, CHART_PAGE_TEXT_PX, CHART_PALETTE } from "../design.js";
import { equalRanges, squareLayout } from "./equal-units.js";
import { PCA_LABEL_ROWS, SHAPE_SYMBOLS } from "./pca.js";

type Encoding = NonNullable<ChartBlock["encoding"]>;
type ChartType = NonNullable<ChartBlock["chartType"]>;

const HASH = `sha256:${"b".repeat(64)}`;

/** The seven pasilla samples on the first two components, as the gallery table states them. */
const PASILLA: ChartRow[] = [
    { sample: "untreated1", PC1: -8.978605974576894, PC2: 6.685283245803048, condition: "untreated", type: "single-read" },
    { sample: "untreated2", PC1: -8.823358862929963, PC2: 4.143778456415055, condition: "untreated", type: "single-read" },
    { sample: "untreated3", PC1: -6.578490892796153, PC2: -7.2792652681615895, condition: "untreated", type: "paired-end" },
    { sample: "untreated4", PC1: -6.420636480930606, PC2: -6.712864214224127, condition: "untreated", type: "paired-end" },
    { sample: "treated1", PC1: 8.402747527741983, PC2: 10.65087457758926, condition: "treated", type: "single-read" },
    { sample: "treated2", PC1: 11.179870924895017, PC2: -2.7013914496299383, condition: "treated", type: "paired-end" },
    { sample: "treated3", PC1: 11.218473758596618, PC2: -4.786415347791723, condition: "treated", type: "paired-end" },
];

const LABELS = { PC1: "PC1: 56.5% variance", PC2: "PC2: 30.4% variance" };

function block(chartType: ChartType, encoding: Encoding, extra: Partial<ChartBlock> = {}): ChartBlock {
    return { kind: "chart", id: "p1", binding: { kind: "artifact-table", path: "pca.csv", hash: HASH, columnLabels: LABELS }, chartType, encoding, ...extra };
}

const PCA_ENCODING: Encoding = { x: "PC1", y: "PC2", group: "condition", shape: "type", label: "sample" };

function seriesOf(option: EchartOption): EchartOption[] {
    return option.series as EchartOption[];
}

function asObj(value: unknown): EchartOption {
    return value as EchartOption;
}

describe("the pca figure", () => {
    const option = deriveChartOption(block("pca", PCA_ENCODING), PASILLA)._unsafeUnwrap();

    it("gives the two axes one length of data and one tick step, on a square grid", () => {
        const xAxis = asObj(option.xAxis);
        const yAxis = asObj(option.yAxis);
        expect([xAxis.min, xAxis.max, yAxis.min, yAxis.max]).toEqual([-10, 15, -10, 15]);
        expect(xAxis.interval).toBe(yAxis.interval);
        const grid = (option.grid as EchartOption[])[0];
        expect(grid.width).toBe(grid.height);
        expect(typeof grid.width).toBe("number");
        // Each media rule states a square, and a larger container takes a larger square. The rules of the
        // export sizes follow the rules of the page.
        const media = option.media as EchartOption[];
        const sides = media.map((rule) => asObj((asObj(rule.option).grid as EchartOption[])[0]));
        expect(sides.every((entry) => entry.width === entry.height)).toBe(true);
        const page = sides.filter((_entry, index) => asObj(media[index].query).maxWidth === undefined);
        expect(page.map((entry) => entry.width)).toEqual([...page.map((entry) => entry.width as number)].sort((a, b) => a - b));
        expect(asObj((option.media as EchartOption[])[0]).query).toEqual({ minWidth: 0 });
    });

    it("titles each axis with the declared label, which carries the variance", () => {
        expect(asObj(option.xAxis).name).toBe("PC1: 56.5% variance");
        expect(asObj(option.yAxis).name).toBe("PC2: 30.4% variance");
        expect(asObj(option.yAxis).nameRotate).toBe(90);
    });

    it("colors by the group and sets the symbol by the shape, one series for each pair", () => {
        const drawn = seriesOf(option).filter((entry) => Array.isArray(entry.data) && (entry.data as unknown[]).length > 0);
        expect(drawn.map((entry) => [entry.name, entry.symbol, asObj(entry.itemStyle).color])).toEqual([
            ["untreated", SHAPE_SYMBOLS[0], CHART_PALETTE[0]],
            ["untreated", SHAPE_SYMBOLS[1], CHART_PALETTE[0]],
            ["treated", SHAPE_SYMBOLS[0], CHART_PALETTE[1]],
            ["treated", SHAPE_SYMBOLS[1], CHART_PALETTE[1]],
        ]);
    });

    it("keys each group with a circle and each shape with its symbol in the ink", () => {
        expect(asObj(option.legend).data).toEqual([
            { name: "untreated", icon: "circle" },
            { name: "treated", icon: "circle" },
            { name: "single-read", icon: SHAPE_SYMBOLS[0] },
            { name: "paired-end", icon: SHAPE_SYMBOLS[1] },
        ]);
        const keys = seriesOf(option).filter((entry) => Array.isArray(entry.data) && (entry.data as unknown[]).length === 0);
        expect(keys.map((entry) => [entry.name, asObj(entry.itemStyle).color])).toEqual([
            ["single-read", CHART_INK],
            ["paired-end", CHART_INK],
        ]);
    });

    it("names each point of a small table, and moves a name off its close neighbor", () => {
        const items = seriesOf(option).flatMap((entry) => (entry.data as EchartOption[]).map((item) => ({ item, labeled: asObj(entry.label).show === true })));
        expect(items.every((entry) => entry.labeled)).toBe(true);
        const byName = new Map(items.map((entry) => [entry.item.name, entry.item]));
        // untreated3 and untreated4 lie one sixth of a unit apart. The later name takes a free side.
        expect(byName.get("untreated3")?.label).toBeUndefined();
        expect(asObj(byName.get("untreated4")?.label).position).not.toBe("right");
    });

    it("names no point of a table past the label bound, and keeps the name for the tooltip", () => {
        const rows: ChartRow[] = Array.from({ length: PCA_LABEL_ROWS + 1 }, (_row, index) => ({ sample: `s${index}`, PC1: index, PC2: -index }));
        const large = deriveChartOption(block("pca", { x: "PC1", y: "PC2", label: "sample" }), rows)._unsafeUnwrap();
        const series = seriesOf(large)[0];
        expect(series.label).toBeUndefined();
        expect(asObj((series.data as unknown[])[0]).name).toBe("s0");
    });

    it("refuses a seventh shape, a value shared by a group and a shape, and an order on an axis", () => {
        const many: ChartRow[] = Array.from({ length: 7 }, (_row, index) => ({ PC1: index, PC2: index, batch: `b${index}` }));
        expect(deriveChartOption(block("pca", { x: "PC1", y: "PC2", shape: "batch" }), many)._unsafeUnwrapErr().detail).toBe(
            'The "shape" channel holds 7 categories, and a symbol reads for 6 at most. Draw that column as the "group" channel.',
        );
        const shared: ChartRow[] = [{ PC1: 1, PC2: 2, a: "x", b: "x" }];
        expect(deriveChartOption(block("pca", { x: "PC1", y: "PC2", group: "a", shape: "b" }), shared)._unsafeUnwrapErr().detail).toBe(
            'The value "x" names a group and a shape, thus the legend cannot tell the two keys apart.',
        );
        expect(deriveChartOption(block("pca", { x: { column: "PC1", orderBy: "PC2" }, y: "PC2" }), PASILLA)._unsafeUnwrapErr().detail).toBe(
            'The "x" channel of the pca draws a value axis, thus it takes no "orderBy".',
        );
    });

    it("refuses a component column that holds text", () => {
        const rows: ChartRow[] = [{ PC1: "high", PC2: 1 }];
        expect(deriveChartOption(block("pca", { x: "PC1", y: "PC2" }), rows)._unsafeUnwrapErr().detail).toBe(
            'The column "PC1" holds the text "high", and the pca draws "x" on a value axis.',
        );
    });

    it("refuses a channel that it does not read", () => {
        expect(deriveChartOption(block("pca", { x: "PC1", y: "PC2", color: "PC1" }), PASILLA)._unsafeUnwrapErr().detail).toBe(
            'The pca chart takes no "color" channel.',
        );
    });
});

describe("the shape on a plain scatter", () => {
    it("draws each shape with its symbol on the fitted axes of a scatter, with the legend at the bottom", () => {
        const option = deriveChartOption(block("scatter", PCA_ENCODING), PASILLA)._unsafeUnwrap();
        expect(seriesOf(option).map((entry) => entry.symbol)).toEqual([
            SHAPE_SYMBOLS[0],
            SHAPE_SYMBOLS[1],
            SHAPE_SYMBOLS[0],
            SHAPE_SYMBOLS[1],
            SHAPE_SYMBOLS[0],
            SHAPE_SYMBOLS[1],
        ]);
        expect(asObj(option.xAxis).scale).toBe(true);
        expect(option.media).toBeUndefined();
        expect(asObj(option.legend).bottom).toBe(0);
        // A plain scatter names its points in the tooltip alone.
        expect(seriesOf(option)[0].label).toBeUndefined();
    });

    it("keys the shapes alone where the scatter names no group", () => {
        const option = deriveChartOption(block("scatter", { x: "PC1", y: "PC2", shape: "type" }), PASILLA)._unsafeUnwrap();
        expect(seriesOf(option).map((entry) => entry.name)).toEqual(["single-read", "paired-end"]);
        expect(asObj(option.legend).data).toEqual([
            { name: "single-read", icon: SHAPE_SYMBOLS[0] },
            { name: "paired-end", icon: SHAPE_SYMBOLS[1] },
        ]);
    });

    it("refuses a member that the shape draw does not draw, and names the shape as the cause", () => {
        expect(deriveChartOption(block("scatter", { x: "PC1", y: "PC2", shape: "type", color: "PC1" }), PASILLA)._unsafeUnwrapErr().detail).toBe(
            'A scatter with a "shape" channel draws x, y, group, and label alone, thus it takes no "color" channel beside the shape.',
        );
        expect(
            deriveChartOption(block("scatter", { x: "PC1", y: "PC2", shape: "type", group: "condition" }, { focus: ["treated"] }), PASILLA)._unsafeUnwrapErr()
                .detail,
        ).toBe('A scatter with a "shape" channel draws x, y, group, and label alone, thus it takes no focus beside the shape.');
    });

    it("keeps a dense scatter with a shape inline, because a page-side build draws no symbol", () => {
        const rows: ChartRow[] = Array.from({ length: 6000 }, (_row, index) => ({ PC1: index / 7, PC2: (index % 97) / 3, type: index % 2 === 0 ? "a" : "b" }));
        const render = deriveChartRender(block("scatter", { x: "PC1", y: "PC2", shape: "type" }), rows, ["PC1", "PC2", "type"], {
            key: "p1",
            columns: ["PC1", "PC2", "type"],
        })._unsafeUnwrap();
        expect(render.readsPayload).toBe(false);
        expect(seriesOf(render.option).map((entry) => entry.symbol)).toEqual([SHAPE_SYMBOLS[0], SHAPE_SYMBOLS[1]]);
    });
});

describe("the layout of one unit", () => {
    it("states the width of the square block at the page body, thus the card centers the block", () => {
        const render = deriveChartRender(block("pca", PCA_ENCODING), PASILLA, undefined, { key: "p1", columns: [] })._unsafeUnwrap();
        const rules = (render.option.media as EchartOption[]).filter((rule) => asObj(rule.query).maxWidth === undefined);
        const fitting = rules.filter((rule) => ((asObj(rule.query).minHeight as number | undefined) ?? 0) <= CHART_BODY_PX);
        const chosen = fitting[fitting.length - 1];
        expect(render.bodyPx).toBe(CHART_BODY_PX);
        expect(render.widthPx).toBe(asObj(chosen.query).minWidth as number);
        const grid = (asObj(chosen.option).grid as EchartOption[])[0];
        expect((grid.top as number) + (grid.height as number)).toBeLessThanOrEqual(CHART_BODY_PX);
    });

    it("ends two rounded axes on one step, and grows the shorter axis to the length of the longer", () => {
        const ranges = equalRanges([-9, 11.2], [-7.3, 10.7], { pad: 0.04, round: true });
        expect(ranges).toEqual({ x: { min: -10, max: 15 }, y: { min: -10, max: 15 }, step: 5 });
        const padded = equalRanges([0, 10], [0, 2], { pad: 0, round: false });
        expect(padded).toEqual({ x: { min: 0, max: 10 }, y: { min: -4, max: 6 } });
    });

    it("lays out three squares to a row, and places the band after the last column", () => {
        const layout = squareLayout({ panels: 4, margins: { top: 10, bottom: 10, left: 10, right: 10 }, side: 50, legend: true });
        const grids = layout.grid;
        expect(grids.map((grid) => [grid.left, grid.top])).toEqual([
            [10, 10],
            [146, 10],
            [282, 10],
            [10, 146],
        ]);
        expect(layout.legend).toEqual({ left: 418, top: 10 });
    });

    it("places a bottom legend band under the squares, and the band takes its lines from the entry widths", () => {
        const margins = { top: 10, bottom: 40, left: 50, right: 10 };
        const layout = squareLayout({
            panels: 1,
            margins,
            side: 0,
            legend: true,
            legendBand: { place: "bottom", entries: ["ECOG alone", "ECOG + Karnofsky + age"] },
        });
        const grid = layout.grid[0];
        expect(layout.legend).toEqual({ left: 50, top: 10 + (grid.height as number) + 40, width: grid.width, orient: "horizontal" });
        // The smallest square is 120 pixels, and the two entries take one line each at that width.
        const rule = layout.media[0].option as EchartOption;
        expect((rule.grid as EchartOption[])[0].width as number).toBe(120);
    });

    it("centers the squares and the band at each export size, and keeps each export square the largest that fits", () => {
        const margins = { top: 16, bottom: 56, left: 64, right: 12 };
        const layout = squareLayout({ panels: 1, margins, side: 120, legend: true });
        for (const size of [CHART_EXPORT_SIZES.single, CHART_EXPORT_SIZES.double, CHART_EXPORT_SIZES.slide]) {
            const rule = layout.media.find((entry) => {
                const query = entry.query as EchartOption;
                return (
                    query.minWidth === size.widthPx && query.maxWidth === size.widthPx && query.minHeight === size.heightPx && query.maxHeight === size.heightPx
                );
            });
            expect(rule).toBeDefined();
            const option = rule?.option as EchartOption;
            const grid = (option.grid as EchartOption[])[0];
            const legend = option.legend as EchartOption;
            // The block spans from the left edge of the y labels to the right margin of the band.
            const scale = size.textPx / CHART_PAGE_TEXT_PX;
            const blockLeft = (grid.left as number) - Math.round(margins.left * scale);
            const blockRight = (legend.left as number) + Math.round(120 * scale) + Math.round(margins.right * scale);
            expect(Math.abs(blockLeft - (size.widthPx - blockRight))).toBeLessThanOrEqual(1);
            expect((grid.top as number) + (grid.height as number) + Math.round(margins.bottom * scale)).toBeLessThanOrEqual(size.heightPx);
        }
    });
});
