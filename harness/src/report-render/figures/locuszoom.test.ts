/**
 * The regional association plot: the points in the five LD bins and the gray of a missing r², the lead variant
 * as a purple diamond, the recombination line on the right axis, the genome-wide line, the position axis in
 * megabases, and the genes in lanes under the plot. The rows are an excerpt of the FTO locus of the BMI GWAS of
 * the GIANT consortium.
 */

import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import {
    CHART_SOURCE_MEMBER,
    deriveChartOption,
    deriveChartRender,
    type ChartDataSource,
    type ChartInputs,
    type ChartOpts,
    type ChartRow,
    type EchartOption,
} from "../chart.js";
import { CHART_RENDERERS_SOURCE, exportOption } from "../chart-renderers.js";
import { CHART_BODY_MAX_PX, CHART_EXPORT_SIZES, CHART_INLINE_OPTION_BOUND } from "../design.js";
import { CHART_SERIES_BUILDER } from "../page.js";
import type { ArtifactTableReference } from "../../contracts/report-reference.js";
import { BELOW_RESOLUTION_SYMBOL } from "./dense.js";
import { FIGURE_MODULES } from "./index.js";
import {
    GENE_NAMES,
    GUIDE_LABEL,
    LD_BINS,
    LD_MISSING_COLOR,
    LD_MISSING_NAME,
    LEAD_VARIANT_COLOR,
    LEAD_VARIANT_NAME,
    LOCUSZOOM_FIGURE,
    POSITION_TICKS,
    RECOMBINATION_COLOR,
    RECOMBINATION_NAME,
} from "./locuszoom.js";

type Encoding = NonNullable<ChartBlock["encoding"]>;

const HASH = `sha256:${"f".repeat(64)}`;
const OPTS: ChartOpts = { figures: { locuszoom: LOCUSZOOM_FIGURE } };
const ENCODING: Encoding = { x: "position", y: "pvalue", color: "r2", label: "variant", metric: "recomb_rate", group: "chrom" };

const TRACK: NonNullable<ChartBlock["track"]> = {
    binding: { kind: "artifact-table", path: "gwas/locus_fto_genes.csv", hash: HASH },
    start: "start",
    end: "end",
    label: "gene",
};

function locuszoom(encoding: Encoding = ENCODING, extra: Partial<ChartBlock> = { track: TRACK }, labels?: ArtifactTableReference["columnLabels"]): ChartBlock {
    return {
        kind: "chart",
        id: "lz",
        binding: { kind: "artifact-table", path: "gwas/locus_fto.csv", hash: HASH, ...(labels !== undefined ? { columnLabels: labels } : {}) },
        chartType: "locuszoom",
        encoding,
        ...extra,
    };
}

/**
 * The FTO locus on chromosome 16: the lead variant rs1558902, variants in each LD bin, one variant with no r²,
 * and one variant with no p. The positions are out of order, as a merged table can hold them.
 */
const ROWS: ChartRow[] = [
    { chrom: "16", variant: "rs9939609", position: "53820527", pvalue: "1.2e-120", r2: "0.93", recomb_rate: "0.4" },
    { chrom: "16", variant: "rs1558902", position: "53803574", pvalue: "7.5e-153", r2: "1", recomb_rate: "0.2" },
    { chrom: "16", variant: "rs62033400", position: "53797000", pvalue: "3e-80", r2: "0.7", recomb_rate: "0.1" },
    { chrom: "16", variant: "rs17817449", position: "53750000", pvalue: "2e-40", r2: "0.5", recomb_rate: "12.5" },
    { chrom: "16", variant: "rs8050136", position: "53900000", pvalue: "1e-9", r2: "0.3", recomb_rate: "3" },
    { chrom: "16", variant: "rs1421085", position: "53650000", pvalue: "0.02", r2: "0.05", recomb_rate: "31" },
    { chrom: "16", variant: "rs7185735", position: "54010000", pvalue: "0.4", r2: "", recomb_rate: "1" },
    { chrom: "16", variant: "rs16952517", position: "54080000", pvalue: "", r2: "0.1", recomb_rate: "0.5" },
];

/** The genes of the window: two that overlap and one far from them, one past each end of the window. */
const GENES: ChartRow[] = [
    { gene: "FTO", start: 53737875, end: 54155853, strand: "+" },
    { gene: "RPGRIP1L", start: 53632965, end: 53737874, strand: "-" },
    { gene: "AKTIP", start: 53525561, end: 53537616, strand: "-" },
    { gene: "IRX3", start: 54317189, end: 54320675, strand: "-" },
    { gene: "MIR1972", start: 53640000, end: 53700000, strand: "+" },
];

const INPUTS: ChartInputs = { track: { rows: GENES, columns: ["gene", "start", "end", "strand"] } };

function derive(chartBlock: ChartBlock = locuszoom(), rows: readonly ChartRow[] = ROWS, inputs: ChartInputs = INPUTS): EchartOption {
    return deriveChartOption(chartBlock, rows, undefined, inputs, OPTS)._unsafeUnwrap();
}

function refusal(chartBlock: ChartBlock, rows: readonly ChartRow[] = ROWS, inputs: ChartInputs = INPUTS): string {
    return deriveChartOption(chartBlock, rows, undefined, inputs, OPTS)._unsafeUnwrapErr().detail;
}

function seriesOf(option: EchartOption): EchartOption[] {
    return option.series as EchartOption[];
}

function named(option: EchartOption, name: string): EchartOption {
    const found = seriesOf(option).find((entry) => entry.name === name);
    if (found === undefined) throw new Error(`no series "${name}"`);
    return found;
}

function axes(option: EchartOption, key: "xAxis" | "yAxis"): EchartOption[] {
    const value = option[key];
    return Array.isArray(value) ? (value as EchartOption[]) : [value as EchartOption];
}

/** The pair of each item of one series, whether the item is a bare pair or an object. */
function pairs(series: EchartOption): number[][] {
    return (series.data as unknown[]).map((item) => (Array.isArray(item) ? item : ((item as EchartOption).value as number[])) as number[]);
}

describe("the regional association plot", () => {
    it("registers in the figure registry", () => {
        expect(FIGURE_MODULES.locuszoom).toBe(LOCUSZOOM_FIGURE);
    });

    it("colors each point by the five LD bins of LocusZoom, and states the bins in one legend", () => {
        const option = derive();
        const points = seriesOf(option)[0];
        // The composition carries the r² as the third member of each item, thus the bins read it.
        expect(pairs(points).map((pair) => pair[2])).toEqual(expect.arrayContaining([0.93, 1, 0.7, 0.5, 0.3, 0.05]));
        expect(pairs(points).length).toBe(6);
        expect(LD_BINS.map((bin) => [bin.low, bin.high, bin.color])).toEqual([
            [0, 0.2, "#000080"],
            [0.2, 0.4, "#87cefa"],
            [0.4, 0.6, "#00a000"],
            [0.6, 0.8, "#ffa500"],
            [0.8, 1, "#ff0000"],
        ]);
        const maps = option.visualMap as EchartOption[];
        expect(maps.length).toBe(1);
        const map = maps[0];
        expect(map.type).toBe("piecewise");
        expect(map.dimension).toBe(2);
        expect(map.seriesIndex).toEqual([0]);
        expect(map.selectedMode).toBe(false);
        const pieces = map.pieces as EchartOption[];
        // The highest bin closes at 1, and each other bin holds its lower end alone.
        expect(pieces.slice(0, 5)).toEqual([
            { gte: 0.8, lte: 1, label: "0.8–1", color: "#ff0000" },
            { gte: 0.6, lt: 0.8, label: "0.6–0.8", color: "#ffa500" },
            { gte: 0.4, lt: 0.6, label: "0.4–0.6", color: "#00a000" },
            { gte: 0.2, lt: 0.4, label: "0.2–0.4", color: "#87cefa" },
            { gte: 0, lt: 0.2, label: "0–0.2", color: "#000080" },
        ]);
        // The gray entry names the points of no r², which draw in a series of their own.
        expect(pieces[5]).toMatchObject({ label: LD_MISSING_NAME, color: LD_MISSING_COLOR });
        expect(map.text).toEqual(["r²", ""]);
    });

    it("draws the high r² on top, and each point of no r² in gray under them", () => {
        const option = derive();
        const points = seriesOf(option)[0];
        const r2 = pairs(points).map((pair) => pair[2]);
        expect(r2).toEqual([...r2].sort((a, b) => a - b));
        const gray = named(option, LD_MISSING_NAME);
        expect((gray.itemStyle as EchartOption).color).toBe(LD_MISSING_COLOR);
        expect(gray.z).toBeLessThan(2);
        expect(gray.data).toEqual([{ name: "rs7185735", value: [54010000, -Math.log10(0.4)] }]);
    });

    it("draws the lead variant as a purple diamond with its name on top", () => {
        const lead = named(derive(), LEAD_VARIANT_NAME);
        expect(lead.symbol).toBe("diamond");
        expect((lead.itemStyle as EchartOption).color).toBe(LEAD_VARIANT_COLOR);
        expect(LEAD_VARIANT_COLOR).toBe("#9632b8");
        expect(lead.data).toEqual([{ name: "rs1558902", value: [53803574, -Math.log10(7.5e-153)] }]);
        expect(lead.label).toMatchObject({ show: true, position: "top", formatter: "{b}" });
    });

    it("draws the recombination rate as a blue line on a right axis in cM/Mb, in position order", () => {
        const option = derive();
        const line = named(option, RECOMBINATION_NAME);
        expect(line.type).toBe("line");
        expect(line.yAxisIndex).toBe(1);
        expect((line.lineStyle as EchartOption).color).toBe(RECOMBINATION_COLOR);
        expect(line.showSymbol).toBe(false);
        expect(pairs(line).map((pair) => pair[0])).toEqual([53650000, 53750000, 53797000, 53803574, 53820527, 53900000, 54010000, 54080000]);
        const right = axes(option, "yAxis")[1];
        expect(right.position).toBe("right");
        expect(right.name).toBe("Recombination rate (cM/Mb)");
        expect(right.min).toBe(0);
        // The largest rate is 31, and the axis ends at the round number past it.
        expect(right.max).toBe(40);
        expect((right.splitLine as EchartOption).show).toBe(false);
    });

    it("marks the genome-wide line at 5 × 10⁻⁸, and ends the p axis at a round number past the lead", () => {
        const option = derive();
        const lines = seriesOf(option).flatMap((entry) => ((entry.markLine as EchartOption | undefined)?.data as EchartOption[] | undefined) ?? []);
        const guide = lines.find((line) => line.yAxis !== undefined);
        expect(guide?.yAxis).toBe(-Math.log10(5e-8));
        // The line itself names nothing, and a series of its own places the name at a free spot.
        expect(guide?.label).toEqual({ show: false });
        expect((named(option, GUIDE_LABEL).data as EchartOption[])[0].name).toBe("p 5 × 10⁻⁸");
        const left = axes(option, "yAxis")[0];
        expect(left.name).toBe("−log10(p)");
        expect(left.min).toBe(0);
        expect(left.max).toBe(200);
    });

    it("reads the position axis in megabases, with round ticks and the chromosome in the title", () => {
        const option = derive();
        const x = axes(option, "xAxis")[0];
        // The window spans 53.65 to 54.08 Mb, thus the ticks step by 0.1 Mb, and the axis ends at the rows.
        expect(x.min).toBe(53650000);
        expect(x.max).toBe(54080000);
        expect((x.axisLabel as EchartOption).show).toBe(false);
        // The runtime counts its ticks from the minimum, thus the axis hides them and the tick series draws each mark.
        expect((x.axisTick as EchartOption).show).toBe(false);
        expect(x.name).toBe("Position on chr16 (Mb)");
        const ticks = named(option, POSITION_TICKS);
        expect(ticks.symbol).toBe("rect");
        expect((ticks.data as EchartOption[]).map((item) => item.name)).toEqual(["53.7", "53.8", "53.9", "54.0"]);
        expect((ticks.data as EchartOption[]).map((item) => (item.value as number[])[0])).toEqual([53700000, 53800000, 53900000, 54000000]);
    });

    it("titles the position axis with the declared label in megabases", () => {
        const option = derive(locuszoom(ENCODING, { track: TRACK }, { position: "Position on chromosome 16 (bp)" }));
        expect(axes(option, "xAxis")[0].name).toBe("Position on chromosome 16 (Mb)");
    });

    it("draws each gene of the window as a line with its name, in lanes that never overlap", () => {
        const option = derive();
        const genes = named(option, GENE_NAMES);
        expect(genes.xAxisIndex).toBe(1);
        const names = (genes.data as EchartOption[]).map((item) => item.name);
        // AKTIP and IRX3 lie outside the window, thus they draw nothing.
        expect(names).toEqual(["RPGRIP1L", "MIR1972", "FTO"]);
        expect(genes.label).toMatchObject({ show: true, position: "bottom", fontStyle: "italic" });
        const spans = ((genes.markLine as EchartOption).data as EchartOption[][]).map(([from, to]) => [from.coord, to.coord] as number[][]);
        const lanes = spans.map(([from]) => from[1]);
        // The clipped FTO ends at the window, and each overlapping pair sits in two lanes.
        expect(spans[2][1][0]).toBe(54080000);
        expect(lanes[0]).not.toBe(lanes[1]);
        expect(new Set(lanes).size).toBeGreaterThanOrEqual(2);
        const grids = option.grid as EchartOption[];
        expect(grids.length).toBe(2);
    });

    it("keeps the height of the plot past the largest body, and the lanes share the rest of the gene band", () => {
        const layout = (count: number): { bodyPx: number; plotPx: number } => {
            const genes = Array.from({ length: count }, (_, index) => ({ gene: `G${index}`, start: 53650000, end: 54080000 }));
            const inputs: ChartInputs = { track: { rows: genes, columns: ["gene", "start", "end"] } };
            const render = deriveChartRender(locuszoom(), ROWS, undefined, { key: "lz", columns: [] }, inputs, OPTS)._unsafeUnwrap();
            const plot = (render.option.grid as EchartOption[])[0];
            const share = 100 - Number.parseFloat(String(plot.top)) - Number.parseFloat(String(plot.bottom));
            return { bodyPx: render.bodyPx, plotPx: (render.bodyPx * share) / 100 };
        };
        const grown = layout(10);
        const capped = layout(100);
        expect(capped.bodyPx).toBe(CHART_BODY_MAX_PX);
        expect(capped.plotPx).toBeCloseTo(grown.plotPx, 0);
    });

    it("draws a variant whose stored p is 0 as a triangle at the top, and makes it the lead", () => {
        const rows = [...ROWS, { chrom: "16", variant: "rs0", position: "53810000", pvalue: "0", r2: "0.9", recomb_rate: "0.3" }];
        const option = derive(locuszoom(), rows);
        const zero = seriesOf(option).find((entry) => entry.symbol === BELOW_RESOLUTION_SYMBOL);
        expect(zero?.data).toEqual([{ name: "rs0", value: [53810000, -Math.log10(7.5e-153)], itemStyle: { color: "#ff0000" } }]);
        expect((named(option, LEAD_VARIANT_NAME).data as EchartOption[])[0].name).toBe("rs0");
    });

    it("draws the plot alone with no track, no metric, and no chromosome", () => {
        const option = derive(locuszoom({ x: "position", y: "pvalue", color: "r2", label: "variant" }, {}));
        expect(seriesOf(option).some((entry) => entry.name === RECOMBINATION_NAME || entry.name === GENE_NAMES)).toBe(false);
        expect(axes(option, "yAxis").length).toBe(1);
        expect(axes(option, "xAxis")[0].name).toBe("Position (Mb)");
    });
});

describe("the guide label of the regional association plot", () => {
    /** The spot of the guide label: its position and its height, and the text style of its label. */
    function guideSpot(option: EchartOption): { at: number[]; label: EchartOption } {
        const guide = named(option, GUIDE_LABEL);
        const [item] = guide.data as EchartOption[];
        return { at: item.value as number[], label: guide.label as EchartOption };
    }

    /**
     * A window of 1 Mb in steps of 10 kb, with one lead at 500 kb. The rate reads 0, and the first 200 kb swing
     * between 0 and 10 cM/Mb across the guide line.
     */
    function window(swing: boolean): ChartRow[] {
        return Array.from({ length: 101 }, (_entry, index) => ({
            chrom: "16",
            variant: `rs${index}`,
            position: String(index * 10000),
            pvalue: index === 50 ? "1e-45" : "0.5",
            r2: "0.1",
            recomb_rate: String(swing && index <= 20 && index % 2 === 1 ? 10 : 0),
        }));
    }

    it("sets the name over the line at the left end, inside the plot, on the far side from the recombination axis", () => {
        const option = derive(locuszoom(ENCODING, {}), window(false));
        const { at, label } = guideSpot(option);
        expect(at[1]).toBe(-Math.log10(5e-8));
        expect(at[0]).toBeGreaterThan(0);
        expect(at[0]).toBeLessThan(20000);
        expect(label).toMatchObject({ show: true, formatter: "{b}", align: "left", verticalAlign: "bottom", textBorderColor: "#ffffff" });
        expect(named(option, GUIDE_LABEL)).toMatchObject({ type: "scatter", symbolSize: 0, silent: true });
    });

    it("moves the name past the stretch where the recombination line crosses it", () => {
        const { at } = guideSpot(derive(locuszoom(ENCODING, {}), window(true)));
        expect(at[0]).toBeGreaterThan(200000);
        expect(at[0]).toBeLessThan(220000);
    });

    it("moves the name past a variant that sits in its box", () => {
        const rows = window(false).map((row, index) => (index === 1 ? { ...row, pvalue: "1e-9" } : row));
        const { at } = guideSpot(derive(locuszoom(ENCODING, {}), rows));
        // The name starts past the symbol of the variant at 10 kb, and a gap of a few pixels past it.
        expect(at[0]).toBeGreaterThan(25000);
        expect(at[0]).toBeLessThan(40000);
    });

    it("takes the spot of the fewest crossings where no spot is free", () => {
        // The rate swings across the name everywhere but a calm stretch from 600 to 750 kb, which is narrower
        // than the name at the single column.
        const rows = window(false).map((row, index) => ({ ...row, recomb_rate: String((index < 60 || index > 75) && index % 2 === 1 ? 10 : 0) }));
        const { at } = guideSpot(derive(locuszoom(ENCODING, {}), rows));
        expect(at[0]).toBeGreaterThan(600000);
        expect(at[0]).toBeLessThan(620000);
    });

    it("keeps the name clear of the recombination line and of each variant in the FTO excerpt", () => {
        // The rate crosses the band of the name from 53.75 Mb, and the left end is free.
        const { at } = guideSpot(derive());
        expect(at[0]).toBeGreaterThan(53650000);
        expect(at[0]).toBeLessThan(53670000);
    });
});

describe("the LD legend of an export", () => {
    const exportOnThePage = new Function(`${CHART_RENDERERS_SOURCE}\nreturn reportExportOption;`)() as typeof exportOption;

    it("keeps the row of bins at each column size, on the server and on the page", () => {
        const option = derive();
        const legend = (option.visualMap as EchartOption[])[0];
        for (const size of [CHART_EXPORT_SIZES.single, CHART_EXPORT_SIZES.double]) {
            for (const exported of [exportOption, exportOnThePage]) {
                // A continuous scale grows its bar in an export, and a row of pieces keeps the size of its icons.
                expect((exported(option, size.textPx, size.widthPx, size.heightPx).visualMap as EchartOption[])[0]).toEqual(legend);
            }
        }
    });
});

describe("the refusals of the regional association plot", () => {
    it("refuses a position that is not a number", () => {
        const rows = [...ROWS, { chrom: "16", variant: "rsX", position: "53.9Mb", pvalue: "0.1", r2: "0.1", recomb_rate: "1" }];
        expect(refusal(locuszoom(), rows)).toBe(
            'The locuszoom reads the "position" column as a position in base pairs, and row 9 holds "53.9Mb", which is not a number.',
        );
    });

    it("refuses a table of two chromosomes", () => {
        const rows = [...ROWS, { chrom: "17", variant: "rsY", position: "53900001", pvalue: "0.1", r2: "0.1", recomb_rate: "1" }];
        expect(refusal(locuszoom(), rows)).toBe('The locuszoom draws one region of one chromosome, and the "chrom" column holds "16" and "17".');
    });

    it("refuses an r² outside 0 to 1", () => {
        const rows = [...ROWS, { chrom: "16", variant: "rsZ", position: "53900001", pvalue: "0.1", r2: "1.2", recomb_rate: "1" }];
        expect(refusal(locuszoom(), rows)).toBe(
            'The locuszoom reads the "r2" column as the r² with the lead variant, and row 9 holds 1.2, which is outside 0 to 1.',
        );
    });

    it("refuses a block with no r² column", () => {
        expect(refusal(locuszoom({ x: "position", y: "pvalue" }, {}))).toBe(
            'The locuszoom chart needs a column for the "color" channel: the r² of each variant with the lead variant.',
        );
    });

    it("refuses a transform on the position", () => {
        expect(refusal(locuszoom({ ...ENCODING, x: { column: "position", transform: "log10" } }))).toBe(
            'The locuszoom reads the "x" column as it stands, thus the channel takes no transform and no "orderBy".',
        );
    });

    it("refuses a track that lacks a named column", () => {
        const inputs: ChartInputs = { track: { rows: GENES.map(({ gene: _gene, ...rest }) => rest), columns: ["start", "end", "strand"] } };
        expect(refusal(locuszoom(), ROWS, inputs)).toBe('The track table holds no "gene" column.');
    });
});

describe("the dense regional association plot", () => {
    const COLUMNS = ["chrom", "variant", "position", "pvalue", "r2", "recomb_rate"];

    /** A window of 20,000 variants: each tenth one has no r², and the p falls away from the middle. */
    function denseRows(count: number): ChartRow[] {
        const rows: ChartRow[] = [];
        for (let index = 0; index < count; index += 1) {
            const distance = Math.abs(index - count / 2) / count;
            rows.push({
                chrom: "16",
                variant: `rs${index}`,
                position: String(53400000 + index * 40),
                pvalue: String(Math.pow(10, -(1 + 60 * (0.5 - distance) * ((index * 7) % 10) * 0.1))),
                r2: index % 10 === 0 ? "" : String(Math.round(((index * 37) % 100) / 1.01) / 100),
                recomb_rate: String((index * 13) % 50),
            });
        }
        return rows;
    }

    const seriesDataOnThePage = new Function(`${CHART_SERIES_BUILDER}\nreturn reportSeriesData;`)() as (
        payload: { columns: string[]; rows: ChartRow[] },
        source: ChartDataSource["series"][number],
        rule: unknown,
    ) => unknown[];

    it("reads the payload past the bound for the points and the recombination line, and the page builds them as the server does", () => {
        const rows = denseRows(20000);
        const render = deriveChartRender(locuszoom(ENCODING, {}), rows, COLUMNS, { key: "fto", columns: COLUMNS }, {}, OPTS)._unsafeUnwrap();
        expect(JSON.stringify(render.inline).length).toBeGreaterThan(CHART_INLINE_OPTION_BOUND);
        expect(render.readsPayload).toBe(true);
        const source = render.option[CHART_SOURCE_MEMBER] as ChartDataSource;
        expect(source.series.length).toBe(2);
        for (const [index, entry] of source.series.entries()) {
            const page = seriesDataOnThePage({ columns: COLUMNS, rows }, entry, source.rule);
            expect(JSON.stringify(page)).toBe(JSON.stringify(seriesOf(render.inline)[index].data));
        }
        // The points of no r² ride inline after the payload series, one tenth of the rows.
        expect((named(render.option, LD_MISSING_NAME).data as unknown[]).length).toBe(2000);
    });
});
