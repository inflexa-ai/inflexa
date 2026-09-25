/**
 * The shared parts of each chart: the axis builders, the guide lines, the statistics text, the color scale,
 * the size legend, the palette, and the legend icons.
 */

import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import { deriveChartOption, type ChartRow, type EchartOption } from "../chart.js";
import { CHART_PAGE_TEXT_PX, CHART_PALETTE, CHART_WIDE_PALETTE, DIVERGING_RAMP, GUIDE_LINE_COLOR, SIZE_CHANNEL_RANGE_PX } from "../design.js";
import {
    AREA_LEGEND_ICON,
    applyFigureRules,
    axisNameFields,
    categoricalPalette,
    categoryAxis,
    categoryAxisTitle,
    colorScale,
    continuousScale,
    guideLine,
    guideMarkLine,
    LINE_LEGEND_ICON,
    POINT_LEGEND_ICON,
    sizeLegend,
    statisticsGraphic,
    statisticText,
    valueAxis,
    Y_AXIS_NAME_GAP,
} from "./common.js";

const HASH = `sha256:${"a".repeat(64)}`;

/** Derive the option of one quick path. */
function derive(chartType: NonNullable<ChartBlock["chartType"]>, encoding: NonNullable<ChartBlock["encoding"]>, rows: ChartRow[]): EchartOption {
    return deriveChartOption(
        { kind: "chart", id: "c1", binding: { kind: "artifact-table", path: "t.csv", hash: HASH }, chartType, encoding },
        rows,
    )._unsafeUnwrap();
}

/** Derive the option of one composition. */
function compose(composition: NonNullable<ChartBlock["composition"]>, rows: ChartRow[]): EchartOption {
    return deriveChartOption({ kind: "chart", id: "c1", binding: { kind: "artifact-table", path: "t.csv", hash: HASH }, composition }, rows)._unsafeUnwrap();
}

describe("the axis builders", () => {
    it("turns the y title 90 degrees in the middle beside the axis, and centers the x title under the axis", () => {
        expect(axisNameFields("y", "Expression")).toEqual({ name: "Expression", nameLocation: "middle", nameRotate: 90, nameGap: Y_AXIS_NAME_GAP });
        expect(axisNameFields("x", "Time")).toEqual({ name: "Time", nameLocation: "middle", nameGap: 34 });
        expect(axisNameFields("y", undefined)).toEqual({});
    });

    it("gives a value axis a title always, and a category axis a declared title alone", () => {
        expect(valueAxis("y", "Count", { scale: true })).toEqual({ type: "value", scale: true, ...axisNameFields("y", "Count") });
        expect(valueAxis("x", "Hazard ratio", { log: true, min: 0.1, max: 10 })).toEqual({
            type: "log",
            min: 0.1,
            max: 10,
            ...axisNameFields("x", "Hazard ratio"),
        });
        expect(categoryAxis("x", ["B cells", "T cells"])).toEqual({ type: "category", data: ["B cells", "T cells"] });
        expect(categoryAxis("y", ["TP53"], { title: "Gene", topDown: true })).toEqual({
            type: "category",
            inverse: true,
            data: ["TP53"],
            ...axisNameFields("y", "Gene"),
        });
        expect(categoryAxisTitle({ cluster: "Cell type" }, "cluster")).toBe("Cell type");
        expect(categoryAxisTitle(undefined, "cluster")).toBeUndefined();
        expect(categoryAxisTitle({ cluster: "Cell type" }, "cluster", "Cluster")).toBe("Cluster");
    });
});

describe("the guide lines", () => {
    it("draws a thin gray dash, with the label inside the plot at the far end of the line", () => {
        expect(guideMarkLine([guideLine("y", 1.3, "p = 0.05")])).toEqual({
            silent: true,
            symbol: "none",
            lineStyle: { color: GUIDE_LINE_COLOR, width: 1, type: "dashed" },
            data: [{ yAxis: 1.3, label: { show: true, position: "insideEndTop", formatter: "p = 0.05", color: "#222222" } }],
        });
        expect(guideLine("x", 0)).toEqual({ xAxis: 0, label: { show: false } });
    });
});

describe("the statistics text", () => {
    const statistics = [
        { label: "Log-rank p", value: 0.0013, text: "1.3e-3" },
        { label: "HR", value: 0.53, text: "0.53" },
    ];

    it("prints one line for each statistic, in block order, at the corner that the figure names", () => {
        const [element] = statisticsGraphic(statistics, "top-right");
        expect(element).toEqual(
            expect.objectContaining({
                type: "text",
                right: "7%",
                top: "12%",
                style: expect.objectContaining({ text: "Log-rank p = 1.3e-3\nHR = 0.53", align: "right" }),
            }),
        );
        const [lower] = statisticsGraphic(statistics, "bottom-left");
        expect(lower).toEqual(expect.objectContaining({ left: "12%", bottom: "24%" }));
        expect((lower.style as EchartOption).fontSize).toBe(CHART_PAGE_TEXT_PX);
    });

    it("gives no element for a figure with no statistic", () => {
        expect(statisticsGraphic([], "top-left")).toEqual([]);
    });

    it("prints a small p-value as a power of ten, and a stored zero as the below-resolution form", () => {
        expect(statisticText(0.00131, "pvalue")).toBe("1.3 × 10⁻³");
        expect(statisticText(0, "pvalue")).toBe("≈0");
        expect(statisticText(1.1116, "lambda")).toBe("1.11");
    });
});

describe("the continuous color scale", () => {
    it("prints the title and the two ends in the form of the column, with no drag control", () => {
        const map = colorScale(continuousScale([-1.5, 0.4, 2.25]), "z-score", "z");
        expect(map).toEqual({
            min: -2.25,
            max: 2.25,
            calculable: false,
            orient: "vertical",
            right: 0,
            top: "middle",
            text: ["z-score\n2.25", "−2.25"],
            inRange: { color: [...DIVERGING_RAMP] },
        });
    });

    it("reads the declared meaning of the column, thus a p-value end prints its exponent form", () => {
        expect(colorScale(continuousScale([0.0004, 0.2]), "Adjusted p", "q", "p-value").text).toEqual(["Adjusted p\n0.2", "4 × 10⁻⁴"]);
    });
});

describe("the size legend", () => {
    it("draws three reference circles at the sizes of the size map, with the value of each one", () => {
        const legend = sizeLegend({ min: 10, max: 50 }, "Genes", "count", { right: 8, bottom: "20%" });
        expect(legend).toEqual(expect.objectContaining({ type: "group", right: 8, bottom: "20%" }));
        const children = legend.children as EchartOption[];
        const circles = children.filter((child) => child.type === "circle");
        const [small, large] = SIZE_CHANNEL_RANGE_PX;
        expect(circles.map((circle) => (circle.shape as EchartOption).r)).toEqual([small / 2, (small + large) / 4, large / 2]);
        const texts = children.filter((child) => child.type === "text").map((child) => (child.style as EchartOption).text);
        expect(texts).toEqual(["Genes", "10", "30", "50"]);
    });

    it("draws one circle for a range of one value", () => {
        const circles = (sizeLegend({ min: 5, max: 5 }, "n", "n", {}).children as EchartOption[]).filter((child) => child.type === "circle");
        expect(circles).toHaveLength(1);
    });
});

describe("the categorical palette", () => {
    it("takes the Okabe-Ito set for eight categories or fewer, and the wide palette past eight", () => {
        expect(categoricalPalette(8)).toEqual(CHART_PALETTE);
        expect(categoricalPalette(9)).toEqual(CHART_WIDE_PALETTE);
    });

    it("gives a chart of more than eight groups the wide palette, and leaves a chart of eight on the theme", () => {
        const rows = (count: number): ChartRow[] => Array.from({ length: count }, (_value, index) => ({ t: index, v: index, g: `group_${index}` }));
        expect(derive("line", { x: "t", y: "v", group: "g" }, rows(9)).color).toEqual([...CHART_WIDE_PALETTE]);
        expect(derive("line", { x: "t", y: "v", group: "g" }, rows(8)).color).toBeUndefined();
    });

    it("counts the slices of a pie, and keeps a palette that an option states", () => {
        const slices = Array.from({ length: 10 }, (_value, index) => ({ name: `s${index}`, n: index + 1 }));
        expect(derive("pie", { group: "name", value: "n" }, slices).color).toEqual([...CHART_WIDE_PALETTE]);
        const stated = { color: ["#000000"], series: Array.from({ length: 10 }, (_value, index) => ({ type: "line", name: `s${index}` })) };
        expect(applyFigureRules(stated).color).toEqual(["#000000"]);
    });
});

describe("the legend icons", () => {
    /** The icon of each legend entry of one option. */
    function icons(option: EchartOption): Record<string, unknown> {
        const data = (option.legend as EchartOption).data as EchartOption[];
        return Object.fromEntries(data.map((entry) => [entry.name, entry.icon]));
    }

    const rows: ChartRow[] = [
        { t: 1, v: 2, lo: 1, g: "a" },
        { t: 2, v: 3, lo: 2, g: "b" },
    ];

    it("gives a line and a step a line, a point a circle, and a bar a filled square", () => {
        expect(icons(derive("line", { x: "t", y: "v", group: "g" }, rows))).toEqual({ a: LINE_LEGEND_ICON, b: LINE_LEGEND_ICON });
        expect(icons(derive("scatter", { x: "t", y: "v", group: "g" }, rows))).toEqual({ a: POINT_LEGEND_ICON, b: POINT_LEGEND_ICON });
        const survival: ChartRow[] = [
            { t: 1, s: 0.9, g: "a" },
            { t: 2, s: 0.8, g: "b" },
        ];
        expect(icons(derive("km", { x: "t", y: "s", group: "g" }, survival))).toEqual({ a: LINE_LEGEND_ICON, b: LINE_LEGEND_ICON });
        expect(icons(derive("bar", { x: "t", y: "v", group: "g" }, rows))).toEqual({ a: AREA_LEGEND_ICON, b: AREA_LEGEND_ICON });
    });

    it("gives an area and a band a filled square, and reads the drawn half of a band", () => {
        const option = compose(
            {
                series: [
                    { form: "area", name: "CI", encoding: { x: "t", y: "v", y0: "lo" } },
                    { form: "line", name: "Estimate", encoding: { x: "t", y: "v" } },
                ],
            },
            rows,
        );
        expect(icons(option)).toEqual({ CI: AREA_LEGEND_ICON, Estimate: LINE_LEGEND_ICON });
    });

    it("leaves a hidden legend as it is", () => {
        expect(derive("line", { x: "t", y: "v" }, rows).legend).toEqual({ show: false });
    });
});
