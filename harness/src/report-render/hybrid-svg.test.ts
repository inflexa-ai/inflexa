import { describe, expect, it } from "bun:test";
import * as echarts from "echarts";

import { CHART_RENDERERS_SOURCE } from "./chart-renderers.js";
import { CHART_EXPORT_SIZES, CHART_PRINT_THEME_NAME, CHART_PRINT_TEXT_PX, chartTheme } from "./design.js";
import { composeHybridSvg, holdsPointLayer, HYBRID_SVG_SOURCE, isPointLayer, millimeterRoot, type PointLayerImage, type SvgRootSize } from "./hybrid-svg.js";

/** The page functions of the fragment, as the bootstrap runs them. The export option comes from the renderer fragment. */
function pageTwin(document?: unknown): {
    isPointLayer: (series: unknown) => boolean;
    millimeterRoot: (svg: string, size: SvgRootSize) => string;
    compose: (svg: string, layer: PointLayerImage, size: SvgRootSize) => string;
    vector: (option: Record<string, unknown>) => Record<string, unknown>;
    raster: (option: Record<string, unknown>, layer: unknown) => Record<string, unknown>;
    box: (chart: unknown, option: Record<string, unknown>, width: number, height: number) => LayerBox | null;
    hybrid: (runtime: unknown, option: Record<string, unknown>, size: Record<string, unknown>) => string | null;
} {
    return new Function(
        "document",
        `${CHART_RENDERERS_SOURCE}\n${HYBRID_SVG_SOURCE}\nreturn { isPointLayer: reportIsPointLayer, millimeterRoot: reportMillimeterRoot, compose: reportComposeHybridSvg, vector: reportHybridVectorOption, raster: reportHybridRasterOption, box: reportPointLayerBox, hybrid: reportHybridSvg };`,
    )(document) as ReturnType<typeof pageTwin>;
}

interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface LayerBox {
    boxes: Record<string, Box>;
    extents: { xAxis: ({ min: number; max: number } | undefined)[]; yAxis: ({ min: number; max: number } | undefined)[] };
    box: Box;
}

const SINGLE: SvgRootSize = { widthPx: 336, heightPx: 253, widthMm: 89, heightMm: 67 };
const SLIDE: SvgRootSize = { widthPx: 1920, heightPx: 1080 };

/** The head of an SVG file of the chart runtime: the root, the background rectangle, and one axis line. */
const RUNTIME_SVG =
    '<svg width="336" height="253" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" baseProfile="full" viewBox="0 0 336 253">\n' +
    '<rect width="336" height="253" x="0" y="0" fill="none"></rect>\n' +
    '<path d="M60 205L312 205" fill="none" stroke="#222222"></path>\n' +
    '<text transform="translate(186 240)" fill="#222222">Chromosome</text>\n' +
    "</svg>";

const LAYER: PointLayerImage = { href: "data:image/png;base64,iVBORw0KGgo=", x: 60.123456, y: 24, width: 252.5, height: 181 };

/** The shared vector of the composition: each entry runs through both twins. */
const COMPOSE_VECTOR: readonly { svg: string; layer: PointLayerImage; size: SvgRootSize }[] = [
    { svg: RUNTIME_SVG, layer: LAYER, size: SINGLE },
    { svg: RUNTIME_SVG.replace(/<rect[^>]*><\/rect>\n/, ""), layer: LAYER, size: SINGLE },
    { svg: RUNTIME_SVG.replace('width="336" height="253"', 'width="1920" height="1080"'), layer: LAYER, size: SLIDE },
    { svg: RUNTIME_SVG, layer: { ...LAYER, href: 'data:x"><script>&' }, size: SINGLE },
    { svg: "<g>no root</g>", layer: LAYER, size: SINGLE },
];

/** The shared vector of the point-layer rule. */
const SERIES_VECTOR: readonly unknown[] = [
    { type: "scatter", symbolSize: 3, data: [] },
    { type: "scatter", data: [], label: { show: false } },
    { type: "scatter", symbolSize: 0, label: { show: true }, data: [] },
    { type: "scatter", symbol: "none", data: [] },
    { type: "scatter", label: { show: true }, data: [] },
    { type: "line", data: [] },
    { type: "heatmap", data: [] },
    null,
    "scatter",
];

describe("the composition of a hybrid SVG", () => {
    it("puts one image of the point layer after the background rectangle, under each vector mark", () => {
        const svg = composeHybridSvg(RUNTIME_SVG, LAYER, SINGLE);
        expect(svg.match(/<image /g)?.length).toBe(1);
        const image = svg.indexOf("<image ");
        expect(image).toBeGreaterThan(svg.indexOf("<rect "));
        expect(image).toBeLessThan(svg.indexOf("<path "));
        expect(svg).toContain(
            '<image href="data:image/png;base64,iVBORw0KGgo=" x="60.123" y="24" width="252.5" height="181" preserveAspectRatio="none"></image>',
        );
    });

    it("keeps the vector text, and states the root at the millimeter size with the pixel view box", () => {
        const svg = composeHybridSvg(RUNTIME_SVG, LAYER, SINGLE);
        expect(svg).toContain(">Chromosome</text>");
        expect(svg.startsWith('<svg width="89mm" height="67mm" ')).toBe(true);
        expect(svg).toContain('viewBox="0 0 336 253"');
    });

    it("puts the image right after the root when the file holds no background rectangle", () => {
        const svg = composeHybridSvg(RUNTIME_SVG.replace(/<rect[^>]*><\/rect>\n/, ""), LAYER, SINGLE);
        expect(svg.indexOf("<image ")).toBe(svg.indexOf(">") + 2);
    });

    it("writes a quote, a bracket, and an ampersand of the link as entities, thus the link cannot close its attribute", () => {
        const svg = composeHybridSvg(RUNTIME_SVG, { ...LAYER, href: 'data:x"><script>&' }, SINGLE);
        expect(svg).toContain('href="data:x&quot;>&lt;script>&amp;"');
        expect(svg).not.toContain("<script>");
    });

    it("keeps the pixel root of a size with no millimeter box, and passes a text with no root through", () => {
        expect(millimeterRoot(RUNTIME_SVG, SLIDE)).toBe(RUNTIME_SVG);
        expect(composeHybridSvg("<g>no root</g>", LAYER, SINGLE)).toBe("<g>no root</g>");
    });

    it("gives the same text in the page twin for each entry of the shared vector", () => {
        const page = pageTwin();
        for (const entry of COMPOSE_VECTOR) {
            expect(page.compose(entry.svg, entry.layer, entry.size)).toBe(composeHybridSvg(entry.svg, entry.layer, entry.size));
            expect(page.millimeterRoot(entry.svg, entry.size)).toBe(millimeterRoot(entry.svg, entry.size));
        }
    });
});

describe("the point layer of a dense chart", () => {
    it("takes a scatter whose symbol draws and which shows no series label", () => {
        expect(SERIES_VECTOR.map(isPointLayer)).toEqual([true, true, false, false, false, false, false, false, false]);
    });

    it("gives the same answer in the page twin for each entry of the shared vector", () => {
        const page = pageTwin();
        expect(SERIES_VECTOR.map(page.isPointLayer)).toEqual(SERIES_VECTOR.map(isPointLayer));
    });

    it("finds a point layer in an option with a series list or with one series", () => {
        expect(holdsPointLayer({ series: [{ type: "line" }, { type: "scatter", symbolSize: 3 }] })).toBe(true);
        expect(holdsPointLayer({ series: { type: "scatter" } })).toBe(true);
        expect(holdsPointLayer({ series: [{ type: "line" }] })).toBe(false);
        expect(holdsPointLayer({})).toBe(false);
    });
});

/** A Manhattan-like option: two chromosome layers with a guide line, one name series, and a legend. */
function denseOption(): Record<string, unknown> {
    return {
        grid: { left: 60, right: 24, top: 24, bottom: 48, outerBoundsMode: "none" },
        xAxis: { type: "value", name: "Chromosome", scale: true },
        yAxis: { type: "value", name: "−log10(p)" },
        legend: { bottom: 0 },
        graphic: [{ type: "text", left: 10, top: 10, style: { text: "λ = 1.02" } }],
        series: [
            {
                type: "scatter",
                name: "1",
                symbolSize: 3,
                data: [
                    { value: ["100", 2], name: "rs1" },
                    { value: ["300", 9], name: "rs2", label: { show: true, formatter: "{b}" } },
                ],
                markLine: { data: [{ yAxis: 7.3 }] },
            },
            {
                type: "scatter",
                name: "2",
                symbolSize: 3,
                large: true,
                data: [
                    [500, 1],
                    [900, 4],
                ],
            },
            { type: "scatter", name: "Point names", symbolSize: 0, silent: true, label: { show: true }, data: [{ name: "FTO", value: [300, 9] }] },
        ],
    };
}

describe("the two draws of a hybrid SVG", () => {
    it("empties each point layer of the vector draw, and keeps each labeled row and two anchors at the extent", () => {
        const input = denseOption();
        const vector = pageTwin().vector(input);
        const series = vector.series as Record<string, unknown>[];
        expect(series[0].data).toEqual([
            { value: ["300", 9], name: "rs2", label: { show: true, formatter: "{b}" } },
            { value: [100, 2], symbol: "none", label: { show: false } },
            { value: [300, 9], symbol: "none", label: { show: false } },
        ]);
        expect(series[0].markLine).toEqual({ data: [{ yAxis: 7.3 }] });
        // A large layer draws each item alike, thus the vector draw turns the large path off and the anchors draw no symbol.
        expect(series[1]).toEqual(
            expect.objectContaining({ large: false, data: [expect.objectContaining({ value: [500, 1] }), expect.objectContaining({ value: [900, 4] })] }),
        );
        // A name series is no point layer, thus the vector draw keeps it as it is.
        expect(series[2]).toBe((input.series as unknown[])[2]);
        expect(vector.graphic).toBe(input.graphic);
    });

    it("draws the point layers alone in the raster draw, at the measured grid and the measured extent", () => {
        const layer = {
            boxes: { 0: { x: 60, y: 24, width: 252, height: 181 } },
            extents: { xAxis: [{ min: 0, max: 1000 }], yAxis: [{ min: 0, max: 10 }] },
            box: {},
        };
        const raster = pageTwin().raster(denseOption(), layer);
        const series = raster.series as Record<string, unknown>[];
        expect(series.map((entry) => (entry.data as unknown[]).length)).toEqual([2, 2, 0]);
        // The labeled row draws its point in the raster, and its name draws in the vector file alone.
        expect((series[0].data as Record<string, unknown>[])[1]).toEqual({ value: ["300", 9], name: "rs2" });
        for (const entry of series) {
            expect(entry.markLine).toBeUndefined();
            expect(entry.label).toEqual({ show: false });
            expect(entry.progressive).toBe(0);
        }
        expect(raster.grid).toEqual([{ left: 60, top: 24, width: 252, height: 181, containLabel: false, outerBoundsMode: "none" }]);
        expect(raster.xAxis).toEqual({ type: "value", name: "Chromosome", scale: true, show: false, min: 0, max: 1000 });
        expect(raster.yAxis).toEqual({ type: "value", name: "−log10(p)", show: false, min: 0, max: 10 });
        expect(raster.legend).toEqual({ bottom: 0, show: false });
        expect(raster.graphic).toBeUndefined();
    });

    it("measures the grid rectangle and the axis extents from the runtime, and the empty draw keeps both", () => {
        /** The measured layer of one option, drawn by the runtime at the single column. */
        function measured(option: Record<string, unknown>): LayerBox | null {
            const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 336, height: 253 });
            try {
                chart.setOption(option);
                return pageTwin().box(chart, denseOption(), 336, 253);
            } finally {
                chart.dispose();
            }
        }
        const full = measured(denseOption());
        const empty = measured(pageTwin().vector(denseOption()));
        // The grid stands 60 from the left, 24 from the right and the top, and 48 from the bottom. The layer
        // reaches past it by half of the symbol of 3 pixels, up to a whole pixel, thus an edge point keeps its symbol.
        const grid = empty?.boxes[0] as Box;
        expect([grid.x, grid.y, grid.x + grid.width, grid.y + grid.height].map((edge) => Math.round(edge * 100) / 100)).toEqual([60, 24, 312, 205]);
        const box = empty?.box as Box;
        expect([box.x, box.y, box.x + box.width, box.y + box.height].map((edge) => Math.round(edge * 100) / 100)).toEqual([58, 22, 314, 207]);
        // The x axis rounds the extent of its data to 0 and 1000. The anchors keep that extent in the draw with
        // no point, thus each point of the raster lands where the full draw puts it.
        const [x] = empty?.extents.xAxis ?? [];
        expect([x?.min, x?.max].map((end) => Math.round(end ?? NaN))).toEqual([0, 1000]);
        expect(empty?.extents).toEqual(full?.extents as LayerBox["extents"]);
        expect(empty?.box).toEqual(full?.box as Box);
    });
});

/**
 * A faceted embedding of two panels: the cell type `B` holds no cell in the second panel, thus the first layer of
 * that grid holds no row. The second grid holds no row at all in its last panel layer `NK`, as the payload builds it.
 */
function facetOption(): Record<string, unknown> {
    const cells = (at: number): number[][] => [
        [at, 1],
        [at + 4, 6],
        [at + 2, 3],
    ];
    return {
        grid: [
            { left: 40, top: 24, width: 120, bottom: 48, outerBoundsMode: "none" },
            { left: 196, top: 24, width: 120, bottom: 48, outerBoundsMode: "none" },
        ],
        xAxis: [
            { type: "value", gridIndex: 0, name: "UMAP 1" },
            { type: "value", gridIndex: 1, name: "UMAP 1" },
        ],
        yAxis: [
            { type: "value", gridIndex: 0, name: "UMAP 2" },
            { type: "value", gridIndex: 1 },
        ],
        series: [
            { type: "scatter", name: "B", symbolSize: 6, xAxisIndex: 0, yAxisIndex: 0, data: cells(-5) },
            { type: "scatter", name: "T", symbolSize: 6, xAxisIndex: 0, yAxisIndex: 0, data: cells(0) },
            { type: "scatter", name: "NK", symbolSize: 6, xAxisIndex: 0, yAxisIndex: 0, data: [] },
            { type: "scatter", name: "B", symbolSize: 6, xAxisIndex: 1, yAxisIndex: 1, data: [] },
            { type: "scatter", name: "T", symbolSize: 6, xAxisIndex: 1, yAxisIndex: 1, data: cells(2) },
            { type: "scatter", name: "NK", symbolSize: 6, xAxisIndex: 1, yAxisIndex: 1, data: cells(8) },
        ],
    };
}

describe("the grid of a facet panel with an empty layer", () => {
    /** The measured layer of the vector draw of one option at the single column. */
    function measured(option: Record<string, unknown>): LayerBox | null {
        const page = pageTwin();
        const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 336, height: 253 });
        try {
            chart.setOption(page.vector(option));
            return page.box(chart, option, 336, 253);
        } finally {
            chart.dispose();
        }
    }

    it("seeds each grid from a layer that holds rows, thus a panel whose first layer is empty keeps its rectangle", () => {
        const layer = measured(facetOption());
        expect(layer).not.toBeNull();
        const [left, right] = [layer?.boxes[0] as Box, layer?.boxes[1] as Box];
        expect([left.x, left.x + left.width].map((edge) => Math.round(edge))).toEqual([40, 160]);
        expect([right.x, right.x + right.width].map((edge) => Math.round(edge))).toEqual([196, 316]);
        expect(layer?.extents.xAxis.map((extent) => extent !== undefined)).toEqual([true, true]);
    });

    it("measures no rectangle for a grid whose each layer is empty, because no point draws there", () => {
        const option = facetOption();
        const series = option.series as Record<string, unknown>[];
        series[4] = { ...series[4], data: [] };
        series[5] = { ...series[5], data: [] };
        const layer = measured(option);
        expect(layer).not.toBeNull();
        expect(Object.keys(layer?.boxes ?? {})).toEqual(["0"]);
    });

    it("measures nothing for an option whose each point layer is empty", () => {
        const option = facetOption();
        option.series = (option.series as Record<string, unknown>[]).map((entry) => ({ ...entry, data: [] }));
        expect(measured(option)).toBeNull();
    });

    it("keeps an empty layer a point layer in both twins, because the payload fills the rows on the page", () => {
        const empty = (facetOption().series as unknown[])[3];
        expect(isPointLayer(empty)).toBe(true);
        expect(pageTwin().isPointLayer(empty)).toBe(true);
    });

    it("seeds each panel of a facet whose x axis holds categories inside its own grid", () => {
        const clusters = ["c0", "c1", "c2"];
        const lefts = [40, 116, 192, 268];
        const option = {
            grid: lefts.map((left) => ({ left, top: 24, width: 60, bottom: 48, outerBoundsMode: "none" })),
            xAxis: lefts.map((_left, index) => ({ type: "category", gridIndex: index, data: clusters })),
            yAxis: lefts.map((_left, index) => ({ type: "value", gridIndex: index })),
            series: lefts.map((_left, index) => ({
                type: "scatter",
                symbolSize: 4,
                xAxisIndex: index,
                yAxisIndex: index,
                data: [
                    ["c1", index + 1],
                    ["c2", index + 5],
                    ["c0", index + 3],
                ],
            })),
        };
        const layer = measured(option);
        expect(layer).not.toBeNull();
        const boxes = lefts.map((_left, index) => layer?.boxes[index] as Box);
        expect(boxes.map((box) => [box.x, box.x + box.width].map((edge) => Math.round(edge)))).toEqual(lefts.map((left) => [left, left + 60]));
    });
});

describe("the reach of the point layer past its grid", () => {
    /** One grid from 60 to 312 across and from 24 to 205 down, with one scatter of symbol size 4. */
    function sizedOption(visualMap?: Record<string, unknown>): Record<string, unknown> {
        return {
            grid: { left: 60, right: 24, top: 24, bottom: 48, outerBoundsMode: "none" },
            xAxis: { type: "value" },
            yAxis: { type: "value" },
            series: [
                {
                    type: "scatter",
                    symbolSize: 4,
                    data: [
                        [0, 0, 1],
                        [10, 10, 9],
                    ],
                },
            ],
            ...(visualMap !== undefined ? { visualMap } : {}),
        };
    }

    /** The crop box of the layer of one option at the single column, as its four edges. */
    function cropEdges(option: Record<string, unknown>): number[] {
        const page = pageTwin();
        const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 336, height: 253 });
        try {
            chart.setOption(page.vector(option));
            const box = page.box(chart, option, 336, 253)?.box as Box;
            return [box.x, box.y, box.x + box.width, box.y + box.height].map((edge) => Math.round(edge));
        } finally {
            chart.dispose();
        }
    }

    it("reaches past the grid by half of the largest symbol of a size map of the layer", () => {
        const size = { type: "continuous", show: false, seriesIndex: [0], dimension: 2, min: 1, max: 9, inRange: { symbolSize: [6, 24] } };
        expect(cropEdges(sizedOption(size))).toEqual([48, 12, 324, 217]);
    });

    it("keeps the reach of the symbol of the layer for a map with no symbol size or a map of another series", () => {
        expect(cropEdges(sizedOption())).toEqual([58, 22, 314, 207]);
        expect(cropEdges(sizedOption({ type: "continuous", show: false, dimension: 2, min: 1, max: 9, inRange: { color: ["#000", "#fff"] } }))).toEqual([
            58, 22, 314, 207,
        ]);
        expect(
            cropEdges(sizedOption({ type: "continuous", show: false, seriesIndex: 1, dimension: 2, min: 1, max: 9, inRange: { symbolSize: [6, 24] } })),
        ).toEqual([58, 22, 314, 207]);
    });
});

describe("the page build of a hybrid SVG", () => {
    it("draws the vector file, crops the raster at the grid, and puts one image into the file at the column size", () => {
        echarts.registerTheme(CHART_PRINT_THEME_NAME, chartTheme(CHART_PRINT_TEXT_PX));
        const size = CHART_EXPORT_SIZES.single;
        const raster: { init?: Record<string, unknown>; option?: Record<string, unknown>; ratio?: number } = {};
        const drawn: number[][] = [];
        const runtime = {
            init: (dom: unknown, theme: string, opts: Record<string, unknown>) => {
                if (opts.renderer === "svg") return echarts.init(null, theme, opts as { renderer: "svg"; ssr: true; width: number; height: number });
                raster.init = { dom, theme, ...opts };
                return {
                    setOption: (given: Record<string, unknown>) => {
                        raster.option = given;
                    },
                    renderToCanvas: (given: { pixelRatio: number }) => {
                        raster.ratio = given.pixelRatio;
                        return "full canvas";
                    },
                    dispose: () => undefined,
                };
            },
        };
        const page = {
            createElement: (tag: string) =>
                tag === "canvas"
                    ? {
                          width: 0,
                          height: 0,
                          getContext: () => ({ drawImage: (...args: unknown[]) => drawn.push(args.slice(1) as number[]) }),
                          toDataURL: () => "data:image/png;base64,AAAA",
                      }
                    : {},
        };
        const svg = pageTwin(page).hybrid(runtime, denseOption(), {
            theme: size.theme,
            textPx: size.textPx,
            width: size.widthPx,
            height: size.heightPx,
            widthMm: size.widthMm,
            heightMm: size.heightMm,
            pixelRatio: size.pixelRatio,
        });

        expect(svg).not.toBeNull();
        const text = svg ?? "";
        expect(text.startsWith('<svg width="89mm" height="67mm" ')).toBe(true);
        expect(text.match(/<image /g)?.length).toBe(1);
        expect(text).toContain('href="data:image/png;base64,AAAA"');
        // The axis names and the name of the labeled row stay vector text.
        expect(text).toMatch(/<text[^>]*>Chromosome<\/text>/);
        expect(text).toMatch(/<text[^>]*>rs2<\/text>/);
        // The raster draws at 300 DPI in the print theme, and the crop reads the grid rectangle at that ratio.
        expect(raster.init).toEqual(
            expect.objectContaining({ theme: CHART_PRINT_THEME_NAME, renderer: "canvas", width: 336, height: 253, devicePixelRatio: 300 / 96 }),
        );
        expect(raster.ratio).toBe(300 / 96);
        const [sx, sy, sw, sh] = drawn[0];
        const image = /<image [^>]*x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(text);
        expect(image).not.toBeNull();
        const [ix, iy, iw, ih] = (image ?? []).slice(1).map(Number);
        expect([sx / raster.ratio, sy / raster.ratio, sw / raster.ratio, sh / raster.ratio].map((v) => Math.round(v))).toEqual(
            [ix, iy, iw, ih].map((v) => Math.round(v)),
        );
        // The raster holds the points alone: the axes draw nothing, and the grid stands where the vector grid
        // stands. The image reaches two pixels past the grid, the half of the symbol of 3 pixels rounded up.
        const grid = (raster.option?.grid as Record<string, unknown>[])[0];
        expect([grid.left, grid.top].map((v) => Math.round(Number(v)))).toEqual([Math.round(ix) + 2, Math.round(iy) + 2]);
        expect((raster.option?.xAxis as Record<string, unknown>).show).toBe(false);
    });

    it("builds nothing for an option with no point layer", () => {
        const page = pageTwin({ createElement: () => ({}) });
        const size = { theme: "t", textPx: 9.33, width: 336, height: 253, pixelRatio: 3.125 };
        expect(page.hybrid({ init: () => ({}) }, { series: [{ type: "line", data: [[1, 2]] }] }, size)).toBeNull();
    });
});
