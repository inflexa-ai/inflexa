import { describe, expect, it } from "bun:test";
import * as echarts from "echarts";
import { CHART_INK } from "./design.js";

import {
    bindRenderers,
    CHART_RENDERERS_SOURCE,
    INTERVAL_CAP_PX,
    intervalRenderer,
    outlineRenderer,
    VIOLIN_GRID_POINTS,
    type RenderApi,
    type RenderedElement,
} from "./chart-renderers.js";

/** The band of one category under the stub: 20 pixels along x and 16 pixels along y. */
const BAND_X = 20;
const BAND_Y = 16;

/** The color that the stub gives for the visual color of a series. */
const SERIES_COLOR = "#0072b2";

/**
 * The stub of the chart runtime for one item.
 *
 * The coordinate map is the identity, thus an element position reads as the data value that made it. The
 * size gives one fixed band on each axis, thus an offset reads as a known count of pixels.
 */
function stubApi(item: readonly number[]): RenderApi {
    return {
        value: (dimension) => item[dimension],
        coord: (point) => [point[0], point[1]],
        size: () => [BAND_X, BAND_Y],
        visual: () => SERIES_COLOR,
    };
}

/** One outline item: the category, the extent, the offset, and 64 pairs of a half-width and a grid value. */
function outlineItem(category: number, offset: number): number[] {
    const item = [category, 0, 63, offset];
    for (let index = 0; index < VIOLIN_GRID_POINTS; index += 1) {
        // A tent shape: the half-width peaks at the middle of the grid.
        item.push(Number((0.4 * (1 - Math.abs(index - 31.5) / 31.5)).toFixed(4)), index);
    }
    return item;
}

/** The shared item vector of the two renderers. */
const INTERVAL_ITEMS: readonly number[][] = [
    // An error bar along y over a vertical bar, with no group offset.
    [2, 5, 4, 7, 1, 0, 0],
    // An interval along x on a forest plot row, with a group offset.
    [1.5, 3, 0.8, 2.2, 0, 0.2, 0],
    // The inner mark of a grouped violin: the quartiles and the median point.
    [0, 10, 8, 12, 1, -0.2, 1],
];

const OUTLINE_ITEMS: readonly number[][] = [outlineItem(0, 0), outlineItem(3, -0.2), outlineItem(1, 0.2)];

/** The page twin of the renderers and of the bind step, as the bootstrap runs them. */
const onThePage = new Function(
    `${CHART_RENDERERS_SOURCE}\nreturn { interval: reportIntervalRenderer, outline: reportOutlineRenderer, bind: reportBindRenderers };`,
)() as {
    interval: (params: unknown, api: RenderApi) => RenderedElement;
    outline: (params: unknown, api: RenderApi) => RenderedElement;
    bind: (option: Record<string, unknown>) => Record<string, unknown>;
};

describe("the named renderers", () => {
    it("draws an error bar as one line between the bounds and two caps", () => {
        const element = intervalRenderer({}, stubApi([2, 5, 4, 7, 1, 0, 0]));
        expect(element).toEqual({
            type: "group",
            children: [
                { type: "line", shape: { x1: 2, y1: 4, x2: 2, y2: 7 }, style: expect.objectContaining({ lineWidth: 1.5 }) },
                { type: "line", shape: { x1: 2 - INTERVAL_CAP_PX, y1: 4, x2: 2 + INTERVAL_CAP_PX, y2: 4 }, style: expect.objectContaining({ lineWidth: 1.5 }) },
                { type: "line", shape: { x1: 2 - INTERVAL_CAP_PX, y1: 7, x2: 2 + INTERVAL_CAP_PX, y2: 7 }, style: expect.objectContaining({ lineWidth: 1.5 }) },
            ],
        });
    });

    it("shifts an interval along x by its offset of the y band", () => {
        const element = intervalRenderer({}, stubApi([1.5, 3, 0.8, 2.2, 0, 0.2, 0]));
        const line = (element.children ?? [])[0];
        // The offset is a fraction of one band, thus 0.2 of a band of 16 pixels moves the line 3.2 pixels.
        expect(line.shape).toEqual({ x1: 0.8, y1: 3 + 0.2 * BAND_Y, x2: 2.2, y2: 3 + 0.2 * BAND_Y });
    });

    it("draws the inner mark of a violin as a line and one point at the median, with no cap", () => {
        const element = intervalRenderer({}, stubApi([0, 10, 8, 12, 1, -0.2, 1]));
        const children = element.children ?? [];
        expect(children.map((child) => child.type)).toEqual(["line", "circle"]);
        expect(children[1].shape).toEqual(expect.objectContaining({ cx: -0.2 * BAND_X, cy: 10 }));
    });

    it("draws an outline as one closed polygon, symmetric about its center", () => {
        const element = outlineRenderer({}, stubApi(outlineItem(3, -0.2)));
        expect(element.type).toBe("polygon");
        const points = (element.shape as { points: number[][] }).points;
        expect(points.length).toBe(2 * VIOLIN_GRID_POINTS);
        const center = 3 - 0.2 * BAND_X;
        // The right side runs up the grid and the left side runs down it, thus the two mirror each other.
        for (let index = 0; index < VIOLIN_GRID_POINTS; index += 1) {
            const right = points[index];
            const left = points[points.length - 1 - index];
            expect(right[1]).toBe(left[1]);
            expect(right[0] - center).toBeCloseTo(center - left[0], 10);
        }
        expect(element.style).toEqual(expect.objectContaining({ fill: SERIES_COLOR }));
    });

    it("gives the same elements on the page as on the server, for every item", () => {
        expect(INTERVAL_ITEMS.map((item) => onThePage.interval({}, stubApi(item)))).toEqual(INTERVAL_ITEMS.map((item) => intervalRenderer({}, stubApi(item))));
        expect(OUTLINE_ITEMS.map((item) => onThePage.outline({}, stubApi(item)))).toEqual(OUTLINE_ITEMS.map((item) => outlineRenderer({}, stubApi(item))));
    });

    it("binds each renderer name to its function on both sides, and leaves every other series as it is", () => {
        const option = {
            xAxis: { type: "category", data: ["a"] },
            series: [
                { type: "bar", data: [["a", 1]] },
                { type: "custom", renderItem: "interval", data: [] },
                { type: "custom", renderItem: "outline", data: [] },
                { type: "custom", renderItem: "constructor", data: [] },
            ],
        };
        const server = bindRenderers(option);
        const page = onThePage.bind(option);
        const serverSeries = server.series as Record<string, unknown>[];
        const pageSeries = page.series as Record<string, unknown>[];

        expect(serverSeries[0]).toBe(option.series[0]);
        expect(serverSeries[1].renderItem).toBe(intervalRenderer);
        expect(serverSeries[2].renderItem).toBe(outlineRenderer);
        // A name that no renderer holds binds nothing, thus a hostile name never reaches a prototype member.
        expect(serverSeries[3].renderItem).toBe("constructor");
        expect(typeof pageSeries[1].renderItem).toBe("function");
        expect(typeof pageSeries[2].renderItem).toBe("function");
        expect(pageSeries[3].renderItem).toBe("constructor");
        // The bind copies. Thus the kept option still holds the names, and a second bind reads them again.
        expect(option.series[1].renderItem).toBe("interval");
    });
});

/** Render one option through the server path of the chart runtime, and give the SVG text. */
function ssrSvg(option: Record<string, unknown>): string {
    const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 400, height: 300 });
    try {
        chart.setOption({ animation: false, ...bindRenderers(option) });
        return chart.renderToSVGString();
    } finally {
        chart.dispose();
    }
}

/** The straight segments of each path whose stroke is the given color, as `[x1, y1, x2, y2]`. */
function segmentsOf(svg: string, stroke: string): number[][] {
    const segments: number[][] = [];
    for (const match of svg.matchAll(/<path d="M([\d.-]+) ([\d.-]+)L([\d.-]+) ([\d.-]+)"([^>]*)>/g)) {
        if (match[5].includes(`stroke="${stroke}"`)) {
            segments.push([Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]);
        }
    }
    return segments;
}

describe("the named renderers through the server render", () => {
    const INK = "#ff00ff";

    it("draws an interval over its bar, and the value axis covers the upper bound", () => {
        const svg = ssrSvg({
            xAxis: { type: "category", data: ["a", "b"] },
            yAxis: { type: "value" },
            series: [
                { type: "bar", name: "mean", data: [4, 6] },
                // The upper bound of the second bar passes every bar, thus only the custom extent can reach it.
                {
                    type: "custom",
                    name: "mean",
                    renderItem: "interval",
                    encode: { x: 0, y: [1, 2, 3] },
                    data: [
                        [0, 4, 3, 5, 1, 0, 0],
                        [1, 6, 5, 11, 1, 0, 0],
                    ],
                },
            ],
            // The stroke of the test marks the interval paths apart from the axis paths.
            color: [INK],
        });
        // The axis names each tick as text. The axis must reach the bound of 11, thus a tick at 12 is present.
        expect(svg).toMatch(/>12<\/text>/);
        const verticals = segmentsOf(svg, CHART_INK).filter((segment) => segment[0] === segment[2]);
        expect(verticals.length).toBe(2);
        // Each vertical line sits at the center of its category band.
        const [first, second] = verticals;
        expect(second[0] - first[0]).toBeGreaterThan(100);
        // The cap of the upper bound sits inside the plot, thus below the top edge of the canvas.
        expect(Math.min(second[1], second[3])).toBeGreaterThan(0);
    });

    it("draws a violin outline as one closed polygon around the center of its band", () => {
        const item = outlineItem(0, 0);
        const svg = ssrSvg({
            xAxis: { type: "category", data: ["a", "b"] },
            yAxis: { type: "value" },
            series: [{ type: "custom", name: "density", renderItem: "outline", encode: { x: 0, y: [1, 2] }, data: [item] }],
            color: [INK],
        });
        const match = /<polygon points="([^"]*)"[^>]*fill="#ff00ff"/.exec(svg);
        expect(match).not.toBeNull();
        const numbers = (match?.[1] ?? "").split(" ").map(Number);
        const xs = numbers.filter((_value, index) => index % 2 === 0);
        // The band of the first of two categories spans the left half of the plot. The widest points of the
        // tent sit at the same distance on each side of the band center.
        const center = (Math.min(...xs) + Math.max(...xs)) / 2;
        expect(xs.length).toBe(2 * VIOLIN_GRID_POINTS);
        expect(center).toBeLessThan(200);
        expect(Math.max(...xs) - center).toBeCloseTo(center - Math.min(...xs), 1);
    });
});
