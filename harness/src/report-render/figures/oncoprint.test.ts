/**
 * The oncoprint figure: the glyph cells, the class colors, the top count bar, the right share bar with its
 * percent text, and the unaltered samples. The rows are an excerpt of the TCGA LAML table of the gallery.
 */

import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import { deriveChartOption, deriveChartRender, type ChartRow, type EchartOption } from "../chart.js";
import { CHART_BODY_PX, CHART_SLOT_LIMIT } from "../design.js";
import { CELL_GLYPH_RENDERER } from "../chart-renderers.js";
import { ALTERATION_CLASS_COLORS, CELL_GROUND_COLOR, ONCOPRINT_ROW_PX } from "./oncoprint.js";

type Encoding = NonNullable<ChartBlock["encoding"]>;

const HASH = `sha256:${"a".repeat(64)}`;

/** An oncoprint block over the LAML columns, with the given encoding. */
function oncoprint(encoding: Encoding, extra: Partial<ChartBlock> = {}): ChartBlock {
    return { kind: "chart", id: "onco", binding: { kind: "artifact-table", path: "oncoprint.csv", hash: HASH }, chartType: "oncoprint", encoding, ...extra };
}

/**
 * The excerpt: three genes over four samples. The sample TCGA-AB-2803 holds no alteration, thus its one row
 * names the first gene with an empty class. The rows list NPM1 first, thus the first appearance and the rank
 * order of the genes differ.
 */
const ROWS: ChartRow[] = [
    { gene: "NPM1", sample: "TCGA-AB-2945", variant_classification: "Frame_Shift_Ins", gene_rank: 3, sample_rank: 1 },
    { gene: "FLT3", sample: "TCGA-AB-2945", variant_classification: "Missense_Mutation", gene_rank: 1, sample_rank: 1 },
    { gene: "FLT3", sample: "TCGA-AB-2965", variant_classification: "In_Frame_Ins", gene_rank: 1, sample_rank: 2 },
    { gene: "DNMT3A", sample: "TCGA-AB-2945", variant_classification: "Missense_Mutation", gene_rank: 2, sample_rank: 1 },
    { gene: "DNMT3A", sample: "TCGA-AB-2965", variant_classification: "Missense_Mutation", gene_rank: 2, sample_rank: 2 },
    { gene: "FLT3", sample: "TCGA-AB-2803", variant_classification: "", gene_rank: 1, sample_rank: 160 },
    { gene: "DNMT3A", sample: "TCGA-AB-2802", variant_classification: "Silent", gene_rank: 2, sample_rank: 53 },
    { gene: "NPM1", sample: "TCGA-AB-2802", variant_classification: "Frame_Shift_Ins", gene_rank: 3, sample_rank: 53 },
    { gene: "NPM1", sample: "TCGA-AB-2965", variant_classification: "Frame_Shift_Ins", gene_rank: 3, sample_rank: 2 },
];

const RANKED: Encoding = {
    x: { column: "sample", orderBy: "sample_rank" },
    y: { column: "gene", orderBy: "gene_rank" },
    value: "variant_classification",
};

function derive(encoding: Encoding = RANKED, rows: ChartRow[] = ROWS): EchartOption {
    return deriveChartOption(oncoprint(encoding), rows)._unsafeUnwrap();
}

function seriesOf(option: EchartOption): EchartOption[] {
    return option.series as EchartOption[];
}

function axesOf(option: EchartOption, key: "xAxis" | "yAxis"): EchartOption[] {
    return option[key] as EchartOption[];
}

/** The custom series of the matrix. */
function cellSeries(option: EchartOption): EchartOption {
    const found = seriesOf(option).find((entry) => entry.renderItem === CELL_GLYPH_RENDERER);
    if (found === undefined) throw new Error("no cell series");
    return found;
}

/** The class place of the cell of one sample and one gene, read through the axes of the matrix. */
function cellClass(option: EchartOption, sample: string, gene: string): number {
    const samples = axesOf(option, "xAxis")[0].data as string[];
    const genes = axesOf(option, "yAxis")[0].data as string[];
    const item = (cellSeries(option).data as Array<number[] | { value: number[] }>)
        .map((entry) => (Array.isArray(entry) ? entry : entry.value))
        .find((value) => value[0] === samples.indexOf(sample) && value[1] === genes.indexOf(gene));
    if (item === undefined) throw new Error(`no cell for ${sample} ${gene}`);
    return item[2];
}

describe("the oncoprint figure", () => {
    it("draws one glyph cell for each gene and sample through the cell-glyph renderer", () => {
        const option = derive();
        const cells = cellSeries(option);
        expect(cells.type).toBe("custom");
        expect(cells.data as unknown[]).toHaveLength(3 * 4);
        const payload = cells.itemPayload as { colors: string[]; ground: string };
        expect(payload.ground).toBe(CELL_GROUND_COLOR);
        expect(payload.colors[cellClass(option, "TCGA-AB-2945", "FLT3")]).toBe(ALTERATION_CLASS_COLORS.Missense_Mutation);
        expect(payload.colors[cellClass(option, "TCGA-AB-2965", "FLT3")]).toBe(ALTERATION_CLASS_COLORS.In_Frame_Ins);
        expect(cellClass(option, "TCGA-AB-2802", "FLT3")).toBe(-1);
    });

    it("gives each common class its fixed color, and an unknown class a palette color outside the map", () => {
        const option = derive();
        const payload = cellSeries(option).itemPayload as { colors: string[] };
        const silent = payload.colors[cellClass(option, "TCGA-AB-2802", "DNMT3A")];
        expect(Object.values(ALTERATION_CLASS_COLORS)).not.toContain(silent);
        expect(silent).toMatch(/^#[0-9a-f]{6}$/);
        // The fixed map holds the common classes of the MAF standard.
        expect(Object.keys(ALTERATION_CLASS_COLORS)).toEqual([
            "Missense_Mutation",
            "Nonsense_Mutation",
            "Frame_Shift_Del",
            "Frame_Shift_Ins",
            "In_Frame_Del",
            "In_Frame_Ins",
            "Splice_Site",
            "Translation_Start_Site",
            "Nonstop_Mutation",
            "Multi_Hit",
        ]);
    });

    it("orders the genes and the samples by their order columns, the first gene at the top", () => {
        const option = derive();
        expect(axesOf(option, "yAxis")[0]).toEqual(expect.objectContaining({ type: "category", inverse: true, data: ["FLT3", "DNMT3A", "NPM1"] }));
        expect(axesOf(option, "xAxis")[0].data).toEqual(["TCGA-AB-2945", "TCGA-AB-2965", "TCGA-AB-2802", "TCGA-AB-2803"]);
    });

    it("keeps the first appearance of each category where the channel names no order", () => {
        const option = derive({ x: "sample", y: "gene", value: "variant_classification" });
        expect(axesOf(option, "yAxis")[0].data).toEqual(["NPM1", "FLT3", "DNMT3A"]);
    });

    it("draws the alteration count of each sample over the matrix, stacked by class", () => {
        const option = derive();
        const bars = seriesOf(option).filter((entry) => entry.type === "bar" && entry.xAxisIndex === 1);
        expect(bars.map((entry) => entry.name)).toEqual(["Missense Mutation", "Frame Shift Ins", "In Frame Ins", "Silent"]);
        for (const bar of bars) expect(bar.stack).toBe(bars[0].stack);
        // Each sample sums the classes of its altered genes, and the unaltered sample counts zero.
        const totals = [0, 1, 2, 3].map((place) => bars.reduce((sum, bar) => sum + ((bar.data as number[])[place] ?? 0), 0));
        expect(totals).toEqual([3, 3, 2, 0]);
        expect(axesOf(option, "xAxis")[1]).toEqual(expect.objectContaining({ gridIndex: 1, data: axesOf(option, "xAxis")[0].data }));
    });

    it("draws the share of altered samples of each gene at the right, with its percent text over every sample", () => {
        const option = derive();
        const share = seriesOf(option).find((entry) => entry.type === "bar" && entry.xAxisIndex === 2);
        expect(share).toBeDefined();
        // Four samples hold the denominator, the unaltered one included.
        const data = share?.data as Array<{ value: number; label: { formatter: string } }>;
        expect(data.map((item) => item.value)).toEqual([0.5, 0.75, 0.75]);
        expect(data.map((item) => item.label.formatter)).toEqual(["50%", "75%", "75%"]);
        expect(axesOf(option, "yAxis")[2]).toEqual(expect.objectContaining({ gridIndex: 2, inverse: true, data: ["FLT3", "DNMT3A", "NPM1"] }));
    });

    it("hides the sample names, and the axis title states the sample count", () => {
        const option = derive();
        const samples = axesOf(option, "xAxis")[0];
        expect(samples.axisLabel).toEqual(expect.objectContaining({ show: false }));
        expect(samples.name).toBe("sample (n = 4)");
    });

    it("names the legend by the classes, and draws no legend entry for the cells or the share", () => {
        const option = derive();
        const legend = option.legend as { data: Array<{ name: string }> };
        expect(legend.data.map((entry) => entry.name)).toEqual(["Missense Mutation", "Frame Shift Ins", "In Frame Ins", "Silent"]);
    });

    it("refuses a gene and a sample that hold two classes", () => {
        const rows = [...ROWS, { gene: "FLT3", sample: "TCGA-AB-2945", variant_classification: "Nonsense_Mutation", gene_rank: 1, sample_rank: 1 }];
        expect(deriveChartOption(oncoprint(RANKED), rows)._unsafeUnwrapErr()).toEqual({
            blockId: "onco",
            kind: "invalid-chart-input",
            detail: 'The oncoprint holds the gene "FLT3" and the sample "TCGA-AB-2945" with two classes. One cell draws one class, thus the table states "Multi_Hit" for a gene with more than one class in a sample.',
        });
    });

    it("refuses a matrix of more cells than a chart holds, and names the count", () => {
        // 101 genes over 1,000 samples give 101,000 cells, one past the bound of 100,000 slots.
        const rows: ChartRow[] = [];
        for (let index = 0; index < 1000; index += 1) {
            rows.push({ gene: `G${index % 101}`, sample: `S${index}`, variant_classification: "Missense_Mutation" });
        }
        expect(deriveChartOption(oncoprint({ x: "sample", y: "gene", value: "variant_classification" }), rows)._unsafeUnwrapErr()).toEqual({
            blockId: "onco",
            kind: "invalid-chart-input",
            detail: `The oncoprint holds 101 genes and 1000 samples, thus 101000 cells. A chart holds ${CHART_SLOT_LIMIT} slots at most, thus a table of fewer genes or fewer samples serves the reader.`,
        });
    });

    it("refuses a block with no class channel", () => {
        expect(deriveChartOption(oncoprint({ x: "sample", y: "gene" }), ROWS)._unsafeUnwrapErr().detail).toBe(
            'The oncoprint figure needs a column for the "value" channel.',
        );
    });

    it("refuses a transform on a category channel", () => {
        expect(
            deriveChartOption(oncoprint({ x: { column: "sample", transform: "rank" }, y: "gene", value: "variant_classification" }), ROWS)._unsafeUnwrapErr()
                .detail,
        ).toBe('The oncoprint reads the "x" column as categories, thus the channel takes no transform.');
    });

    it("refuses an order on the class channel", () => {
        expect(
            deriveChartOption(oncoprint({ ...RANKED, value: { column: "variant_classification", orderBy: "gene_rank" } }), ROWS)._unsafeUnwrapErr().detail,
        ).toBe('The "value" channel draws no category axis, thus it takes no "orderBy".');
    });

    describe("the annotation tracks", () => {
        const SUBTYPE: Record<string, string> = { "TCGA-AB-2945": "M1", "TCGA-AB-2965": "M2", "TCGA-AB-2802": "M1", "TCGA-AB-2803": "M4" };
        const rows = ROWS.map((row) => ({ ...row, subtype: SUBTYPE[String(row.sample)] }));

        it("draws each track as one strip of category colors under the matrix, and the legend names each value", () => {
            const option = derive({ ...RANKED, tracks: ["subtype"] }, rows);
            expect(option.grid as EchartOption[]).toHaveLength(4);
            const strips = seriesOf(option).filter((entry) => entry.xAxisIndex === 3);
            expect(strips.map((entry) => entry.name)).toEqual(["M1", "M2", "M4"]);
            expect(strips.every((entry) => entry.renderItem === CELL_GLYPH_RENDERER)).toBe(true);
            // Each strip cell is the ground of its value color alone: the first and the third sample hold M1.
            expect(strips[0].data).toEqual([
                [0, 0, -1],
                [2, 0, -1],
            ]);
            const grounds = strips.map((entry) => (entry.itemPayload as { ground: string }).ground);
            expect(new Set(grounds).size).toBe(3);
            expect(axesOf(option, "yAxis")[3]).toEqual(expect.objectContaining({ gridIndex: 3, data: ["subtype"] }));
            // The sample title moves under the strips.
            expect(axesOf(option, "xAxis")[0].name).toBeUndefined();
            expect(axesOf(option, "xAxis")[3].name).toBe("sample (n = 4)");
            const legend = (option.legend as { data: Array<{ name: string }> }).data.map((entry) => entry.name);
            expect(legend.slice(-3)).toEqual(["M1", "M2", "M4"]);
        });

        it("refuses a track column that holds two values for one sample", () => {
            const mixed = rows.map((row, index) => (index === 1 ? { ...row, subtype: "M5" } : row));
            expect(deriveChartOption(oncoprint({ ...RANKED, tracks: ["subtype"] }), mixed)._unsafeUnwrapErr().detail).toBe(
                'The track column "subtype" holds two values for the sample "TCGA-AB-2945". A track draws one value for each sample.',
            );
        });
    });
});

describe("the height of an oncoprint of many genes", () => {
    /** Twenty genes over forty samples, each sample altered in one gene. */
    function cohort(tracks: boolean): ChartRow[] {
        const rows: ChartRow[] = [];
        for (let sample = 0; sample < 40; sample += 1) {
            const gene = sample % 20;
            rows.push({
                gene: `G${gene}`,
                sample: `S${sample}`,
                variant_classification: "Missense_Mutation",
                gene_rank: gene,
                sample_rank: sample,
                burden: sample % 2 === 0 ? "High" : "Low",
            });
        }
        return tracks ? rows : rows.map(({ burden: _burden, ...row }) => row);
    }

    /** The height of one gene row on the page, in pixels. */
    function rowPx(encoding: Encoding, rows: ChartRow[]): number {
        const render = deriveChartRender(oncoprint(encoding), rows, undefined, { key: "onco", columns: [] })._unsafeUnwrap();
        const matrix = (render.option.grid as EchartOption[])[0];
        const share = 100 - Number.parseFloat(String(matrix.top)) - Number.parseFloat(String(matrix.bottom));
        return (render.bodyPx * share) / 100 / 20;
    }

    it("states a body tall enough that each gene row takes one line of text, with and with no track", () => {
        expect(rowPx(RANKED, cohort(false))).toBeGreaterThanOrEqual(ONCOPRINT_ROW_PX);
        expect(rowPx({ ...RANKED, tracks: ["burden"] }, cohort(true))).toBeGreaterThanOrEqual(ONCOPRINT_ROW_PX);
    });

    it("keeps the default body for a few genes", () => {
        expect(deriveChartRender(oncoprint(RANKED), ROWS, undefined, { key: "onco", columns: [] })._unsafeUnwrap().bodyPx).toBe(CHART_BODY_PX);
    });
});
