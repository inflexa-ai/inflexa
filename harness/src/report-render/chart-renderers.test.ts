import { describe, expect, it } from "bun:test";
import * as echarts from "echarts";
import { CHART_INK, GUIDE_LINE_COLOR } from "./design.js";

import {
    CELL_GAP_PX,
    CELL_GLYPH_SHARE,
    cellGlyphRenderer,
    CHART_RENDERERS,
    CHART_RENDERERS_SOURCE,
    INTERVAL_ARROW_PX,
    INTERVAL_CAP_PX,
    intervalRenderer,
    outlineRenderer,
    STEM_HEAD_RADIUS_PX,
    stemRenderer,
    registerChartRenderers,
    VIOLIN_GRID_POINTS,
    type ChartRenderer,
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
    // A forest interval that the axis clips at both ends, thus each end draws an arrow.
    [1.5, 3, 0.8, 2.2, 0, 0, 0, 3],
];

const OUTLINE_ITEMS: readonly number[][] = [outlineItem(0, 0), outlineItem(3, -0.2), outlineItem(1, 0.2)];

/** The parameters of an oncoprint series: the color of each class, and the ground of each cell. */
const GLYPH_PARAMS = { itemPayload: { colors: ["#009e73", "#d55e00"], ground: "#e0e0e0" } };

/** The shared item vector of the cell glyph: a cell with no alteration, and a cell of each class. */
const GLYPH_ITEMS: readonly number[][] = [
    [0, 0, -1],
    [3, 1, 0],
    [7, 2, 1],
];

/** The shared item vector of the stem: a single mutation, a hotspot, and a stem at the origin. */
const STEM_ITEMS: readonly number[][] = [
    [315, 1],
    [882, 27],
    [0, 0],
];

/** The page twin of the renderers and of the registration step, as the bootstrap runs them. */
const onThePage = new Function(
    `${CHART_RENDERERS_SOURCE}\nreturn { interval: reportIntervalRenderer, outline: reportOutlineRenderer, glyph: reportCellGlyphRenderer, stem: reportStemRenderer, register: reportRegisterRenderers };`,
)() as {
    interval: (params: unknown, api: RenderApi) => RenderedElement;
    outline: (params: unknown, api: RenderApi) => RenderedElement;
    glyph: (params: unknown, api: RenderApi) => RenderedElement;
    stem: (params: unknown, api: RenderApi) => RenderedElement;
    register: (runtime: { registerCustomSeries(name: string, render: unknown): void }) => void;
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

    it("draws an arrow in place of the cap at each clipped end of an interval", () => {
        // The low end is clipped and the high end is not.
        const element = intervalRenderer({}, stubApi([1.5, 3, 0.8, 2.2, 0, 0, 0, 1]));
        const [line, ...ends] = element.children ?? [];
        expect(line.shape).toEqual({ x1: 0.8, y1: 3, x2: 2.2, y2: 3 });
        // The two strokes of the arrow meet at the low end and open toward the high end.
        expect(ends.map((end) => end.shape)).toEqual([
            { x1: 0.8 + INTERVAL_ARROW_PX, y1: 3 - INTERVAL_CAP_PX, x2: 0.8, y2: 3 },
            { x1: 0.8 + INTERVAL_ARROW_PX, y1: 3 + INTERVAL_CAP_PX, x2: 0.8, y2: 3 },
            { x1: 2.2, y1: 3 - INTERVAL_CAP_PX, x2: 2.2, y2: 3 + INTERVAL_CAP_PX },
        ]);
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

    it("draws a cell with no alteration as the gray ground alone, one gap inside its band", () => {
        const element = cellGlyphRenderer(GLYPH_PARAMS, stubApi([0, 0, -1]));
        expect(element.type).toBe("group");
        const children = element.children ?? [];
        expect(children.length).toBe(1);
        const width = BAND_X - CELL_GAP_PX;
        const height = BAND_Y - CELL_GAP_PX;
        expect(children[0]).toEqual({ type: "rect", shape: { x: -width / 2, y: -height / 2, width, height }, style: { fill: "#e0e0e0" } });
    });

    it("draws an altered cell as the ground and one glyph in the color of its class, centered in the cell", () => {
        const element = cellGlyphRenderer(GLYPH_PARAMS, stubApi([7, 2, 1]));
        const children = element.children ?? [];
        expect(children.map((child) => child.style?.fill)).toEqual(["#e0e0e0", "#d55e00"]);
        const ground = children[0].shape as { x: number; y: number; width: number; height: number };
        const glyph = children[1].shape as { x: number; y: number; width: number; height: number };
        // The glyph spans the width of the ground and a share of its height, thus the gray shows above and below it.
        expect(glyph.width).toBe(ground.width);
        expect(glyph.height).toBeCloseTo(ground.height * CELL_GLYPH_SHARE, 10);
        expect(glyph.y + glyph.height / 2).toBeCloseTo(2, 10);
        expect(glyph.x + glyph.width / 2).toBeCloseTo(7, 10);
    });

    it("draws a stem from zero to the count and one head at the count, in the color of the series", () => {
        const element = stemRenderer({}, stubApi([882, 27]));
        const children = element.children ?? [];
        expect(children.map((child) => child.type)).toEqual(["line", "circle"]);
        expect(children[0].shape).toEqual({ x1: 882, y1: 0, x2: 882, y2: 27 });
        expect(children[1].shape).toEqual({ cx: 882, cy: 27, r: STEM_HEAD_RADIUS_PX });
        expect(children[1].style).toEqual(expect.objectContaining({ fill: SERIES_COLOR }));
    });

    it("gives the same elements on the page as on the server, for every item", () => {
        expect(INTERVAL_ITEMS.map((item) => onThePage.interval({}, stubApi(item)))).toEqual(INTERVAL_ITEMS.map((item) => intervalRenderer({}, stubApi(item))));
        expect(OUTLINE_ITEMS.map((item) => onThePage.outline({}, stubApi(item)))).toEqual(OUTLINE_ITEMS.map((item) => outlineRenderer({}, stubApi(item))));
        expect(GLYPH_ITEMS.map((item) => onThePage.glyph(GLYPH_PARAMS, stubApi(item)))).toEqual(
            GLYPH_ITEMS.map((item) => cellGlyphRenderer(GLYPH_PARAMS, stubApi(item))),
        );
        expect(STEM_ITEMS.map((item) => onThePage.stem({}, stubApi(item)))).toEqual(STEM_ITEMS.map((item) => stemRenderer({}, stubApi(item))));
    });

    it("registers each renderer under its name on both sides, with the function of that side", () => {
        const server = new Map<string, ChartRenderer>();
        registerChartRenderers({ registerCustomSeries: (name, render) => server.set(name, render) });
        const page = new Map<string, unknown>();
        onThePage.register({ registerCustomSeries: (name, render) => page.set(name, render) });

        expect([...server.keys()]).toEqual(["interval", "outline", "cell-glyph", "stem"]);
        expect(server.get("interval")).toBe(intervalRenderer);
        expect(server.get("outline")).toBe(outlineRenderer);
        expect(server.get("cell-glyph")).toBe(cellGlyphRenderer);
        expect(server.get("stem")).toBe(stemRenderer);
        // The page registers the same names, and each page function draws what its server twin draws.
        expect([...page.keys()]).toEqual(CHART_RENDERERS.map((entry) => entry.name));
        expect(page.get("interval")).toBe(onThePage.interval);
        expect(page.get("outline")).toBe(onThePage.outline);
        expect(page.get("cell-glyph")).toBe(onThePage.glyph);
        expect(page.get("stem")).toBe(onThePage.stem);
    });
});

/**
 * Render one option through the server path of the chart runtime, and give the SVG text. The option names
 * each renderer as a string, and the runtime finds the function in its registry.
 */
function ssrSvg(option: Record<string, unknown>): string {
    // Each item of these options holds numbers alone, thus each renderer reads a number at each dimension.
    registerChartRenderers({ registerCustomSeries: (name, render) => echarts.registerCustomSeries(name, render as unknown as echarts.CustomSeriesRenderItem) });
    const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 400, height: 300 });
    try {
        chart.setOption({ animation: false, ...option });
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

    it("draws the ground of each cell and one glyph for an altered cell through the registry", () => {
        const svg = ssrSvg({
            xAxis: { type: "category", data: ["s1", "s2"] },
            yAxis: { type: "category", data: ["TP53", "FLT3"] },
            series: [
                {
                    type: "custom",
                    renderItem: "cell-glyph",
                    encode: { x: 0, y: 1 },
                    itemPayload: { colors: [INK], ground: "#e0e0e0" },
                    data: [
                        [0, 0, 0],
                        [1, 0, -1],
                        [0, 1, -1],
                        [1, 1, -1],
                    ],
                },
            ],
        });
        expect(svg.match(/fill="#e0e0e0"/g)?.length).toBe(4);
        expect(svg.match(/fill="#ff00ff"/g)?.length).toBe(1);
    });

    it("draws each stem from the axis floor to its head through the registry", () => {
        const svg = ssrSvg({
            xAxis: { type: "value", min: 0, max: 900 },
            yAxis: { type: "value", min: 0 },
            series: [
                {
                    type: "custom",
                    renderItem: "stem",
                    encode: { x: 0, y: 1 },
                    data: [
                        [882, 27],
                        [315, 1],
                    ],
                },
            ],
            color: [INK],
        });
        const stems = segmentsOf(svg, GUIDE_LINE_COLOR).filter((segment) => segment[0] === segment[2]);
        expect(stems.length).toBe(2);
        // Each stem starts at the floor of the plot, thus both share their lower end.
        expect(Math.max(stems[0][1], stems[0][3])).toBe(Math.max(stems[1][1], stems[1][3]));
        expect(svg.match(/fill="#ff00ff"/g)?.length).toBe(2);
    });
});
