/**
 * The dot plot over excerpts of the PBMC 3k marker table and the pasilla GO enrichment table.
 */

import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import { deriveChartOption, deriveChartRender, type ChartRow, type EchartOption } from "../chart.js";
import { CHART_BODY_PX, CHART_INLINE_OPTION_BOUND, SEQUENTIAL_RAMP } from "../design.js";
import { DOTPLOT_LINE_PX, DOTPLOT_ROW_GAP_PX, wrappedTerm } from "./dotplot.js";

type Encoding = NonNullable<ChartBlock["encoding"]>;

const HASH = `sha256:${"d".repeat(64)}`;

function block(encoding: Encoding, labels?: Record<string, string>): ChartBlock {
    return {
        kind: "chart",
        id: "d1",
        binding: { kind: "artifact-table", path: "dots.csv", hash: HASH, ...(labels !== undefined ? { columnLabels: labels } : {}) },
        chartType: "dotplot",
        encoding,
    };
}

function asObj(value: unknown): EchartOption {
    return value as EchartOption;
}

/** Three clusters and three markers of the PBMC 3k dot plot table. */
const MARKERS: ChartRow[] = [
    { cluster: "CD4 T", gene: "IL7R", fraction_expressing: 0.6617132867132867, mean_expression_scaled: 1.0 },
    { cluster: "CD14 Monocytes", gene: "IL7R", fraction_expressing: 0.11666666666666667, mean_expression_scaled: 0.0 },
    { cluster: "B", gene: "IL7R", fraction_expressing: 0.11403508771929824, mean_expression_scaled: 0.0056627314 },
    { cluster: "CD4 T", gene: "LYZ", fraction_expressing: 0.5026223776223776, mean_expression_scaled: 0.023838433 },
    { cluster: "CD14 Monocytes", gene: "LYZ", fraction_expressing: 1.0, mean_expression_scaled: 0.90015465 },
    { cluster: "B", gene: "LYZ", fraction_expressing: 0.4298245614035088, mean_expression_scaled: 0.010889162 },
    { cluster: "CD4 T", gene: "MS4A1", fraction_expressing: 0.0472027972027972, mean_expression_scaled: 0.0 },
    { cluster: "CD14 Monocytes", gene: "MS4A1", fraction_expressing: 0.052083333333333336, mean_expression_scaled: 0.0024182585 },
    { cluster: "B", gene: "MS4A1", fraction_expressing: 0.8596491228070176, mean_expression_scaled: 1.0 },
];

const MARKER_LABELS = { fraction_expressing: "Fraction of cells", mean_expression_scaled: "Scaled mean expression" };

describe("the marker dot plot", () => {
    const option = deriveChartOption(
        block({ x: "gene", y: "cluster", size: "fraction_expressing", color: "mean_expression_scaled" }, MARKER_LABELS),
        MARKERS,
    )._unsafeUnwrap();

    it("lists the clusters top-down and the genes along x", () => {
        expect(asObj(option.yAxis)).toEqual(expect.objectContaining({ type: "category", inverse: true, data: ["CD4 T", "CD14 Monocytes", "B"] }));
        expect(asObj(option.yAxis).name).toBeUndefined();
        expect(asObj(option.xAxis)).toEqual(expect.objectContaining({ type: "category", data: ["IL7R", "LYZ", "MS4A1"] }));
        // Each dot names its cluster by its place on the y axis.
        expect(((option.series as EchartOption[])[0].data as unknown[][])[1]).toEqual(["IL7R", 1, 0.0, 0.11666666666666667]);
    });

    it("colors on the sequential ramp and prints the two ends with the number helper", () => {
        const color = (option.visualMap as EchartOption[]).find((map) => map.show !== false);
        expect(color).toEqual(expect.objectContaining({ dimension: 2, min: 0, max: 1, calculable: false, inRange: { color: [...SEQUENTIAL_RAMP] } }));
        expect(color?.text).toEqual(["Scaled mean expression\n1", "0"]);
    });

    it("keys the size with three reference circles and their values", () => {
        const legend = (option.graphic as EchartOption[])[0];
        const children = legend.children as EchartOption[];
        expect(asObj(children[0].style).text).toBe("Fraction of cells");
        expect(children.filter((child) => child.type === "circle").length).toBe(3);
        const texts = children.filter((child) => child.type === "text").map((child) => asObj(child.style).text);
        expect(texts.slice(1)).toEqual(["0.0472", "0.524", "1"]);
        expect(option.legend).toEqual({ show: false });
    });
});

/** The first GO terms of the pasilla enrichment table. */
const TERMS: ChartRow[] = [
    { term: "septate junction assembly (GO:0019991)", overlap: 15, gene_ratio: 0.018050541516245487, padj: 7.745821839072878e-5 },
    { term: "cell-cell junction assembly (GO:0007043)", overlap: 17, gene_ratio: 0.02045728038507822, padj: 0.00010889884366442738 },
    { term: "apical junction assembly (GO:0043297)", overlap: 16, gene_ratio: 0.019253910950661854, padj: 0.00010889884366442738 },
];

describe("the enrichment dot plot", () => {
    const option = deriveChartOption(
        block(
            {
                y: { column: "term", orderBy: "gene_ratio", order: "desc" },
                x: "gene_ratio",
                size: "overlap",
                color: { column: "padj", transform: "neg_log10" },
            },
            { gene_ratio: "Gene ratio", overlap: "Count", padj: "adjusted p" },
        ),
        TERMS,
    )._unsafeUnwrap();

    it("orders the terms by the ratio, from the largest down, and wraps a long term at its spaces", () => {
        expect(asObj(option.yAxis).data).toEqual([
            "cell-cell junction assembly\n(GO:0007043)",
            "apical junction assembly\n(GO:0043297)",
            "septate junction assembly\n(GO:0019991)",
        ]);
        expect(asObj(asObj(option.yAxis).axisLabel)).toEqual(expect.objectContaining({ lineHeight: DOTPLOT_LINE_PX }));
        expect(asObj(option.xAxis)).toEqual(expect.objectContaining({ type: "value", name: "Gene ratio" }));
    });

    it("titles a transformed color with its transform, and prints its ends as plain numbers", () => {
        const color = (option.visualMap as EchartOption[]).find((map) => map.show !== false);
        expect(asObj(color).text).toEqual(["−log10(adjusted p)\n4.11", "3.96"]);
    });

    it("refuses a dot plot with neither a size nor a color", () => {
        expect(deriveChartOption(block({ x: "gene_ratio", y: "term" }), TERMS)._unsafeUnwrapErr().detail).toBe(
            'The dotplot sizes its dots by a "size" channel and colors them by a "color" channel. Name one of the two at least.',
        );
    });

    it("refuses a term order whose rows disagree", () => {
        const rows: ChartRow[] = [...TERMS, { term: TERMS[0].term, overlap: 3, gene_ratio: 0.5, padj: 0.01 }];
        expect(
            deriveChartOption(block({ y: { column: "term", orderBy: "gene_ratio" }, x: "gene_ratio", size: "overlap" }), rows)._unsafeUnwrapErr().detail,
        ).toBe('The category "septate junction assembly (GO:0019991)" holds two values in the "gene_ratio" column, thus it has no one place in the order.');
    });
});

describe("the terms of a dot plot", () => {
    it("keeps a term of two lines at most, and ends a longer term with an ellipsis", () => {
        expect(wrappedTerm("regulation of intracellular signal transduction pathway of the embryonic tracheal system (GO:1902531)")).toBe(
            "regulation of intracellular\nsignal transduction pathway…",
        );
        expect(wrappedTerm("dorsal closure (GO:0007391)")).toBe("dorsal closure (GO:0007391)");
    });

    it("keeps the grid of the terms in the default bounds, where the runtime moves the title off the labels", () => {
        const option = deriveChartOption(block({ y: "term", x: "gene_ratio", size: "overlap" }, { term: "GO biological process" }), TERMS)._unsafeUnwrap();
        const axis = asObj(option.yAxis);
        expect(axis.name).toBe("GO biological process");
        // The grid holds its labels and its titles as the runtime does by default, thus the runtime moves the title.
        expect(asObj(option.grid).containLabel).toBeUndefined();
        expect(asObj(option.grid).outerBoundsMode).toBeUndefined();
    });

    it("keeps the rows of a dense dot plot inline, thus the page draws the wrapped terms of the export", () => {
        const rows: ChartRow[] = Array.from({ length: 3000 }, (_row, index) => ({
            term: `establishment of glial blood-brain barrier ${index} (GO:${String(index).padStart(7, "0")})`,
            overlap: (index % 40) + 1,
            gene_ratio: 0.01 + index / 100000,
            padj: 1e-8 * (index + 1),
        }));
        const columns = ["term", "overlap", "gene_ratio", "padj"];
        const render = deriveChartRender(block({ y: "term", x: "gene_ratio", size: "overlap", color: "padj" }), rows, columns, {
            key: "d1",
            columns,
        })._unsafeUnwrap();
        expect(JSON.stringify(render.inline).length).toBeGreaterThan(CHART_INLINE_OPTION_BOUND);
        expect(render.readsPayload).toBe(false);
        expect(render.option).toEqual(render.inline);
    });

    it("grows the body where the terms of two lines need more height than the default body gives", () => {
        const rows: ChartRow[] = Array.from({ length: 17 }, (_row, index) => ({
            term: `establishment of glial blood-brain barrier ${index} (GO:00608${index})`,
            overlap: index + 1,
            gene_ratio: 0.01 + index / 1000,
        }));
        const render = deriveChartRender(block({ y: "term", x: "gene_ratio", size: "overlap" }), rows, undefined, { key: "d1", columns: [] })._unsafeUnwrap();
        expect(render.bodyPx).toBeGreaterThan(CHART_BODY_PX);
        // The plot takes at most two thirds of the body, and each term takes two lines and a gap.
        expect((render.bodyPx * 2) / 3 / 17).toBeGreaterThanOrEqual(2 * DOTPLOT_LINE_PX + DOTPLOT_ROW_GAP_PX);
        const small = deriveChartRender(block({ y: "term", x: "gene_ratio", size: "overlap" }), TERMS, undefined, { key: "d1", columns: [] })._unsafeUnwrap();
        expect(small.bodyPx).toBe(CHART_BODY_PX);
    });
});
