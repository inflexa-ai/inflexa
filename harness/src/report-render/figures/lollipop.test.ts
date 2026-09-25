/**
 * The lollipop figure: the stems, the heads, the domain band from the track, the axis length, and the three
 * labels. The rows are an excerpt of the DNMT3A tables of the gallery.
 */

import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import { deriveChartOption, type ChartInputs, type ChartRow, type EchartOption } from "../chart.js";
import { STEM_RENDERER } from "../chart-renderers.js";
import { firstFreeLanes } from "./common.js";
import { ALTERATION_CLASS_COLORS } from "./oncoprint.js";

type Encoding = NonNullable<ChartBlock["encoding"]>;

const HASH = `sha256:${"a".repeat(64)}`;

const ENCODING: Encoding = { x: "aa_position", y: "count", group: "variant_classification", label: "protein_change" };

const TRACK: NonNullable<ChartBlock["track"]> = {
    binding: { kind: "artifact-table", path: "domains_DNMT3A.csv", hash: HASH },
    start: "start",
    end: "end",
    label: "name",
    length: "protein_length",
};

function lollipop(encoding: Encoding = ENCODING, extra: Partial<ChartBlock> = { track: TRACK }): ChartBlock {
    return {
        kind: "chart",
        id: "lolli",
        binding: { kind: "artifact-table", path: "lollipop_DNMT3A.csv", hash: HASH },
        chartType: "lollipop",
        encoding,
        ...extra,
    };
}

const ROWS: ChartRow[] = [
    { aa_position: 320, protein_change: "p.R320*", variant_classification: "Nonsense_Mutation", count: 1 },
    { aa_position: 736, protein_change: "p.R736H", variant_classification: "Missense_Mutation", count: 2 },
    { aa_position: 882, protein_change: "p.R882C", variant_classification: "Missense_Mutation", count: 7 },
    { aa_position: 882, protein_change: "p.R882H", variant_classification: "Missense_Mutation", count: 19 },
    { aa_position: 882, protein_change: "p.R882P", variant_classification: "Missense_Mutation", count: 1 },
    { aa_position: 590, protein_change: "p.G590fs", variant_classification: "Frame_Shift_Del", count: 1 },
];

/** The domains: two that overlap, thus they take two lanes of the band. */
const DOMAINS: ChartRow[] = [
    { start: 199, end: 403, name: "Interaction with DNMT1 and DNMT3B", protein_length: 912 },
    { start: 292, end: 350, name: "PWWP", protein_length: 912 },
    { start: 634, end: 912, name: "SAM-dependent MTase C5-type", protein_length: 912 },
];

const INPUTS: ChartInputs = { track: { rows: DOMAINS, columns: ["start", "end", "name", "protein_length"] } };

function derive(block: ChartBlock = lollipop(), inputs: ChartInputs = INPUTS, rows: ChartRow[] = ROWS): EchartOption {
    return deriveChartOption(block, rows, undefined, inputs)._unsafeUnwrap();
}

function seriesOf(option: EchartOption): EchartOption[] {
    return option.series as EchartOption[];
}

function stemSeries(option: EchartOption): EchartOption[] {
    return seriesOf(option).filter((entry) => entry.renderItem === STEM_RENDERER);
}

function axisList(option: EchartOption, key: "xAxis" | "yAxis"): EchartOption[] {
    const axes = option[key];
    return Array.isArray(axes) ? (axes as EchartOption[]) : [axes as EchartOption];
}

/** The mark areas of the band: each one as its two corners. */
function bandAreas(option: EchartOption): Array<[EchartOption, EchartOption]> {
    const carrier = seriesOf(option).find((entry) => entry.markArea !== undefined);
    return ((carrier?.markArea as EchartOption | undefined)?.data ?? []) as Array<[EchartOption, EchartOption]>;
}

describe("the lollipop figure", () => {
    it("draws one stem for each row through the stem renderer, one series for each class in its class color", () => {
        const option = derive();
        const stems = stemSeries(option);
        expect(stems.map((entry) => entry.name)).toEqual(["Missense Mutation", "Nonsense Mutation", "Frame Shift Del"]);
        expect(stems.map((entry) => (entry.itemStyle as EchartOption).color)).toEqual([
            ALTERATION_CLASS_COLORS.Missense_Mutation,
            ALTERATION_CLASS_COLORS.Nonsense_Mutation,
            ALTERATION_CLASS_COLORS.Frame_Shift_Del,
        ]);
        const missense = (stems[0].data as Array<{ value: number[] }>).map((item) => item.value);
        // The largest count draws first, thus a smaller head at one position draws over the stem of a larger one.
        expect(missense).toEqual([
            [882, 19],
            [882, 7],
            [736, 2],
            [882, 1],
        ]);
    });

    it("starts the count axis at zero with whole counts", () => {
        const counts = axisList(derive(), "yAxis")[0];
        expect(counts).toEqual(expect.objectContaining({ type: "value", min: 0, minInterval: 1, name: "Mutations" }));
    });

    it("spans the x axis from zero to the length column of the track", () => {
        for (const axis of axisList(derive(), "xAxis")) {
            expect(axis).toEqual(expect.objectContaining({ type: "value", min: 0, max: 912 }));
        }
    });

    it("spans the x axis to the largest end or position where the track names no length", () => {
        const { length: _length, ...noLength } = TRACK;
        const option = derive(lollipop(ENCODING, { track: noLength }));
        expect(axisList(option, "xAxis")[0]).toEqual(expect.objectContaining({ min: 0, max: 912 }));
        const bare = derive(lollipop(ENCODING, {}), {});
        expect(axisList(bare, "xAxis")[0]).toEqual(expect.objectContaining({ min: 0, max: 882 }));
    });

    it("spans the x axis past the length column to a position that passes it", () => {
        const isoform = { track: { rows: [{ start: 100, end: 400, name: "PWWP", protein_length: 600 }] } };
        for (const axis of axisList(derive(lollipop(), isoform), "xAxis")) {
            expect(axis).toEqual(expect.objectContaining({ min: 0, max: 882 }));
        }
    });

    it("draws each domain as a labeled box on a band under the axis, overlaps in separate lanes", () => {
        const option = derive();
        const grids = option.grid as EchartOption[];
        expect(grids).toHaveLength(2);
        const areas = bandAreas(option);
        // The backbone of the protein draws first, then each domain.
        expect(areas.map(([from, to]) => [from.xAxis, to.xAxis])).toEqual([
            [0, 912],
            [199, 403],
            [292, 350],
            [634, 912],
        ]);
        const lanes = areas.slice(1).map(([from]) => from.yAxis as number);
        expect(lanes[0]).not.toBe(lanes[1]);
        expect(lanes[2]).toBe(lanes[0]);
        expect(areas[3][0].name).toBe("SAM-dependent MTase C5-type");
        expect((areas[3][0].label as EchartOption).formatter).toMatch(/^SAM-dependent/);
        // The band axis carries the position title, and the stem axis above it carries no tick label.
        const [stemAxis, bandAxis] = axisList(option, "xAxis");
        expect(stemAxis.axisLabel).toEqual(expect.objectContaining({ show: false }));
        expect(bandAxis).toEqual(expect.objectContaining({ gridIndex: 1, name: "Amino-acid position" }));
    });

    it("puts each span in the lowest lane whose last span ends before it starts, in the order of the spans", () => {
        const laneOf = firstFreeLanes(4);
        expect([laneOf(500, 600), laneOf(100, 200), laneOf(150, 700), laneOf(650, 900)]).toEqual([0, 1, 2, 0]);
    });

    it("shortens the label of a box too narrow for the whole name, and drops the label of a box too narrow for any", () => {
        const option = derive();
        const labels = bandAreas(option)
            .slice(1)
            .map(([from]) => (from.label as EchartOption).formatter);
        expect(labels[0]).toMatch(/^Interaction.*…$/);
        expect(labels[1]).toBe("PWWP");
        const tiny = derive(lollipop(), { track: { rows: [{ start: 591, end: 597, name: "Juxtamembrane", protein_length: 993 }] } });
        expect((bandAreas(tiny)[1][0].label as EchartOption).show).toBe(false);
    });

    it("labels the three largest counts with the label column", () => {
        const option = derive();
        const labels = seriesOf(option).find((entry) => entry.type === "scatter");
        expect((labels?.data as Array<{ name: string }>).map((item) => item.name)).toEqual(["p.R882H", "p.R882C", "p.R736H"]);
    });

    it("draws no stem and no label for a row with no class", () => {
        const rows = [...ROWS, { aa_position: 900, protein_change: "p.S900F", variant_classification: "", count: 50 }];
        const option = derive(lollipop(), INPUTS, rows);
        const labels = seriesOf(option).find((entry) => entry.type === "scatter");
        expect((labels?.data as Array<{ name: string }>).map((item) => item.name)).toEqual(["p.R882H", "p.R882C", "p.R736H"]);
        expect(stemSeries(option).flatMap((entry) => (entry.data as Array<{ name: string }>).map((item) => item.name))).not.toContain("p.S900F");
    });

    it("names the legend by the classes", () => {
        const legend = derive().legend as { data: Array<{ name: string; icon: string }> };
        expect(legend.data).toEqual([
            { name: "Missense Mutation", icon: "circle" },
            { name: "Nonsense Mutation", icon: "circle" },
            { name: "Frame Shift Del", icon: "circle" },
        ]);
    });

    it("draws one grid with no band where the block binds no track", () => {
        const option = derive(lollipop(ENCODING, {}), {});
        expect(Array.isArray(option.grid)).toBe(false);
        expect(bandAreas(option)).toEqual([]);
    });

    it("refuses a track whose start column the track table does not hold", () => {
        expect(deriveChartOption(lollipop(ENCODING, { track: { ...TRACK, start: "begin" } }), ROWS, undefined, INPUTS)._unsafeUnwrapErr().detail).toBe(
            'The track table holds no "begin" column.',
        );
    });

    it("refuses a domain whose end precedes its start", () => {
        const reversed = { track: { rows: [{ start: 400, end: 300, name: "PWWP", protein_length: 912 }] } };
        expect(deriveChartOption(lollipop(), ROWS, undefined, reversed)._unsafeUnwrapErr().detail).toBe(
            "The track row 1 ends at 300, before its start at 400. A domain ends at or after its start.",
        );
    });

    it("refuses a block with no count channel", () => {
        expect(deriveChartOption(lollipop({ x: "aa_position" }), ROWS, undefined, INPUTS)._unsafeUnwrapErr().detail).toBe(
            'The lollipop figure needs a column for the "y" channel.',
        );
    });

    it("refuses an order on the position channel", () => {
        expect(
            deriveChartOption(lollipop({ ...ENCODING, x: { column: "aa_position", orderBy: "count" } }), ROWS, undefined, INPUTS)._unsafeUnwrapErr().detail,
        ).toBe('The lollipop reads the "x" column as it stands, thus the channel takes no transform and no "orderBy".');
    });
});
