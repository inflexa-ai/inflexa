import { describe, expect, it } from "bun:test";

import {
    CHART_INK,
    CHART_PAGE_TEXT_PX,
    CHART_PALETTE,
    CHART_PRINT_TEXT_PX,
    CHART_SLIDE_TEXT_PX,
    CHART_THEMES,
    chartTheme,
    ECHARTS_THEME,
    ECHARTS_THEME_NAME,
    FOCUS_CHART_COLOR,
} from "./design.js";

/** The axis types of the chart runtime. A theme styles an axis by its type, and never by `xAxis` or `yAxis`. */
const AXIS_TYPES = ["categoryAxis", "valueAxis", "logAxis", "timeAxis"] as const;

function asObj(value: unknown): Record<string, unknown> {
    return value as Record<string, unknown>;
}

describe("the publication theme", () => {
    it("holds the Okabe-Ito palette, and its first hue is the focus color", () => {
        expect(ECHARTS_THEME.color).toEqual(["#0072b2", "#d55e00", "#009e73", "#e69f00", "#cc79a7", "#56b4e9", "#f0e442", "#000000"]);
        expect(ECHARTS_THEME.color).toEqual([...CHART_PALETTE]);
        expect(FOCUS_CHART_COLOR).toBe(ECHARTS_THEME.color[0]);
    });

    it("draws the left and the bottom axis lines strong and dark, with outside ticks and no split line", () => {
        for (const type of AXIS_TYPES) {
            const axis = asObj(ECHARTS_THEME[type]);
            expect(asObj(axis.axisLine).show).toBe(true);
            // A value axis frames the plot at its edge, and a category axis stands on the zero of the value axis.
            expect(asObj(axis.axisLine).onZero).toBe(type === "categoryAxis" ? undefined : false);
            expect(asObj(asObj(axis.axisLine).lineStyle)).toEqual({ color: CHART_INK, width: 1.5 });
            expect(asObj(axis.axisTick).show).toBe(true);
            expect(asObj(axis.axisTick).inside).toBe(false);
            expect(asObj(axis.splitLine).show).toBe(false);
        }
        // The chart runtime reads the axis style of a theme by the axis type alone, thus no member names an axis by place.
        expect("xAxis" in ECHARTS_THEME).toBe(false);
        expect("yAxis" in ECHARTS_THEME).toBe(false);
    });

    it("frames no legend, and names no toolbox", () => {
        const legend = asObj(ECHARTS_THEME.legend);
        expect(legend.borderWidth).toBe(0);
        expect(legend.bottom).toBe(0);
        expect("toolbox" in ECHARTS_THEME).toBe(false);
    });

    it("sets the chart text in the journal sans stack, in the near-black ink", () => {
        const text = asObj(ECHARTS_THEME.textStyle);
        // Helvetica, then Arial, then a generic sans-serif, as the design system states.
        expect(text.fontFamily).toBe("Helvetica, Arial, sans-serif");
        expect(text.color).toBe(CHART_INK);
        expect(text.fontSize).toBe(CHART_PAGE_TEXT_PX);
    });

    it("gives one theme for each text size, and each one sets the axis labels at its size", () => {
        expect(CHART_THEMES).toEqual([
            { name: ECHARTS_THEME_NAME, textPx: CHART_PAGE_TEXT_PX },
            { name: `${ECHARTS_THEME_NAME}-print`, textPx: CHART_PRINT_TEXT_PX },
            { name: `${ECHARTS_THEME_NAME}-slide`, textPx: CHART_SLIDE_TEXT_PX },
        ]);
        const slide = chartTheme(CHART_SLIDE_TEXT_PX);
        expect(asObj(asObj(slide.valueAxis).axisLabel).fontSize).toBe(CHART_SLIDE_TEXT_PX);
        expect(asObj(asObj(slide.legend).textStyle).fontSize).toBe(CHART_SLIDE_TEXT_PX);
        expect(chartTheme(CHART_PAGE_TEXT_PX)).toEqual(ECHARTS_THEME);
    });
});
