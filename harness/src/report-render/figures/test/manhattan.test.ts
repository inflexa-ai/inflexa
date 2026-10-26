/**
 * The Manhattan figure: the chromosomes in two alternating colors, the chromosome names under the middle of
 * their points, the genome-wide and the suggestive lines, and the names of the lead variants.
 */

import { textOf } from "../../../lib/unknown-text.js";
import { parseUnknownRecord } from "../../../lib/unknown-containers.js";
import { describe, expect, it } from "bun:test";
import { isAllDigits } from "../../../lib/text.js";
import * as echarts from "echarts";

import type { ChartBlock } from "../../../contracts/report-blocks.js";
import { deriveChartOption, deriveChartRender, type ChartOpts, type ChartRow, type EchartOption } from "../../chart.js";
import { exportOption } from "../../chart-renderers.js";
import { CHART_TOOLBOX_SOURCE, pageChartOption } from "../../chart-toolbox.js";
import { CHART_EXPORT_SIZES, CHART_INLINE_OPTION_BOUND } from "../../design.js";
import { CHART_SERIES_BUILDER } from "../../page.js";
import { BELOW_RESOLUTION_SYMBOL, POINT_NAMES } from "../dense.js";
import { FIGURE_MODULES } from "../index.js";
import { EXPORT_PLOT_FRAMES, leaderNameBox, overlaps, PAGE_PLOT_FRAME, textWidthPx, type LeaderName, type NameFrame } from "../label-room.js";
import { guideLabelBox, MANHATTAN_COLORS, MANHATTAN_FIGURE, MANHATTAN_LABEL_COUNT, MANHATTAN_NAME_GAP_SHARE, MANHATTAN_SUGGESTIVE_P } from "../manhattan.js";
import {
    chartSourceOf,
    markLineData,
    optionArray,
    optionAt,
    optionList,
    optionNumber,
    optionNumbers,
    optionOf,
    optionPair,
    optionPairRows,
    optionsOf,
    pageCall,
    seriesOf,
} from "../../test/options.js";

const LABEL_SIDES = ["right", "left", "top"] as const satisfies readonly LeaderName["side"][];

/** The label side that one placed name carries, or a failed test. */
function labelSide(label: EchartOption): LeaderName["side"] {
    const side = LABEL_SIDES.find((candidate) => candidate === label.position);
    if (side === undefined) throw new Error(`a name label carries the position ${textOf(label.position)}`);
    return side;
}

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

function firstOf<T>(items: readonly T[], label: string): T {
    const [first] = items;
    if (first === undefined) throw new Error(`no ${label}`);
    return first;
}

/** The upper end of the y axis of one option. */
function asTop(option: EchartOption): number {
    return optionNumber(optionAt(option, "yAxis").max);
}

describe("the Manhattan figure", () => {
    it("registers in the figure registry", () => {
        expect(FIGURE_MODULES.manhattan).toBe(MANHATTAN_FIGURE);
    });

    it("draws one series for each chromosome in two alternating colors, with no legend", () => {
        const option = derive();
        const series = seriesOf(option).slice(0, 3);
        expect(series.map((entry) => entry.name)).toEqual(["1", "2", "3"]);
        expect(series.map((entry) => optionAt(entry, "itemStyle").color)).toEqual([MANHATTAN_COLORS[0], MANHATTAN_COLORS[1], MANHATTAN_COLORS[0]]);
        expect(option.legend).toEqual({ show: false });
    });

    it("names each chromosome under the middle of its points, and hides the position ticks", () => {
        const option = derive();
        const names = seriesOf(option)[3];
        if (names === undefined) throw new Error("the option holds no chromosome-name series");
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
        const x = optionAt(option, "xAxis");
        expect(x.min).toBe(1082207);
        expect(x.max).toBe(689000000);
        expect(optionAt(x, "axisLabel").show).toBe(false);
        expect(optionAt(option, "yAxis").min).toBe(0);
    });

    it("draws the genome-wide line with its label and the suggestive line", () => {
        const lines = seriesOf(derive())
            .filter((entry) => entry.name !== POINT_NAMES)
            .flatMap((entry) => markLineData(entry));
        expect(MANHATTAN_SUGGESTIVE_P).toBe(1e-5);
        expect(lines.map((line) => [optionOf(line).yAxis, optionAt(optionOf(line), "label").formatter])).toEqual([
            [-Math.log10(5e-8), "p 5 × 10⁻⁸"],
            [-Math.log10(1e-5), undefined],
        ]);
        // The label sits over the line at its right end, inside the plot and clear of the chromosome names
        // under the axis.
        const genomeLine = lines[0];
        if (genomeLine === undefined) throw new Error("the genome-wide line drew no mark");
        expect(optionAt(optionOf(genomeLine), "label").position).toBe("insideEndTop");
    });

    it("keeps the name of a lead variant at the right end clear of the label of the genome-wide line", () => {
        const high = 689000000;
        const rows = [...ROWS, { chrom: "3", snp: "rs99", pvalue: "1e-8", cum_pos: String(high - 1000000) }];
        const option = derive(block(), rows);
        const names = seriesOf(option).find((entry) => entry.name === POINT_NAMES);
        const lead = optionsOf(names?.data ?? []).find((item) => item.name === "rs99");
        if (lead === undefined) throw new Error("the lead rs99 drew no point");
        // The page frame reads a window 1280 pixels wide, thus the runtime hides a lead name that still overlaps
        // another on a narrower window.
        expect(names?.labelLayout).toEqual({ hideOverlap: true });
        const [x, y] = optionPair(lead.value);
        const box = guideLabelBox(-Math.log10(5e-8), { min: 1082207, max: high }, asTop(option), "p 5 × 10⁻⁸", PAGE_PLOT_FRAME);
        expect(x >= box.left && x <= box.right && y >= box.bottom && y <= box.top).toBe(false);
    });

    /** The names of the lead variants, in the order of their p. */
    function shownLabels(option: EchartOption): unknown[] {
        const names = seriesOf(option).find((entry) => entry.name === POINT_NAMES);
        return optionsOf(names?.data ?? []).map((item) => item.name);
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
            optionArray(optionOf(seriesOf(option).find((entry) => entry.name === "Chromosome names")), "data").map((entry) => entry.name);
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
            expect(optionList(points.data).some((item) => parseUnknownRecord(item)?.label !== undefined)).toBe(false);
        }
    });

    it("places each lead name over its peak where the axis holds the room, with a leader line to its point", () => {
        // A variant with no name lifts the p axis to 20, thus each named peak has room above it.
        const rows = [...ROWS, { chrom: "3", snp: "", pvalue: "1e-19", cum_pos: "500000000" }];
        const names = optionOf(seriesOf(derive(block(), rows)).find((entry) => entry.name === POINT_NAMES));
        const items = optionArray(names, "data");
        expect(items.map((item) => optionAt(item, "label").position)).toEqual(["top", "top"]);
        const leaders = optionPairRows(optionAt(names, "markLine").data);
        expect(leaders.map((pair) => pair[0].coord)).toEqual([
            [274000000, -Math.log10(4.4e-15)],
            [49124175, -Math.log10(2.123e-13)],
        ]);
        // `value` is `unknown` in the echarts option type; the equality below is the check of the numbers.
        expect(leaders.map((pair) => pair[1].coord)).toEqual(items.map((item) => optionNumbers(item.value)));
    });

    it("places the name of a peak at the top of the axis beside the peak", () => {
        const names = optionOf(seriesOf(derive()).find((entry) => entry.name === POINT_NAMES));
        // The tallest peak reaches the end of the p axis, thus its name finds no room over it.
        const [tallest] = optionArray(names, "data");
        if (tallest === undefined) throw new Error("the option holds no lead name");
        expect(optionAt(tallest, "label").position).toBe("right");
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
                    .map((entry): [string, unknown] => [textOf(entry.name), optionAt(entry, "itemStyle").color]),
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
        const names = optionArray(optionOf(seriesOf(option).find((entry) => entry.name === "Chromosome names")), "data").map((entry) => entry.name);
        expect(names).toEqual(["1", "2", "10", "X", "Y", "MT", "Un"]);
        const colors = Object.fromEntries(
            seriesOf(option)
                .slice(0, 7)
                .map((entry): [string, unknown] => [textOf(entry.name), optionAt(entry, "itemStyle").color]),
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
        expect(firstOf(triangles, "triangle").data).toEqual([{ name: "rsZero", value: [300000001, top], itemStyle: { color: MANHATTAN_COLORS[1] } }]);
        expect(optionNumber(optionAt(option, "yAxis").max)).toBeGreaterThanOrEqual(top);
        expect(shownLabels(option)).toEqual(["rsZero", "rs657452"]);
    });

    it("colors a stored zero with no chromosome cell in the first chromosome color", () => {
        const rows = [...ROWS, { snp: "rsNoChrom", pvalue: "0", cum_pos: "300000001" }];
        const triangles = seriesOf(derive(block(), rows)).filter((entry) => entry.symbol === BELOW_RESOLUTION_SYMBOL);
        expect(firstOf(triangles, "triangle").data).toEqual([
            { name: "rsNoChrom", value: [300000001, -Math.log10(4.4e-15)], itemStyle: { color: MANHATTAN_COLORS[0] } },
        ]);
    });

    it("leads a chromosome of two stored zeros by the smaller position, whatever the row order", () => {
        const zeros: ChartRow[] = [
            { chrom: "3", snp: "rsFar", pvalue: "0", cum_pos: "600000000" },
            { chrom: "3", snp: "rsNear", pvalue: "0", cum_pos: "500000000" },
        ];
        for (const order of [zeros, [...zeros].reverse()]) {
            const labels = shownLabels(derive(block(), [...ROWS, ...order]));
            expect(labels).toContain("rsNear");
            expect(labels).not.toContain("rsFar");
        }
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
    const x = optionAt(option, "xAxis");
    const plot = { x: { min: optionNumber(x.min), max: optionNumber(x.max) }, y: { min: 0, max: asTop(option) } };

    /** The export sizes under test, in the order of the table. */
    const EXPORT_KINDS = ["single", "double", "slide"] as const satisfies readonly (keyof typeof CHART_EXPORT_SIZES)[];

    /** The page option, and the export option of each export size, with the frame where its text places. */
    const renders: Array<readonly [string, EchartOption, NameFrame]> = [
        ["page", option, PAGE_PLOT_FRAME],
        ...EXPORT_KINDS.map(
            (kind) =>
                [
                    kind,
                    exportOption(option, CHART_EXPORT_SIZES[kind].textPx, CHART_EXPORT_SIZES[kind].widthPx, CHART_EXPORT_SIZES[kind].heightPx),
                    EXPORT_PLOT_FRAMES[kind],
                ] as const,
        ),
    ];

    function dataOf(render: EchartOption, name: string): EchartOption[] {
        return optionsOf(seriesOf(render).find((entry) => entry.name === name)?.data ?? []);
    }

    for (const [kind, render, frame] of renders) {
        it(`prints no lead name over another lead name at the ${kind} size`, () => {
            const boxes = dataOf(render, POINT_NAMES).map((item) => {
                const [nameX, nameY] = optionPair(item.value);
                const placed: LeaderName = { x: nameX, y: nameY, side: labelSide(optionAt(item, "label")) };
                return leaderNameBox(placed, textOf(item.name), plot, frame);
            });
            expect(boxes.length).toBeGreaterThan(0);
            for (const [index, box] of boxes.entries()) {
                for (const other of boxes.slice(index + 1)) expect(overlaps(box, other)).toBe(false);
            }
        });

        it(`prints no chromosome name over another chromosome name at the ${kind} size`, () => {
            const toPx = (value: number): number => ((value - plot.x.min) / (plot.x.max - plot.x.min)) * frame.widthPx;
            const spans = dataOf(render, "Chromosome names").map((item) => {
                const middle = toPx(optionPair(item.value)[0]);
                const half = textWidthPx(textOf(item.name), frame.textPx) / 2;
                return [middle - half, middle + half] as const;
            });
            expect(spans.length).toBeGreaterThan(0);
            for (const [index, [start]] of spans.entries()) {
                if (index > 0) {
                    const previous = spans[index - 1];
                    if (previous === undefined) throw new Error("the spans list lost an entry");
                    expect(start - previous[1]).toBeGreaterThanOrEqual(MANHATTAN_NAME_GAP_SHARE * frame.textPx);
                }
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

    const seriesDataOnThePage = pageCall(CHART_SERIES_BUILDER, "reportSeriesData");

    it("reads the payload past the bound, and the page builds each chromosome as the server does", () => {
        const rows = denseRows(20000);
        const render = deriveChartRender(block(), rows, COLUMNS, { key: "gw", columns: COLUMNS }, {}, OPTS)._unsafeUnwrap();
        expect(JSON.stringify(render.inline).length).toBeGreaterThan(CHART_INLINE_OPTION_BOUND);
        expect(render.readsPayload).toBe(true);
        const source = chartSourceOf(render.option);
        expect(source.series.length).toBe(22);
        for (const [index, entry] of source.series.entries()) {
            const page = seriesDataOnThePage({ columns: COLUMNS, rows }, entry, source.rule);
            expect(JSON.stringify(page)).toBe(JSON.stringify(seriesOf(render.inline)[index]?.data));
        }
        // The chromosome names ride the page option after the points, thus the page draws them over the payload points.
        const names = seriesOf(render.option)[22];
        if (names === undefined) throw new Error("the option holds no chromosome-name series");
        expect(optionList(names.data).length).toBe(22);
    });
});

describe("the Manhattan chromosome names after a zoom of the page toolbox", () => {
    /** The ids that the chart runtime gives the zoom components of the toolbox for the first x axis and the first y axis. */
    const ZOOM_IDS = { x: "\0_ec_\0toolbox-dataZoom_xAxis0", y: "\0_ec_\0toolbox-dataZoom_yAxis0" } as const;

    /** The page functions of the bootstrap: the binding of each named page function, and the zoom handler that the bootstrap attaches after the init. */
    const page = {
        bind: pageCall(CHART_TOOLBOX_SOURCE, "reportBindToolbox"),
        watch: pageCall(CHART_TOOLBOX_SOURCE, "reportWatchZoom"),
    };

    /** A zoom window in data units, as a box select of the toolbox gives it. */
    type ZoomWindow = {
        readonly x: readonly [number, number];
        readonly y: readonly [number, number];
    };

    /**
     * One act of the reader on the toolbox: a box select, the undo of the zoom to the full range, as the last undo of
     * the zoom history gives it, or the restore.
     */
    type Step = ZoomWindow | "undo" | "restore";

    /** The texts that the page chart draws under its plot and to the left of its plot, inside the window. */
    type PlotTexts = {
        readonly under: string[];
        readonly left: string[];
    };

    /**
     * The texts that the page chart draws after the steps of the reader. The chart reads the page option as the
     * bootstrap binds it, the bootstrap attaches the zoom handler, and a zoom goes through the zoom components of
     * the toolbox, as a box select does.
     */
    function textsAfter(steps: readonly Step[]): PlotTexts {
        const option = pageChartOption(derive(), "manhattan");
        page.bind(option);
        const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 900, height: 400 });
        try {
            page.watch(chart, option);
            chart.setOption(option);
            const x = optionAt(option, "xAxis");
            const full: ZoomWindow = { x: [optionNumber(x.min), optionNumber(x.max)], y: [0, asTop(option)] };
            let window = full;
            for (const step of steps) {
                if (step === "restore") {
                    chart.dispatchAction({ type: "restore" });
                    window = full;
                } else if (step === "undo") {
                    chart.dispatchAction({
                        type: "dataZoom",
                        batch: [
                            { dataZoomId: ZOOM_IDS.x, start: 0, end: 100 },
                            { dataZoomId: ZOOM_IDS.y, start: 0, end: 100 },
                        ],
                    });
                    window = full;
                } else {
                    chart.dispatchAction({
                        type: "dataZoom",
                        batch: [
                            { dataZoomId: ZOOM_IDS.x, startValue: step.x[0], endValue: step.x[1] },
                            { dataZoomId: ZOOM_IDS.y, startValue: step.y[0], endValue: step.y[1] },
                        ],
                    });
                    window = step;
                }
            }
            const [left, bottom] = chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [window.x[0], window.y[0]]);
            const [right, top] = chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [window.x[1], window.y[1]]);
            if (left === undefined || bottom === undefined || right === undefined || top === undefined) throw new Error("the chart gave no pixel window");
            const texts: PlotTexts = { under: [], left: [] };
            for (const element of chart.getZr().storage.getDisplayList(true)) {
                const text: unknown = Reflect.get(element.style, "text");
                if (typeof text !== "string" || element.invisible) continue;
                const box = element.getBoundingRect().clone();
                box.applyTransform(element.getComputedTransform());
                const [middleX, middleY] = [box.x + box.width / 2, box.y + box.height / 2];
                if (box.y >= bottom && middleX >= left && middleX <= right) texts.under.push(text);
                if (box.x + box.width <= left && middleY >= top && middleY <= bottom) texts.left.push(text);
            }
            return texts;
        } finally {
            chart.dispose();
        }
    }

    /** A text that names chromosome 2, bare or with a `chr` prefix, alone or before a position. */
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the chromosome-2 text form, bare or with a chr prefix, that the axis labels spell
    const CHROMOSOME_TWO = /^\s*(chr)?2(?!([\d.,]))/i;

    /** A text of a genome position on the x axis. */
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the genome position line of the x axis, whose shape is a pattern
    const POSITION = /^chr\w+: [\d.]+ Mb$/;

    it("draws the chromosome names under the plot before a zoom", () => {
        const { under } = textsAfter([]);
        expect(under).toContain("1");
        expect(under).toContain("2");
        expect(under).toContain("3");
        expect(under.filter((text) => POSITION.test(text))).toEqual([]);
    });

    // Chromosome 2 spans 249.1 to 491 Mb, and its middle sits at 370.05 Mb. The p axis starts at 0, and the peak of
    // chromosome 2 rises to 14.4.
    const windows: ReadonlyArray<readonly [string, ZoomWindow]> = [
        ["a box that holds the middle of chromosome 2 and the floor of the p axis", { x: [100e6, 600e6], y: [0, 15] }],
        ["a box over the floor of the p axis, across the chromosomes", { x: [100e6, 600e6], y: [5, 15] }],
        ["a box inside chromosome 2, away from its middle, down to the floor of the p axis", { x: [255e6, 300e6], y: [0, 15] }],
        ["a box inside chromosome 2, away from its middle, over the floor of the p axis", { x: [255e6, 300e6], y: [5, 15] }],
    ];
    for (const [description, window] of windows) {
        it(`names chromosome 2 under the plot after a zoom to ${description}`, () => {
            expect(textsAfter([window]).under.filter((text) => CHROMOSOME_TWO.test(text)).length).toBeGreaterThan(0);
        });
    }

    it("prints each round position of a zoomed x axis as the chromosome and the megabases from its start, in place of the chromosome names", () => {
        // Chromosome 2 starts at the last drawn position of chromosome 1, 248.9 Mb, and chromosome 3 starts at 491 Mb.
        const { under } = textsAfter([{ x: [100e6, 600e6], y: [0, 15] }]);
        expect(under.filter((text) => POSITION.test(text))).toEqual(["chr1: 200 Mb", "chr2: 51.1 Mb", "chr2: 151.1 Mb", "chr3: 9 Mb"]);
        expect(under.filter((text) => text.length === 1 && isAllDigits(text))).toEqual([]);
    });

    it("draws the chromosome names again and hides the positions after the undo of the zoom", () => {
        const { under } = textsAfter([{ x: [255e6, 300e6], y: [5, 15] }, "undo"]);
        expect(under).toContain("1");
        expect(under).toContain("2");
        expect(under).toContain("3");
        expect(under.filter((text) => POSITION.test(text))).toEqual([]);
    });

    it("draws the chromosome names after the restore of the toolbox, and prints the positions again at the next zoom", () => {
        const zoom: ZoomWindow = { x: [255e6, 300e6], y: [5, 15] };
        const restored = textsAfter([zoom, "restore"]).under;
        expect(restored).toContain("1");
        expect(restored).toContain("2");
        expect(restored).toContain("3");
        expect(restored.filter((text) => POSITION.test(text))).toEqual([]);
        expect(textsAfter([zoom, "restore", zoom]).under.filter((text) => POSITION.test(text)).length).toBeGreaterThan(0);
    });

    it("prints no end of the box on a zoomed value axis, and prints the ends of the full range again after the undo", () => {
        // The zoom fixes the ends of the p axis to the ends of the box, and the runtime prints each end as a label.
        const zoomed = textsAfter([{ x: [100e6, 600e6], y: [5.3, 12.7] }]).left;
        expect(zoomed.length).toBeGreaterThan(0);
        expect(zoomed).not.toContain("5.3");
        expect(zoomed).not.toContain("12.7");
        const full = textsAfter([{ x: [100e6, 600e6], y: [5.3, 12.7] }, "undo"]).left;
        expect(full).toContain("0");
        expect(full).toContain(String(asTop(derive())));
    });
});
