/**
 * The Manhattan figure: the chromosomes in two alternating colors, the chromosome names under the middle of
 * their points, the genome-wide and the suggestive lines, and the names of the lead variants.
 */

import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import { CHART_SOURCE_MEMBER, deriveChartOption, deriveChartRender, type ChartDataSource, type ChartOpts, type ChartRow, type EchartOption } from "../chart.js";
import { exportOption } from "../chart-renderers.js";
import { CHART_EXPORT_SIZES, CHART_INLINE_OPTION_BOUND } from "../design.js";
import { CHART_SERIES_BUILDER } from "../page.js";
import { BELOW_RESOLUTION_SYMBOL, POINT_NAMES } from "./dense.js";
import { FIGURE_MODULES } from "./index.js";
import { EXPORT_PLOT_FRAMES, leaderNameBox, overlaps, PAGE_PLOT_FRAME, textWidthPx, type LeaderName, type NameFrame } from "./label-room.js";
import { guideLabelBox, MANHATTAN_COLORS, MANHATTAN_FIGURE, MANHATTAN_LABEL_COUNT, MANHATTAN_NAME_GAP_SHARE, MANHATTAN_SUGGESTIVE_P } from "./manhattan.js";

type Encoding = NonNullable<ChartBlock["encoding"]>;

const HASH = `sha256:${"d".repeat(64)}`;
const OPTS: ChartOpts = { figures: { manhattan: MANHATTAN_FIGURE } };
const ENCODING: Encoding = { x: "cum_pos", y: "pvalue", group: "chrom", label: "snp" };

function block(encoding: Encoding = ENCODING): ChartBlock {
    return {
        kind: "chart",
        id: "g1",
        binding: { kind: "artifact-table", path: "gwas/manhattan.csv", hash: HASH },
        chartType: "manhattan",
        encoding,
    };
}

/**
 * An excerpt of the BMI GWAS of the GIANT consortium, thinned as a Manhattan table: chromosome 1 holds two
 * genome-wide hits, chromosome 2 holds one hit and a suggestive variant, and chromosome 3 holds none.
 */
const ROWS: ChartRow[] = [
    { chrom: "1", snp: "rs3766191", pvalue: "0.0455", cum_pos: "1082207" },
    { chrom: "1", snp: "rs977747", pvalue: "2.182e-08", cum_pos: "47219005" },
    { chrom: "1", snp: "rs657452", pvalue: "2.123e-13", cum_pos: "49124175" },
    { chrom: "1", snp: "rs1", pvalue: "0.51", cum_pos: "248900000" },
    { chrom: "2", snp: "rs2", pvalue: "0.3", cum_pos: "249100000" },
    { chrom: "2", snp: "rs6545814", pvalue: "4.4e-15", cum_pos: "274000000" },
    { chrom: "2", snp: "rs3", pvalue: "3e-6", cum_pos: "300000000" },
    { chrom: "2", snp: "rs4", pvalue: "", cum_pos: "380000000" },
    { chrom: "2", snp: "rs5", pvalue: "0.9", cum_pos: "491000000" },
    { chrom: "3", snp: "rs6", pvalue: "0.02", cum_pos: "491300000" },
    { chrom: "3", snp: "rs7", pvalue: "0.6", cum_pos: "689000000" },
];

function derive(chartBlock: ChartBlock = block(), rows: readonly ChartRow[] = ROWS): EchartOption {
    return deriveChartOption(chartBlock, rows, undefined, {}, OPTS)._unsafeUnwrap();
}

function seriesOf(option: EchartOption): EchartOption[] {
    return option.series as EchartOption[];
}

/** The upper end of the y axis of one option. */
function asTop(option: EchartOption): number {
    return (option.yAxis as EchartOption).max as number;
}

describe("the Manhattan figure", () => {
    it("registers in the figure registry", () => {
        expect(FIGURE_MODULES.manhattan).toBe(MANHATTAN_FIGURE);
    });

    it("draws one series for each chromosome in two alternating colors, with no legend", () => {
        const option = derive();
        const series = seriesOf(option).slice(0, 3);
        expect(series.map((entry) => entry.name)).toEqual(["1", "2", "3"]);
        expect(series.map((entry) => (entry.itemStyle as EchartOption).color)).toEqual([MANHATTAN_COLORS[0], MANHATTAN_COLORS[1], MANHATTAN_COLORS[0]]);
        expect(option.legend).toEqual({ show: false });
    });

    it("names each chromosome under the middle of its points, and hides the position ticks", () => {
        const option = derive();
        const names = seriesOf(option)[3];
        expect(names.silent).toBe(true);
        expect(names.symbolSize).toBe(0);
        // The runtime measures the names, thus a name that overlaps the one before it hides at a narrow width.
        expect(names.labelLayout).toEqual({ hideOverlap: true });
        // The row of chromosome 2 with no p draws no point, thus its position takes no part in the middle.
        expect(names.data).toEqual([
            { name: "1", value: [(1082207 + 248900000) / 2, 0] },
            { name: "2", value: [(249100000 + 491000000) / 2, 0] },
            { name: "3", value: [(491300000 + 689000000) / 2, 0] },
        ]);
        const x = option.xAxis as EchartOption;
        expect(x.min).toBe(1082207);
        expect(x.max).toBe(689000000);
        expect((x.axisLabel as EchartOption).show).toBe(false);
        expect((option.yAxis as EchartOption).min).toBe(0);
    });

    it("draws the genome-wide line with its label and the suggestive line", () => {
        const lines = seriesOf(derive())
            .filter((entry) => entry.name !== POINT_NAMES)
            .flatMap((entry) => ((entry.markLine as EchartOption | undefined)?.data as EchartOption[] | undefined) ?? []);
        expect(MANHATTAN_SUGGESTIVE_P).toBe(1e-5);
        expect(lines.map((line) => [line.yAxis, (line.label as EchartOption).formatter])).toEqual([
            [-Math.log10(5e-8), "p 5 × 10⁻⁸"],
            [-Math.log10(1e-5), undefined],
        ]);
        // The label sits over the line at its right end, inside the plot and clear of the chromosome names
        // under the axis.
        expect((lines[0].label as EchartOption).position).toBe("insideEndTop");
    });

    it("keeps the name of a lead variant at the right end clear of the label of the genome-wide line", () => {
        const high = 689000000;
        const rows = [...ROWS, { chrom: "3", snp: "rs99", pvalue: "1e-8", cum_pos: String(high - 1000000) }];
        const option = derive(block(), rows);
        const names = seriesOf(option).find((entry) => entry.name === POINT_NAMES);
        const lead = ((names?.data ?? []) as EchartOption[]).find((item) => item.name === "rs99");
        expect(lead).toBeDefined();
        // The page frame reads a window 1280 pixels wide, thus the runtime hides a lead name that still overlaps
        // another on a narrower window.
        expect(names?.labelLayout).toEqual({ hideOverlap: true });
        const [x, y] = lead?.value as number[];
        const box = guideLabelBox(-Math.log10(5e-8), { min: 1082207, max: high }, asTop(option), "p 5 × 10⁻⁸", PAGE_PLOT_FRAME);
        expect(x >= box.left && x <= box.right && y >= box.bottom && y <= box.top).toBe(false);
    });

    /** The names of the lead variants, in the order of their p. */
    function shownLabels(option: EchartOption): unknown[] {
        const names = seriesOf(option).find((entry) => entry.name === POINT_NAMES);
        return ((names?.data ?? []) as EchartOption[]).map((item) => item.name);
    }

    it("names the ten most significant lead variants over the genome, one for each chromosome", () => {
        // Twelve chromosomes of 100 positions, each with two hits. The lead of chromosome n holds the p 1e-(9 + n).
        const rows: ChartRow[] = [];
        for (let chromosome = 1; chromosome <= 12; chromosome += 1) {
            const start = (chromosome - 1) * 100;
            rows.push({ chrom: String(chromosome), snp: `rs${chromosome}a`, pvalue: "0.5", cum_pos: String(start) });
            rows.push({ chrom: String(chromosome), snp: `rs${chromosome}b`, pvalue: `1e-${9 + chromosome}`, cum_pos: String(start + 50) });
            rows.push({ chrom: String(chromosome), snp: `rs${chromosome}c`, pvalue: `1e-${8 + chromosome}`, cum_pos: String(start + 60) });
        }
        const shown = shownLabels(derive(block(), rows));
        expect(MANHATTAN_LABEL_COUNT).toBe(10);
        // The two weakest leads, of chromosomes 1 and 2, show no name. A second hit of a chromosome is no lead.
        expect(shown).toEqual(["rs12b", "rs11b", "rs10b", "rs9b", "rs8b", "rs7b", "rs6b", "rs5b", "rs4b", "rs3b"]);
    });

    it("prints a chromosome name only where it keeps the gap from the name before it", () => {
        const rows: ChartRow[] = [
            { chrom: "1", snp: "a", pvalue: "0.5", cum_pos: "0" },
            { chrom: "1", snp: "b", pvalue: "0.5", cum_pos: "20" },
            { chrom: "2", snp: "c", pvalue: "0.5", cum_pos: "21" },
            { chrom: "2", snp: "d", pvalue: "0.5", cum_pos: "22" },
            { chrom: "3", snp: "e", pvalue: "0.5", cum_pos: "23" },
            { chrom: "3", snp: "f", pvalue: "0.5", cum_pos: "100" },
        ];
        const names = (option: EchartOption): unknown[] =>
            ((seriesOf(option).find((entry) => entry.name === "Chromosome names") as EchartOption).data as EchartOption[]).map((entry) => entry.name);
        expect(MANHATTAN_NAME_GAP_SHARE).toBe(0.5);
        // On the page plot of 760 px, the middles sit at 76, 163.4, and 467.4 px. The names are 7.2 px wide,
        // thus each text starts far past the end of the one before it.
        expect(names(derive(block(), rows))).toEqual(["1", "2", "3"]);
        // Moved 10 to the left, chromosome 2 sits at 87.4 px. Its text starts 4.2 px after the text of
        // chromosome 1 ends, under the gap of 6 px, thus its name does not print.
        const crowded = rows.map((row) => (row.chrom === "2" ? { ...row, cum_pos: String(Number(row.cum_pos) - 10) } : row));
        expect(names(derive(block(), crowded))).toEqual(["1", "3"]);
    });

    it("names the lead variant of each chromosome that passes the genome-wide line", () => {
        const option = derive();
        // Chromosome 1 holds two hits and its lead is the smaller p. The suggestive variant of chromosome 2 is
        // no lead, and chromosome 3 holds no hit.
        expect(shownLabels(option)).toEqual(["rs6545814", "rs657452"]);
        // The points carry no label of the runtime, thus no name hides.
        for (const points of seriesOf(option).slice(0, 3)) {
            expect((points.data as unknown[]).some((item) => typeof item === "object" && item !== null && "label" in item)).toBe(false);
        }
    });

    it("places each lead name over its peak where the axis holds the room, with a leader line to its point", () => {
        // A variant with no name lifts the p axis to 20, thus each named peak has room above it.
        const rows = [...ROWS, { chrom: "3", snp: "", pvalue: "1e-19", cum_pos: "500000000" }];
        const names = seriesOf(derive(block(), rows)).find((entry) => entry.name === POINT_NAMES) as EchartOption;
        const items = names.data as EchartOption[];
        expect(items.map((item) => (item.label as EchartOption).position)).toEqual(["top", "top"]);
        const leaders = (names.markLine as EchartOption).data as Array<Array<{ coord: number[] }>>;
        expect(leaders.map((pair) => pair[0].coord)).toEqual([
            [274000000, -Math.log10(4.4e-15)],
            [49124175, -Math.log10(2.123e-13)],
        ]);
        expect(leaders.map((pair) => pair[1].coord)).toEqual(items.map((item) => item.value));
    });

    it("places the name of a peak at the top of the axis beside the peak", () => {
        const names = seriesOf(derive()).find((entry) => entry.name === POINT_NAMES) as EchartOption;
        // The tallest peak reaches the end of the p axis, thus its name finds no room over it.
        expect(((names.data as EchartOption[])[0].label as EchartOption).position).toBe("right");
    });

    it("gives the same colors, chromosome names, and lead names to a table sorted by p as to the table sorted by position", () => {
        const byPosition = derive();
        const pOf = (row: ChartRow): number => (row.pvalue === "" ? 1 : Number(row.pvalue));
        const byP = derive(
            block(),
            [...ROWS].sort((a, b) => pOf(a) - pOf(b)),
        );
        const colors = (option: EchartOption): Record<string, unknown> =>
            Object.fromEntries(
                seriesOf(option)
                    .slice(0, 3)
                    .map((entry) => [entry.name, (entry.itemStyle as EchartOption).color]),
            );
        const dataOf = (option: EchartOption, name: string): unknown => seriesOf(option).find((entry) => entry.name === name)?.data;
        expect(colors(byP)).toEqual(colors(byPosition));
        expect(dataOf(byP, "Chromosome names")).toEqual(dataOf(byPosition, "Chromosome names"));
        expect(dataOf(byP, POINT_NAMES)).toEqual(dataOf(byPosition, POINT_NAMES));
        expect(byP.xAxis).toEqual(byPosition.xAxis);
        expect(byP.yAxis).toEqual(byPosition.yAxis);
    });

    it("orders the chromosomes by the genome: the numbers in numeric order, then X, Y, and MT, then each other name", () => {
        const rows: ChartRow[] = [
            { chrom: "MT", snp: "m", pvalue: "0.5", cum_pos: "900" },
            { chrom: "10", snp: "j", pvalue: "0.5", cum_pos: "500" },
            { chrom: "X", snp: "x", pvalue: "0.5", cum_pos: "700" },
            { chrom: "2", snp: "b", pvalue: "0.5", cum_pos: "200" },
            { chrom: "Un", snp: "u", pvalue: "0.5", cum_pos: "1000" },
            { chrom: "1", snp: "a", pvalue: "0.5", cum_pos: "0" },
            { chrom: "Y", snp: "y", pvalue: "0.5", cum_pos: "800" },
        ];
        const option = derive(block(), rows);
        const names = ((seriesOf(option).find((entry) => entry.name === "Chromosome names") as EchartOption).data as EchartOption[]).map((entry) => entry.name);
        expect(names).toEqual(["1", "2", "10", "X", "Y", "MT", "Un"]);
        const colors = Object.fromEntries(
            seriesOf(option)
                .slice(0, 7)
                .map((entry) => [entry.name, (entry.itemStyle as EchartOption).color]),
        );
        const [blue, gray] = MANHATTAN_COLORS;
        expect(colors).toEqual({ "1": blue, "2": gray, "10": blue, X: gray, Y: blue, MT: gray, Un: blue });
    });

    it("draws a variant whose stored p is 0 at the top of the p axis as an upward triangle, and names it as the lead", () => {
        const rows = [...ROWS, { chrom: "2", snp: "rsZero", pvalue: "0", cum_pos: "300000001" }];
        const option = derive(block(), rows);
        const triangles = seriesOf(option).filter((entry) => entry.symbol === BELOW_RESOLUTION_SYMBOL);
        expect(triangles.length).toBe(1);
        const top = -Math.log10(4.4e-15);
        expect(triangles[0].data).toEqual([{ name: "rsZero", value: [300000001, top], itemStyle: { color: MANHATTAN_COLORS[1] } }]);
        expect((option.yAxis as EchartOption).max as number).toBeGreaterThanOrEqual(top);
        expect(shownLabels(option)).toEqual(["rsZero", "rs657452"]);
    });

    it("refuses a block with no chromosome channel", () => {
        const problem = deriveChartOption(block({ x: "cum_pos", y: "pvalue" }), ROWS, undefined, {}, OPTS)._unsafeUnwrapErr();
        expect(problem.detail).toBe('The manhattan chart needs a column for the "group" channel.');
    });

    it("derives the same bytes two times", () => {
        expect(JSON.stringify(derive())).toBe(JSON.stringify(derive()));
    });
});

/** The lengths of the chromosomes of GRCh37 in megabases, from chromosome 1 to chromosome 22. */
const GRCH37_MB = [249, 243, 198, 191, 181, 171, 159, 146, 141, 136, 135, 134, 115, 107, 103, 90, 81, 78, 59, 63, 48, 51];

/**
 * The lead variants of the BMI GWAS of the GIANT consortium (Locke 2015) with their p, at their place on their
 * chromosome in megabases.
 */
const BMI_LEADS: ReadonlyArray<readonly [number, string, number, string]> = [
    [1, "rs543874", 177.9, "2.287e-40"],
    [2, "rs13021737", 0.6, "5.439e-54"],
    [3, "rs1516725", 186.1, "1.394e-24"],
    [4, "rs13130484", 45.2, "8.011e-41"],
    [6, "rs943005", 50.9, "4.524e-31"],
    [11, "rs11030104", 27.7, "6.658e-30"],
    [12, "rs7138803", 49.9, "5.115e-26"],
    [16, "rs1421085", 53.8, "2.17e-158"],
    [18, "rs6567160", 60.2, "6.684e-59"],
    [19, "rs11672660", 45.7, "7.911e-19"],
];

/**
 * An excerpt of the BMI GWAS in genome order: each chromosome ends with a null variant at each end, and each
 * lead stands over a column of weaker variants at its place, as a peak of the whole table does.
 */
function bmiExcerpt(): ChartRow[] {
    const rows: ChartRow[] = [];
    let start = 0;
    for (const [index, length] of GRCH37_MB.entries()) {
        const chrom = String(index + 1);
        const place = (mb: number): string => String(Math.round((start + mb) * 1e6));
        rows.push({ chrom, snp: `${chrom}-start`, pvalue: "0.5", cum_pos: place(0.5) });
        for (const [leadChrom, snp, mb, pvalue] of BMI_LEADS) {
            if (leadChrom !== index + 1) continue;
            rows.push({ chrom, snp, pvalue, cum_pos: place(mb) });
            for (const share of [0.8, 0.6, 0.4, 0.2]) {
                rows.push({ chrom, snp: `${snp}-${share}`, pvalue: String(Math.pow(Number(pvalue), share)), cum_pos: place(mb + share / 10) });
            }
        }
        rows.push({ chrom, snp: `${chrom}-end`, pvalue: "0.5", cum_pos: place(length - 0.5) });
        start += length;
    }
    return rows;
}

describe("the Manhattan text at each size", () => {
    const rows = bmiExcerpt();
    const option = derive(block(), rows);
    const x = option.xAxis as EchartOption;
    const plot = { x: { min: x.min as number, max: x.max as number }, y: { min: 0, max: asTop(option) } };

    /** The page option, and the export option of each export size, with the frame where its text places. */
    const renders: Array<readonly [string, EchartOption, NameFrame]> = [
        ["page", option, PAGE_PLOT_FRAME],
        ...Object.entries(CHART_EXPORT_SIZES).map(
            ([kind, size]) =>
                [kind, exportOption(option, size.textPx, size.widthPx, size.heightPx), EXPORT_PLOT_FRAMES[kind as keyof typeof CHART_EXPORT_SIZES]] as const,
        ),
    ];

    function dataOf(render: EchartOption, name: string): EchartOption[] {
        return (seriesOf(render).find((entry) => entry.name === name)?.data ?? []) as EchartOption[];
    }

    for (const [kind, render, frame] of renders) {
        it(`prints no lead name over another lead name at the ${kind} size`, () => {
            const boxes = dataOf(render, POINT_NAMES).map((item) => {
                const [nameX, nameY] = item.value as number[];
                const placed: LeaderName = { x: nameX, y: nameY, side: (item.label as EchartOption).position as LeaderName["side"] };
                return leaderNameBox(placed, String(item.name), plot, frame);
            });
            expect(boxes.length).toBeGreaterThan(0);
            for (const [index, box] of boxes.entries()) {
                for (const other of boxes.slice(index + 1)) expect(overlaps(box, other)).toBe(false);
            }
        });

        it(`prints no chromosome name over another chromosome name at the ${kind} size`, () => {
            const toPx = (value: number): number => ((value - plot.x.min) / (plot.x.max - plot.x.min)) * frame.widthPx;
            const spans = dataOf(render, "Chromosome names").map((item) => {
                const middle = toPx((item.value as number[])[0]);
                const half = textWidthPx(String(item.name), frame.textPx) / 2;
                return [middle - half, middle + half] as const;
            });
            expect(spans.length).toBeGreaterThan(0);
            for (const [index, [start]] of spans.entries()) {
                if (index > 0) expect(start - spans[index - 1][1]).toBeGreaterThanOrEqual(MANHATTAN_NAME_GAP_SHARE * frame.textPx);
            }
        });
    }

    it("prints fewer names at the single column than at the double column", () => {
        const [, single] = renders.find(([kind]) => kind === "single") ?? [];
        const [, double] = renders.find(([kind]) => kind === "double") ?? [];
        expect(dataOf(single ?? {}, "Chromosome names").length).toBeLessThan(dataOf(double ?? {}, "Chromosome names").length);
        expect(dataOf(single ?? {}, POINT_NAMES).length).toBeLessThan(dataOf(double ?? {}, POINT_NAMES).length);
    });
});

describe("the dense Manhattan plot", () => {
    const COLUMNS = ["chrom", "snp", "pvalue", "cum_pos"];

    function denseRows(count: number): ChartRow[] {
        const rows: ChartRow[] = [];
        for (let index = 0; index < count; index += 1) {
            rows.push({
                chrom: String(1 + Math.floor((index * 22) / count)),
                snp: `rs${index}`,
                pvalue: String(Math.pow(10, -((index * 13) % 90) / 10)),
                cum_pos: String(index * 1000),
            });
        }
        return rows;
    }

    const seriesDataOnThePage = new Function(`${CHART_SERIES_BUILDER}\nreturn reportSeriesData;`)() as (
        payload: { columns: string[]; rows: ChartRow[] },
        source: ChartDataSource["series"][number],
        rule: unknown,
    ) => unknown[];

    it("reads the payload past the bound, and the page builds each chromosome as the server does", () => {
        const rows = denseRows(20000);
        const render = deriveChartRender(block(), rows, COLUMNS, { key: "gw", columns: COLUMNS }, {}, OPTS)._unsafeUnwrap();
        expect(JSON.stringify(render.inline).length).toBeGreaterThan(CHART_INLINE_OPTION_BOUND);
        expect(render.readsPayload).toBe(true);
        const source = render.option[CHART_SOURCE_MEMBER] as ChartDataSource;
        expect(source.series.length).toBe(22);
        for (const [index, entry] of source.series.entries()) {
            const page = seriesDataOnThePage({ columns: COLUMNS, rows }, entry, source.rule);
            expect(JSON.stringify(page)).toBe(JSON.stringify(seriesOf(render.inline)[index].data));
        }
        // The chromosome names ride the page option after the points, thus the page draws them over the payload points.
        const names = seriesOf(render.option)[22];
        expect((names.data as unknown[]).length).toBe(22);
    });
});
