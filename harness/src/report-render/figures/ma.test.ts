/**
 * The MA figure: the log mean axis, the significant points in blue over the gray null points, the line at
 * zero, and the symmetric effect axis.
 */

import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import { CHART_SOURCE_MEMBER, deriveChartOption, deriveChartRender, type ChartDataSource, type ChartOpts, type ChartRow, type EchartOption } from "../chart.js";
import { CHART_INLINE_OPTION_BOUND, CHART_PALETTE, MUTED_CHART_COLOR } from "../design.js";
import { CHART_SERIES_BUILDER } from "../page.js";
import { DENSE_NULL_Z } from "./dense.js";
import { FIGURE_MODULES } from "./index.js";
import { MA_FIGURE, MA_P_THRESHOLD } from "./ma.js";

type Encoding = NonNullable<ChartBlock["encoding"]>;

const HASH = `sha256:${"c".repeat(64)}`;
const OPTS: ChartOpts = { figures: { ma: MA_FIGURE } };
const ENCODING: Encoding = { x: "baseMean", y: "log2FoldChange", p: "padj", label: "gene_symbol" };

function block(encoding: Encoding = ENCODING, extra: Partial<ChartBlock> = {}): ChartBlock {
    return {
        kind: "chart",
        id: "m1",
        binding: { kind: "artifact-table", path: "bulk_rnaseq/de_results.csv", hash: HASH },
        chartType: "ma",
        encoding,
        ...extra,
    };
}

/**
 * An excerpt of the pasilla table: two strong genes, a gene with no adjusted p, a gene near the cut, a gene
 * with a mean of zero, and two null genes.
 */
const ROWS: ChartRow[] = [
    { gene_symbol: "Kal1", baseMean: 730.6, log2FoldChange: -4.619, padj: 1.7e-159 },
    { gene_symbol: "Ant2", baseMean: 1501.4, log2FoldChange: 2.9, padj: 8.17e-110 },
    { gene_symbol: "a", baseMean: 95.14, log2FoldChange: 0.0023, padj: 0.997 },
    { gene_symbol: "abd-A", baseMean: 1.0565, log2FoldChange: -0.491, padj: "" },
    { gene_symbol: "CG1", baseMean: 0.87, log2FoldChange: 0.3, padj: 0.08 },
    { gene_symbol: "CG2", baseMean: 0, log2FoldChange: 1.2, padj: 0.5 },
    { gene_symbol: "sesB", baseMean: 196242.6, log2FoldChange: 0.1, padj: 0.2 },
];

function derive(chartBlock: ChartBlock = block(), rows: readonly ChartRow[] = ROWS): EchartOption {
    return deriveChartOption(chartBlock, rows, undefined, {}, OPTS)._unsafeUnwrap();
}

function seriesOf(option: EchartOption): EchartOption[] {
    return option.series as EchartOption[];
}

function names(series: EchartOption): string[] {
    return (series.data as EchartOption[]).map((item) => String(item.name));
}

describe("the MA figure", () => {
    it("registers in the figure registry", () => {
        expect(FIGURE_MODULES.ma).toBe(MA_FIGURE);
    });

    it("draws the mean on a log axis that ends at the decades around the positive means", () => {
        const x = derive().xAxis as EchartOption;
        expect(x.type).toBe("log");
        expect(x.min).toBe(0.1);
        expect(x.max).toBe(1e6);
    });

    it("draws the significant points in blue over the gray null points, split by the p column at the default cut", () => {
        const [significant, rest] = seriesOf(derive());
        expect(MA_P_THRESHOLD).toBe(0.1);
        expect(significant.name).toBe("padj < 0.1");
        expect(rest.name).toBe("Not significant");
        expect(significant.itemStyle).toEqual({ color: CHART_PALETTE[0], opacity: expect.any(Number) });
        expect(rest.itemStyle).toEqual({ color: MUTED_CHART_COLOR, opacity: expect.any(Number) });
        expect(rest.z).toBe(DENSE_NULL_Z);
        expect(names(significant)).toEqual(["Kal1", "Ant2", "CG1"]);
        // A gene with no adjusted p draws gray, as DESeq2 draws it. A mean of zero has no place on a log axis.
        expect(names(rest)).toEqual(["a", "abd-A", "sesB"]);
    });

    it("draws a line at zero, and the effect axis symmetric around zero", () => {
        const option = derive();
        const lines = seriesOf(option).flatMap((series) => ((series.markLine as EchartOption | undefined)?.data as EchartOption[] | undefined) ?? []);
        expect(lines).toEqual([{ yAxis: 0, label: { show: false } }]);
        const y = option.yAxis as EchartOption;
        expect(y.min).toBe(-5);
        expect(y.max).toBe(5);
    });

    it("moves the split with a declared significance cut", () => {
        const [significant, rest] = seriesOf(derive(block(ENCODING, { thresholds: { significance: 0.05 } })));
        expect(significant.name).toBe("padj < 0.05");
        expect(names(significant)).toEqual(["Kal1", "Ant2"]);
        expect(names(rest)).toEqual(["a", "abd-A", "CG1", "sesB"]);
    });

    it("refuses an effect cut, because the figure splits its rows by the p column alone", () => {
        const problem = deriveChartOption(block(ENCODING, { thresholds: { significance: 0.05, effect: 1 } }), ROWS, undefined, {}, OPTS)._unsafeUnwrapErr();
        expect(problem.detail).toBe("The ma chart reads the significance cut alone. Omit the effect cut.");
    });

    it("refuses a transform on the mean, because the figure draws the mean on a log axis", () => {
        const problem = deriveChartOption(block({ ...ENCODING, x: { column: "baseMean", transform: "log10" } }), ROWS, undefined, {}, OPTS)._unsafeUnwrapErr();
        expect(problem.detail).toBe('The ma figure draws the "x" channel on a log axis, thus it takes no transform.');
    });

    it("draws one series in the palette when the block names no p column", () => {
        const series = seriesOf(derive(block({ x: "baseMean", y: "log2FoldChange" })));
        expect(series.length).toBe(1);
        expect(series[0].name).toBe("log2FoldChange");
    });

    it("derives the same bytes two times", () => {
        expect(JSON.stringify(derive())).toBe(JSON.stringify(derive()));
    });
});

describe("the dense MA plot", () => {
    const COLUMNS = ["gene_symbol", "baseMean", "log2FoldChange", "padj"];

    function denseRows(count: number): ChartRow[] {
        const rows: ChartRow[] = [];
        for (let index = 0; index < count; index += 1) {
            rows.push({
                gene_symbol: `G${index}`,
                baseMean: index % 211 === 0 ? 0 : Math.pow(10, (index % 50) / 10),
                log2FoldChange: ((index % 600) - 300) / 100,
                padj: index % 13 === 0 ? "" : ((index * 37) % 1000) / 1000,
            });
        }
        return rows;
    }

    const seriesDataOnThePage = new Function(`${CHART_SERIES_BUILDER}\nreturn reportSeriesData;`)() as (
        payload: { columns: string[]; rows: ChartRow[] },
        source: ChartDataSource["series"][number],
        rule: unknown,
    ) => unknown[];

    it("reads the payload past the bound, and the page splits the rows by the p column as the server does", () => {
        const rows = denseRows(9000);
        const render = deriveChartRender(block(), rows, COLUMNS, { key: "de", columns: COLUMNS }, {}, OPTS)._unsafeUnwrap();
        expect(JSON.stringify(render.inline).length).toBeGreaterThan(CHART_INLINE_OPTION_BOUND);
        expect(render.readsPayload).toBe(true);
        const source = render.option[CHART_SOURCE_MEMBER] as ChartDataSource;
        expect(source.rule).toEqual({ kind: "ma", column: "padj", cut: MA_P_THRESHOLD });
        for (const [index, entry] of source.series.entries()) {
            const page = seriesDataOnThePage({ columns: COLUMNS, rows }, entry, source.rule);
            expect(JSON.stringify(page)).toBe(JSON.stringify(seriesOf(render.inline)[index].data));
        }
    });

    it("keeps the chart inline when the payload holds no p column", () => {
        const rows = denseRows(9000);
        const columns = ["gene_symbol", "baseMean", "log2FoldChange"];
        const render = deriveChartRender(block(), rows, COLUMNS, { key: "de", columns }, {}, OPTS)._unsafeUnwrap();
        expect(render.readsPayload).toBe(false);
    });
});
