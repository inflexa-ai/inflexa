/**
 * The UpSet figure: the computed set sizes and exact intersections, their order, the three aligned grids, the
 * cap on the drawn intersections, and each refusal. The rows follow the membership table of TCGA LAML in the
 * gallery: one row for each sample and each mutated gene.
 */

import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../../../contracts/report-blocks.js";
import { deriveChartOption, type ChartRow, type EchartOption } from "../../chart.js";
import { CHART_EXPORT_SIZES, CHART_INK } from "../../design.js";
import { UPSET_INTERSECTION_LIMIT, UPSET_SET_LIMIT, upsetSummary } from "../upset.js";
import { optionNumber, optionRecord, optionRecords } from "../../option-lens.js";
import { must } from "../../../lib/test/guards.js";
import { optionArray, optionNumbers, optionStrings } from "../../../report-render/option-lens.js";

type Encoding = NonNullable<ChartBlock["encoding"]>;

const HASH = `sha256:${"a".repeat(64)}`;

const ENCODING: Encoding = { x: "sample", group: "gene" };

function upset(encoding: Encoding = ENCODING): ChartBlock {
    return { kind: "chart", id: "sets", binding: { kind: "artifact-table", path: "upset_membership.csv", hash: HASH }, chartType: "upset", encoding };
}

/** The membership of one sample: one row for each gene. */
function member(sample: string, ...genes: string[]): ChartRow[] {
    return genes.map((gene) => ({ sample, gene }));
}

/**
 * Nine samples over four genes. DNMT3A holds five samples, FLT3 and NPM1 hold four each, and IDH2 holds one.
 * The IDH2 row comes first, thus the first appearance and the size order differ.
 */
const ROWS: ChartRow[] = [
    ...member("TCGA-AB-2808", "IDH2"),
    ...member("TCGA-AB-2802", "FLT3", "NPM1", "DNMT3A"),
    ...member("TCGA-AB-2803", "FLT3", "NPM1"),
    ...member("TCGA-AB-2804", "NPM1", "FLT3"),
    ...member("TCGA-AB-2805", "NPM1", "DNMT3A"),
    ...member("TCGA-AB-2806", "FLT3"),
    ...member("TCGA-AB-2807", "DNMT3A"),
    ...member("TCGA-AB-2809", "DNMT3A"),
    ...member("TCGA-AB-2810", "DNMT3A"),
];

function derive(rows: readonly ChartRow[] = ROWS, encoding: Encoding = ENCODING): EchartOption {
    return deriveChartOption(upset(encoding), rows)._unsafeUnwrap();
}

function refusal(rows: readonly ChartRow[], encoding: Encoding = ENCODING): string {
    return deriveChartOption(upset(encoding), rows)._unsafeUnwrapErr().detail;
}

function seriesById(option: EchartOption, id: string): EchartOption {
    const found = optionRecords(option.series).find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`no series ${id}`);
    return found;
}

function axesOf(option: EchartOption, key: "xAxis" | "yAxis"): EchartOption[] {
    return optionRecords(option[key]);
}

/** One element in each of `count` distinct combinations of six sets, largest combinations first. */
function manyIntersections(count: number): ChartRow[] {
    const sets = ["A", "B", "C", "D", "E", "F"];
    const rows: ChartRow[] = [];
    for (let mask = 1; mask <= count; mask += 1) {
        for (const [place, set] of sets.entries()) {
            if ((mask & (1 << place)) !== 0) rows.push({ sample: `e${mask}`, gene: set });
        }
    }
    return rows;
}

describe("the upset summary", () => {
    it("computes the size of each set, largest first, and the exact intersection of each element", () => {
        const summary = upsetSummary(ROWS, "sample", "gene")._unsafeUnwrap();
        expect(summary.sets).toEqual([
            { name: "DNMT3A", size: 5 },
            { name: "FLT3", size: 4 },
            { name: "NPM1", size: 4 },
            { name: "IDH2", size: 1 },
        ]);
        // Each element counts in one intersection alone: the exact combination of its sets.
        expect(summary.intersections.map((entry) => [entry.members.map((place) => summary.sets[place].name), entry.size])).toEqual([
            [["DNMT3A"], 3],
            [["FLT3", "NPM1"], 2],
            [["FLT3"], 1],
            [["IDH2"], 1],
            [["DNMT3A", "NPM1"], 1],
            [["DNMT3A", "FLT3", "NPM1"], 1],
        ]);
        expect(summary.intersections.reduce((sum, entry) => sum + entry.size, 0)).toBe(9);
    });

    it("ignores a row with an empty set cell, because its element is in no set", () => {
        const summary = upsetSummary([...ROWS, { sample: "TCGA-AB-2811", gene: "" }], "sample", "gene")._unsafeUnwrap();
        expect(summary.intersections.reduce((sum, entry) => sum + entry.size, 0)).toBe(9);
    });
});

/**
 * The exact intersections of the TCGA LAML membership table of the gallery: 115 samples over the six most
 * mutated genes, as the count of samples of each combination. The rows expand each count into its samples.
 */
const LAML_INTERSECTIONS: ReadonlyArray<readonly [number, readonly string[]]> = [
    [22, ["FLT3"]],
    [13, ["IDH2"]],
    [9, ["DNMT3A"]],
    [9, ["TET2"]],
    [8, ["FLT3", "NPM1"]],
    [7, ["DNMT3A", "FLT3"]],
    [7, ["DNMT3A", "NPM1"]],
    [6, ["DNMT3A", "FLT3", "NPM1"]],
    [6, ["DNMT3A", "IDH1"]],
    [4, ["DNMT3A", "IDH2"]],
    [4, ["NPM1"]],
    [4, ["IDH1", "NPM1"]],
    [2, ["DNMT3A", "TET2"]],
    [2, ["IDH1"]],
    [1, ["DNMT3A", "FLT3", "TET2"]],
    [1, ["FLT3", "IDH2"]],
    [1, ["FLT3", "NPM1", "TET2"]],
    [1, ["FLT3", "IDH1"]],
    [1, ["DNMT3A", "FLT3", "IDH1", "TET2"]],
    [1, ["DNMT3A", "FLT3", "IDH2"]],
    [1, ["DNMT3A", "FLT3", "IDH1", "NPM1"]],
    [1, ["DNMT3A", "FLT3", "NPM1", "TET2"]],
    [1, ["FLT3", "TET2"]],
    [1, ["DNMT3A", "IDH1", "NPM1"]],
    [1, ["DNMT3A", "IDH1", "TET2"]],
    [1, ["IDH1", "IDH2"]],
];

const LAML_ROWS: ChartRow[] = LAML_INTERSECTIONS.flatMap(([count, genes], place) =>
    Array.from({ length: count }, (_entry, index) => member(`TCGA-${place}-${index}`, ...genes)).flat(),
);

describe("the upset figure on the LAML membership table", () => {
    it("computes the six set sizes and the 26 exact intersections, and draws each one", () => {
        const summary = upsetSummary(LAML_ROWS, "sample", "gene")._unsafeUnwrap();
        expect(summary.sets).toEqual([
            { name: "FLT3", size: 52 },
            { name: "DNMT3A", size: 48 },
            { name: "NPM1", size: 33 },
            { name: "IDH2", size: 20 },
            { name: "IDH1", size: 18 },
            { name: "TET2", size: 17 },
        ]);
        expect(summary.intersections).toHaveLength(26);
        expect(summary.intersections.reduce((sum, entry) => sum + entry.size, 0)).toBe(115);
        const option = derive(LAML_ROWS);
        const bars = seriesById(option, "intersections");
        // SAFETY: the value is test-controlled — a fixture, a double answer, or the unit under test answering the input this test built — so the cast names a shape the test itself determines.
        expect(optionNumbers(bars.data).slice(0, 5)).toEqual([22, 13, 9, 9, 8]);
        // SAFETY: the value is test-controlled — a fixture, a double answer, or the unit under test answering the input this test built — so the cast names a shape the test itself determines.
        expect(optionStrings(axesOf(option, "xAxis")[optionNumber(bars.xAxisIndex)].data).slice(0, 5)).toEqual([
            "FLT3",
            "IDH2",
            "DNMT3A",
            "TET2",
            "FLT3 & NPM1",
        ]);
        expect(axesOf(option, "xAxis")[optionNumber(seriesById(option, "members").xAxisIndex)].name).toBeUndefined();
    });
});

describe("the upset figure", () => {
    it("draws the intersection sizes as bars on top, in the sorted order, with their counts", () => {
        const option = derive();
        const bars = seriesById(option, "intersections");
        expect(bars.type).toBe("bar");
        expect(bars.data).toEqual([3, 2, 1, 1, 1, 1]);
        expect(bars.label).toEqual(expect.objectContaining({ show: true, position: "top" }));
        expect(bars.itemStyle).toEqual({ color: CHART_INK });
        const top = axesOf(option, "xAxis")[optionNumber(bars.xAxisIndex)];
        expect(top.data).toEqual(["DNMT3A", "FLT3 & NPM1", "FLT3", "IDH2", "DNMT3A & NPM1", "DNMT3A & FLT3 & NPM1"]);
        expect(axesOf(option, "yAxis")[optionNumber(bars.yAxisIndex)].name).toBe("Intersection size");
    });

    it("draws the dot matrix: a dark dot for each member set, a light dot for each other set, and a line that joins the member dots", () => {
        const option = derive();
        const members = seriesById(option, "members");
        const absent = seriesById(option, "absent");
        const joins = seriesById(option, "joins");
        // The set axis reads the largest set at the top.
        const matrixY = axesOf(option, "yAxis")[optionNumber(members.yAxisIndex)];
        expect(matrixY).toMatchObject({ type: "category", inverse: true, data: ["DNMT3A", "FLT3", "NPM1", "IDH2"] });
        expect(members.data).toEqual([
            [0, 0],
            [1, 1],
            [1, 2],
            [2, 1],
            [3, 3],
            [4, 0],
            [4, 2],
            [5, 0],
            [5, 1],
            [5, 2],
        ]);
        expect(members.itemStyle).toEqual(expect.objectContaining({ color: CHART_INK }));
        // SAFETY: the option tree read here is the one this test built above; the cast names the member's shape inside it.
        expect(optionArray(absent.data).length).toBe(6 * 4 - 10);
        expect(optionRecord(absent.itemStyle).color).not.toBe(CHART_INK);
        // A line joins the top and the bottom member dot of each intersection of two sets or more.
        expect(joins.type).toBe("lines");
        expect(joins.data).toEqual([
            {
                coords: [
                    [1, 1],
                    [1, 2],
                ],
            },
            {
                coords: [
                    [4, 0],
                    [4, 2],
                ],
            },
            {
                coords: [
                    [5, 0],
                    [5, 2],
                ],
            },
        ]);
        // The matrix and the bars share the intersection axis.
        expect(axesOf(option, "xAxis")[optionNumber(members.xAxisIndex)].data).toEqual(
            axesOf(option, "xAxis")[optionNumber(seriesById(option, "intersections").xAxisIndex)].data,
        );
    });

    it("draws the set sizes as bars at the left, on the set axis of the matrix, growing to the left", () => {
        const option = derive();
        const sets = seriesById(option, "sets");
        expect(sets.data).toEqual([5, 4, 4, 1]);
        const valueX = axesOf(option, "xAxis")[optionNumber(sets.xAxisIndex)];
        expect(valueX).toMatchObject({ type: "value", inverse: true, name: "Set size" });
        const setY = axesOf(option, "yAxis")[optionNumber(sets.yAxisIndex)];
        expect(setY).toMatchObject({ type: "category", inverse: true, data: ["DNMT3A", "FLT3", "NPM1", "IDH2"], show: false });
        // The three grids line up: the set bars share the rows of the matrix, and the top bars share its columns.
        const grids = optionRecords(option.grid);
        const matrix = grids[optionNumber(seriesById(option, "members").xAxisIndex)];
        const left = grids[optionNumber(sets.xAxisIndex)];
        const top = grids[optionNumber(seriesById(option, "intersections").xAxisIndex)];
        expect(left.top).toBe(matrix.top);
        expect(left.bottom).toBe(matrix.bottom);
        expect(top.left).toBe(matrix.left);
        expect(top.right).toBe(matrix.right);
    });

    it("draws the largest intersections alone past the cap, and the axis title states the hidden count", () => {
        const option = derive(manyIntersections(40));
        const bars = seriesById(option, "intersections");
        // SAFETY: the option tree read here is the one this test built above; the cast names the member's shape inside it.
        expect(optionArray(bars.data)).toHaveLength(UPSET_INTERSECTION_LIMIT);
        const matrixX = axesOf(option, "xAxis")[optionNumber(seriesById(option, "members").xAxisIndex)];
        expect(matrixX.name).toBe(`Intersections: ${UPSET_INTERSECTION_LIMIT} of 40 shown`);
        expect(axesOf(option, "xAxis")[optionNumber(bars.xAxisIndex)].name).toBeUndefined();
    });

    it("states no intersection title where each intersection draws", () => {
        const option = derive();
        expect(axesOf(option, "xAxis")[optionNumber(seriesById(option, "members").xAxisIndex)].name).toBeUndefined();
    });

    it("sizes the dots for each export through one media rule for each export size", () => {
        const option = derive(manyIntersections(40));
        const media = optionRecords(option.media);
        const single = media.find((rule) => optionRecord(rule.query).maxWidth === CHART_EXPORT_SIZES.single.widthPx);
        expect(single).toBeDefined();
        const series = optionRecords(optionRecord(must(single, "the media rule").option).series);
        const place = optionRecords(option.series).findIndex((entry) => entry.id === "members");
        const pageDot = optionNumber(seriesById(option, "members").symbolSize);
        expect(optionNumber(series[place].symbolSize)).toBeLessThan(pageDot);
        expect(optionNumber(series[place].symbolSize)).toBeGreaterThan(1);
    });

    it("gives the same option for the same rows", () => {
        expect(JSON.stringify(derive())).toBe(JSON.stringify(derive()));
    });
});

describe("the upset refusals", () => {
    it("refuses a table with no rows", () => {
        expect(refusal([])).toBe("The upset figure has no rows. It needs one row for each member of each set.");
    });

    it("refuses a membership that two rows state", () => {
        expect(refusal([...ROWS, { sample: "TCGA-AB-2806", gene: "FLT3" }])).toBe(
            'The element "TCGA-AB-2806" is a member of the set "FLT3" in two rows. The table holds one row for each member of each set.',
        );
    });

    it("refuses more sets than the bound", () => {
        const rows = Array.from({ length: UPSET_SET_LIMIT + 1 }, (_entry, place) => ({ sample: `e${place}`, gene: `G${place}` }));
        expect(refusal(rows)).toBe(
            `The table names ${UPSET_SET_LIMIT + 1} sets. An upset figure draws ${UPSET_SET_LIMIT} sets at most, thus a table of fewer sets serves the reader.`,
        );
    });

    it("refuses a row that names no element", () => {
        expect(refusal([...ROWS, { sample: "", gene: "FLT3" }])).toBe('A row of the set "FLT3" names no element in the "sample" column.');
    });

    it("refuses a table whose rows name no set", () => {
        expect(refusal([{ sample: "e1", gene: "" }])).toBe('The table names no set in the "gene" column, thus the figure has no intersection to draw.');
    });

    it("refuses a block with no set channel", () => {
        expect(refusal(ROWS, { x: "sample" })).toBe('The upset figure needs a column for the "group" channel.');
    });

    it("refuses a transform or an order on a channel", () => {
        expect(refusal(ROWS, { x: { column: "sample", transform: "rank" }, group: "gene" })).toBe(
            'The upset figure reads the "x" channel as a plain column, thus it takes no transform and no order.',
        );
    });

    it("refuses a channel that it does not read", () => {
        expect(refusal(ROWS, { x: "sample", group: "gene", y: "gene" })).toBe('The upset chart takes no "y" channel.');
    });
});
