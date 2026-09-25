import { describe, expect, it } from "bun:test";

import type { ChartBlock } from "../contracts/report-blocks.js";
import { deriveChartRender, type ChartRow, type EchartOption } from "./chart.js";
import { chartSvgAssets, renderChartSvg } from "./chart-export.js";
import { CHART_RENDERERS_SOURCE, exportOption, SIZED_SERIES_MEMBER } from "./chart-renderers.js";
import {
    CHART_EXPORT_SIZES,
    CHART_INK,
    CHART_PAGE_TEXT_PX,
    CHART_PALETTE,
    CHART_PRINT_TEXT_PX,
    CHART_SLIDE_TEXT_PX,
    COLOR_SCALE_BAND_PCT,
    SCATTER_CROWD_ROWS,
} from "./design.js";

/** The eight cell types of the Kang composition, one bar series each. */
const KANG_TYPES = ["B cells", "CD14+ Monocytes", "CD4 T cells", "CD8 T cells", "Dendritic cells", "FCGR3A+ Monocytes", "Megakaryocytes", "NK cells"];

/** A facet of two panels over eight donors, with the bottom legend of eight cell types and the x title of the facet. */
const FACETED_LEGEND: EchartOption = {
    grid: [
        { left: "5%", top: "10%", width: "44%", height: "70%", outerBoundsMode: "same", outerBoundsContain: "all" },
        { left: "52%", top: "10%", width: "44%", height: "70%", outerBoundsMode: "same", outerBoundsContain: "all" },
    ],
    xAxis: [0, 1].map((gridIndex) => ({ type: "category", gridIndex, data: ["patient_101", "patient_1015"], axisLabel: { interval: 0, rotate: 45 } })),
    yAxis: [0, 1].map((gridIndex) => ({ type: "value", gridIndex })),
    graphic: [
        { type: "text", left: "5%", top: "3%", style: { text: "control", fontSize: CHART_PAGE_TEXT_PX } },
        { type: "text", left: "center", bottom: "8%", style: { text: "Donor", fontSize: CHART_PAGE_TEXT_PX } },
    ],
    legend: { bottom: 0 },
    series: KANG_TYPES.flatMap((name) => [0, 1].map((index) => ({ type: "bar", name, xAxisIndex: index, yAxisIndex: index, data: [1, 2] }))),
};

/** A scatter whose point names carry a series for two export widths beside the page series. */
const SIZED_NAMES: EchartOption = {
    xAxis: { type: "value" },
    yAxis: { type: "value" },
    series: [
        { type: "scatter", name: "Points", data: [[1, 2]] },
        { type: "scatter", name: "Point names", symbolSize: 0, data: [{ name: "a", value: [1.5, 2] }] },
    ],
    [SIZED_SERIES_MEMBER]: {
        names: ["Point names"],
        widths: { "336": [{ type: "scatter", name: "Point names", symbolSize: 0, data: [{ name: "a", value: [1, 3] }] }], "692": [] },
    },
};

/**
 * The height of the band of a bottom legend of some lines in an export: one line pitch of the text and the
 * item gap of the theme for each line, and one text size of room under the lowest line.
 */
function legendBandPx(lines: number, textPx: number): number {
    return Math.round(lines * (textPx * 1.25 + 16) + textPx);
}

/** A line whose area fills with a gradient. The grid clips the line, thus the SVG holds a gradient and a clip path. */
const GRADIENT_OPTION: EchartOption = {
    xAxis: { type: "category", data: ["a", "b", "c"], name: "Day", nameLocation: "middle", nameGap: 34 },
    yAxis: { type: "value", name: "Level" },
    series: [
        {
            type: "line",
            name: "Level",
            data: [1, 3, 2],
            areaStyle: {
                color: {
                    type: "linear",
                    x: 0,
                    y: 0,
                    x2: 0,
                    y2: 1,
                    colorStops: [
                        { offset: 0, color: "#0072b2" },
                        { offset: 1, color: "#ffffff" },
                    ],
                },
            },
        },
    ],
};

/** The SVG text of one column export, or the failure of the test. */
function svgOf(option: EchartOption, size: "single" | "double" = "single"): string {
    return renderChartSvg(option, CHART_EXPORT_SIZES[size])._unsafeUnwrap();
}

describe("the SVG export", () => {
    it("sets the text at 7 points at the column width", () => {
        const svg = svgOf({ xAxis: { type: "category", data: ["a", "b"] }, yAxis: { type: "value", name: "Count" }, series: [{ type: "bar", data: [1, 2] }] });
        expect(svg).toContain(`${CHART_PRINT_TEXT_PX}px`);
        expect(CHART_PRINT_TEXT_PX).toBeCloseTo((7 * 96) / 72, 2);
    });

    it("gives byte-identical files for one option, whatever the chart runtime drew before", () => {
        const first = svgOf(GRADIENT_OPTION);
        // A render in between moves the instance counter and the class counter of the chart runtime.
        svgOf({ ...GRADIENT_OPTION, series: [{ type: "bar", data: [4, 5, 6] }] }, "double");
        const second = svgOf(GRADIENT_OPTION);

        expect(first).toContain("linearGradient");
        expect(first).toContain("clipPath");
        expect(second).toBe(first);
    });

    it("writes each start tag as a sequence of double-quoted attributes, thus the file parses as XML", () => {
        for (const option of [GRADIENT_OPTION, { ...GRADIENT_OPTION, legend: { bottom: 0, data: ["Level"] } }]) {
            const svg = svgOf(option);
            const tags = svg.match(/<[a-zA-Z][^>]*>/g) ?? [];
            expect(tags.length).toBeGreaterThan(10);
            // A double quote inside an attribute value ends the value early, and an XML reader then refuses the file.
            expect(tags.filter((tag) => !/^<[a-zA-Z][\w:-]*(\s+[\w:-]+="[^"]*")*\s*\/?>$/.test(tag))).toEqual([]);
        }
    });

    it("renumbers each instance token in order of first appearance, thus each reference still resolves", () => {
        const svg = svgOf(GRADIENT_OPTION);
        const tokens = [...new Set(svg.match(/zr\d+-[a-z]+-?\d+/g) ?? [])];
        expect(tokens.length).toBeGreaterThan(2);
        expect(tokens.every((token) => token.startsWith("zr0-"))).toBe(true);
        // A clip path and a gradient each carry an id, and an element names it in a `url(#...)`.
        for (const id of svg.matchAll(/id="([^"]+)"/g)) {
            expect(svg).toContain(`url(#${id[1]})`);
        }
    });

    it("states the column size in millimeters on the root, and keeps the pixel space in the view box", () => {
        const single = svgOf(GRADIENT_OPTION);
        expect(single.startsWith('<svg width="89mm" height="67mm"')).toBe(true);
        expect(single).toContain('viewBox="0 0 336 253"');
        const double = svgOf(GRADIENT_OPTION, "double");
        expect(double.startsWith('<svg width="183mm" height="92mm"')).toBe(true);
        expect(double).toContain('viewBox="0 0 692 348"');
    });

    it("draws no toolbox and no tooltip, and sets the text at the print size", () => {
        const plain = svgOf(GRADIENT_OPTION);
        const decorated = svgOf({ ...GRADIENT_OPTION, tooltip: { trigger: "item" }, toolbox: { feature: { saveAsImage: {} } } });
        expect(decorated).toBe(plain);
        expect(plain).toContain(`font-size:${CHART_PRINT_TEXT_PX}px`);
        expect(plain).toContain("Helvetica");
        // The axis lines and the series draw, thus the file is a whole figure.
        expect(plain).toContain(">Day<");
        expect(plain).toContain(">Level<");
    });

    it("draws the violin outline and the interval through the bound renderers", () => {
        const rows: ChartRow[] = [];
        for (let index = 0; index < 20; index += 1) rows.push({ k: index % 2 === 0 ? "a" : "b", v: (index * 7) % 11 });
        const block: ChartBlock = {
            kind: "chart",
            id: "v1",
            binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:00" },
            chartType: "violin",
            encoding: { x: "k", y: "v" },
        };
        const inline = deriveChartRender(block, rows, undefined, { key: "v1", columns: [] })._unsafeUnwrap().inline;
        const svg = svgOf(inline);
        expect(svg.match(/<polygon /g)?.length).toBe(2);
        expect(svg).toContain("<circle");
    });
});

describe("the seeded sequence of one export", () => {
    it("puts the original Math.random back after a render that the chart runtime refuses", () => {
        const original = Math.random;
        // The registry holds no renderer under this name, thus the chart runtime throws inside the render.
        const broken = { xAxis: { type: "value" }, yAxis: { type: "value" }, series: [{ type: "custom", renderItem: "no-such-renderer", data: [[1, 2]] }] };
        expect(renderChartSvg(broken, CHART_EXPORT_SIZES.single).isErr()).toBe(true);
        expect(Math.random).toBe(original);
    });

    it("puts the original Math.random back after a render that succeeds", () => {
        const original = Math.random;
        expect(renderChartSvg(GRADIENT_OPTION, CHART_EXPORT_SIZES.single).isOk()).toBe(true);
        expect(Math.random).toBe(original);
    });
});

describe("the SVG assets of one chart", () => {
    it("gives two content-addressed names, one for each column size, and the same names over two renders", () => {
        const first = chartSvgAssets("c1", GRADIENT_OPTION)._unsafeUnwrap();
        const second = chartSvgAssets("c1", GRADIENT_OPTION)._unsafeUnwrap();
        expect(first).toBeDefined();
        expect(first?.single.name).toMatch(/^c-[0-9a-f]{12}-89mm\.svg$/);
        expect(first?.double.name).toMatch(/^c-[0-9a-f]{12}-183mm\.svg$/);
        expect(second).toEqual(first);
    });

    it("gives no asset for a chart past the crowd row count", () => {
        const data: number[][] = [];
        for (let index = 0; index <= SCATTER_CROWD_ROWS; index += 1) data.push([index, index % 13]);
        const crowded = { xAxis: { type: "value" }, yAxis: { type: "value" }, series: [{ type: "scatter", data }] };
        expect(chartSvgAssets("c1", crowded)._unsafeUnwrap()).toBeUndefined();
    });

    it("counts the drawn coordinates for the bound, and never an empty slot", () => {
        const slots: (number | null)[] = [];
        for (let index = 0; index <= SCATTER_CROWD_ROWS; index += 1) slots.push(index % 1000 === 0 ? 1 : null);
        const sparse = {
            xAxis: { type: "category", data: slots.map((_slot, index) => `c${index}`) },
            yAxis: { type: "value" },
            series: [{ type: "bar", stack: "total", data: slots }],
        };
        expect(chartSvgAssets("c1", sparse)._unsafeUnwrap()).toBeDefined();
    });

    it("counts each coordinate of a radar polygon for the bound", () => {
        const value: number[] = [];
        for (let index = 0; index <= SCATTER_CROWD_ROWS; index += 1) value.push(index % 7);
        const radar = {
            radar: { indicator: value.map((_cell, index) => ({ name: `i${index}`, max: 7 })) },
            series: [{ type: "radar", data: [{ name: "one", value }] }],
        };
        expect(chartSvgAssets("c1", radar)._unsafeUnwrap()).toBeUndefined();
    });

    it("refuses an option that the chart runtime cannot draw, and names the block", () => {
        // The registry holds no renderer under this name, thus the chart runtime calls the string as a function.
        const broken = { xAxis: { type: "value" }, yAxis: { type: "value" }, series: [{ type: "custom", renderItem: "no-such-renderer", data: [[1, 2]] }] };
        const problem = chartSvgAssets("c9", broken)._unsafeUnwrapErr();
        expect(problem.blockId).toBe("c9");
        expect(problem.kind).toBe("invalid-chart-input");
    });
});

describe("the export option", () => {
    /** The page twin of the export option. */
    const exportOnThePage = new Function(`${CHART_RENDERERS_SOURCE}\nreturn reportExportOption;`)() as (
        option: EchartOption,
        textPx: number,
        widthPx: number,
        heightPx: number,
    ) => EchartOption;

    const VECTOR: readonly EchartOption[] = [
        GRADIENT_OPTION,
        { ...GRADIENT_OPTION, tooltip: { trigger: "item" }, toolbox: { right: 0 } },
        { ...GRADIENT_OPTION, legend: { bottom: 0 }, grid: { top: "8%", bottom: "20%" } },
        { ...GRADIENT_OPTION, legend: { show: false }, grid: { top: "8%" } },
        {
            grid: { containLabel: true },
            xAxis: { type: "category", data: ["Hypoxia", "Glycolysis", "Angiogenesis", "p53 pathway", "G2M checkpoint", "Apoptosis"] },
            yAxis: { type: "value" },
            visualMap: { type: "continuous", min: -1.6, max: 1.6, calculable: false, text: ["Mito reads of each library (%)\n1.6", "−1.6"] },
            series: [],
        },
        {
            grid: [{ left: "0%" }, { left: "50%" }],
            xAxis: [
                { type: "value", name: "x", nameGap: 34, gridIndex: 0 },
                { type: "value", gridIndex: 1 },
            ],
            yAxis: [
                { type: "value", gridIndex: 0 },
                { type: "value", gridIndex: 1 },
            ],
            graphic: [{ type: "text", left: "0%", top: "0%", style: { text: "s1", fontSize: CHART_PAGE_TEXT_PX } }],
            legend: { bottom: 0 },
            series: [],
        },
        {
            grid: [{ width: "30%" }, { width: 90 }],
            xAxis: [
                { type: "category", data: ["Oxidative phosphorylation", "Interferon gamma response"], gridIndex: 0 },
                { type: "category", data: ["a", "b"], gridIndex: 1 },
            ],
            yAxis: [
                { type: "value", gridIndex: 0 },
                { type: "value", gridIndex: 1 },
            ],
            series: [],
        },
        {
            xAxis: { type: "log", name: "Hazard ratio", nameGap: 34 },
            yAxis: [
                { type: "category", data: ["Karnofsky score\n(physician)"] },
                { type: "category", position: "right", offset: 120, data: ["1.02 (1.00–1.04)"] },
            ],
            series: [],
        },
        {
            xAxis: { type: "category", data: ["B cells"] },
            yAxis: { type: "value" },
            graphic: [
                {
                    type: "group",
                    right: 8,
                    top: 20,
                    children: [
                        { type: "text", x: 0, y: 0, style: { text: "Count", fontSize: CHART_PAGE_TEXT_PX } },
                        { type: "circle", shape: { cx: 3, cy: 20, r: 3 } },
                        { type: "group", children: [{ type: "text", x: 12, y: 20, style: { text: "10", fontSize: CHART_PAGE_TEXT_PX } }] },
                    ],
                },
            ],
            series: [],
        },
        FACETED_LEGEND,
        SIZED_NAMES,
    ];

    it("takes the series of the export width in place of the page series of the sized names", () => {
        const names = (option: EchartOption): unknown[] => (option.series as EchartOption[]).map((series) => [series.name, series.data]);
        const single = exportOption(SIZED_NAMES, CHART_PRINT_TEXT_PX, 336, 253);
        expect(names(single)).toEqual([
            ["Points", [[1, 2]]],
            ["Point names", [{ name: "a", value: [1, 3] }]],
        ]);
        expect(single[SIZED_SERIES_MEMBER]).toBeUndefined();
        // No name finds a place at the double column, thus the export drops the page series of the names.
        expect(names(exportOption(SIZED_NAMES, CHART_PRINT_TEXT_PX, 692, 348))).toEqual([["Points", [[1, 2]]]]);
        // The member holds no series of the slide width, thus the slide keeps the page series.
        expect(names(exportOption(SIZED_NAMES, CHART_SLIDE_TEXT_PX, 1920, 1080))).toEqual(names(SIZED_NAMES));
    });

    it("scales the text of each child of a graphic group, thus a size legend prints at the export text size", () => {
        const print = exportOption(VECTOR[8], CHART_PRINT_TEXT_PX, 336, 253);
        const group = (print.graphic as EchartOption[])[0];
        const [title, circle, inner] = group.children as EchartOption[];
        expect((title.style as EchartOption).fontSize).toBe(CHART_PRINT_TEXT_PX);
        expect(circle).toEqual({ type: "circle", shape: { cx: 3, cy: 20, r: 3 } });
        expect(((inner.children as EchartOption[])[0].style as EchartOption).fontSize as number).toBe(CHART_PRINT_TEXT_PX);
    });

    it("holds the lowest row of facet panels and the x title above the band of a legend that wraps at the column width", () => {
        const print = exportOption(FACETED_LEGEND, CHART_PRINT_TEXT_PX, 336, 253);
        const grids = print.grid as EchartOption[];
        // The eight names of the legend take three lines at the single column.
        const band = legendBandPx(3, CHART_PRINT_TEXT_PX);
        const room = 253 - band - Math.round(CHART_PRINT_TEXT_PX * 1.6);
        for (const grid of grids) {
            // Each panel keeps its labels inside its own box, and the box ends over the title and the legend.
            expect(grid.outerBoundsMode).toBe("same");
            expect(grid.top).toBe("10%");
            expect(((Number.parseFloat(String(grid.top)) + Number.parseFloat(String(grid.height))) * 253) / 100).toBeCloseTo(room, 1);
        }
        const title = (print.graphic as EchartOption[]).find((element) => element.bottom !== undefined);
        expect(title?.bottom).toBe(band);
        // The slide holds the eight names on one line, and its panels keep their boxes.
        const slide = exportOption(FACETED_LEGEND, CHART_SLIDE_TEXT_PX, 1920, 1080);
        expect((slide.grid as EchartOption[])[0].height).toBe("70%");
        expect(((slide.graphic as EchartOption[])[1] as EchartOption).bottom).toBe(legendBandPx(1, CHART_SLIDE_TEXT_PX));
    });

    it("drops the tooltip and the toolbox, stops the animation, and scales the name gap and the panel labels", () => {
        const slide = exportOption(VECTOR[5], CHART_SLIDE_TEXT_PX, 1920, 1080);
        expect(slide.animation).toBe(false);
        expect((slide.xAxis as EchartOption[])[0].nameGap).toBe(68);
        expect(((slide.graphic as EchartOption[])[0].style as EchartOption).fontSize).toBe(CHART_SLIDE_TEXT_PX);
        const print = exportOption(VECTOR[1], CHART_PRINT_TEXT_PX, 336, 253);
        expect(print.tooltip).toBeUndefined();
        expect(print.toolbox).toBeUndefined();
        // The input stays as it is, thus the page keeps its own option.
        expect(VECTOR[1].tooltip).toEqual({ trigger: "item" });
    });

    it("scales the offset of an axis with the text, thus a column of text keeps its room", () => {
        const scale = CHART_PRINT_TEXT_PX / CHART_PAGE_TEXT_PX;
        const [terms, estimates] = exportOption(VECTOR[7], CHART_PRINT_TEXT_PX, 336, 253).yAxis as EchartOption[];
        expect(terms.offset).toBeUndefined();
        expect(estimates.offset).toBe(120 * scale);
        expect(((exportOption(VECTOR[7], CHART_SLIDE_TEXT_PX, 1920, 1080).yAxis as EchartOption[])[1] as EchartOption).offset).toBe(240);
        expect(((VECTOR[7].yAxis as EchartOption[])[1] as EchartOption).offset).toBe(120);
    });

    it("holds the labels and the names of a short export above the band of a bottom legend", () => {
        const print = exportOption(VECTOR[2], CHART_PRINT_TEXT_PX, 336, 253);
        expect(print.grid).toEqual({
            top: "8%",
            bottom: "20%",
            outerBoundsMode: "auto",
            outerBounds: { left: 0, right: 0, top: 0, bottom: Math.round(CHART_PRINT_TEXT_PX * 2.5) },
        });
        // A hidden legend takes no band, and a facet keeps the boxes of its panels.
        expect(exportOption(VECTOR[3], CHART_PRINT_TEXT_PX, 336, 253).grid).toEqual({ top: "8%" });
        expect(Array.isArray(exportOption(VECTOR[5], CHART_PRINT_TEXT_PX, 336, 253).grid)).toBe(true);
    });

    it("gives the same export option on the page as on the server, for each text size", () => {
        for (const option of VECTOR) {
            for (const [size, width, height] of [
                [CHART_PRINT_TEXT_PX, 336, 253],
                [CHART_PRINT_TEXT_PX, 692, 348],
                [CHART_SLIDE_TEXT_PX, 1920, 1080],
            ]) {
                expect(JSON.stringify(exportOnThePage(option, size, width, height))).toBe(JSON.stringify(exportOption(option, size, width, height)));
            }
        }
    });
});

/** The inline option of one quick-path bar block over some rows. */
function barOption(encoding: NonNullable<ChartBlock["encoding"]>, rows: ChartRow[]): EchartOption {
    const block: ChartBlock = { kind: "chart", id: "b1", binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:00" }, chartType: "bar", encoding };
    return deriveChartRender(block, rows, undefined, { key: "b1", columns: [] })._unsafeUnwrap().inline;
}

/**
 * The boxes of each bar with one fill, as `[left, top, right, bottom]`. The server render writes a bar as one
 * move and three relative lines.
 */
function boxesOf(svg: string, fill: string): number[][] {
    const boxes: number[][] = [];
    const number = "(-?[\\d.]+)";
    const bar = new RegExp(`<path d="M${number} ${number}l${number} ${number}l${number} ${number}l${number} ${number}Z"([^>]*)>`, "g");
    for (const match of svg.matchAll(bar)) {
        if (!match[9].includes(`fill="${fill}"`)) continue;
        const xs = [Number(match[1])];
        const ys = [Number(match[2])];
        for (const index of [3, 5, 7]) {
            xs.push(xs[xs.length - 1] + Number(match[index]));
            ys.push(ys[ys.length - 1] + Number(match[index + 1]));
        }
        boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    }
    return boxes;
}

/** The vertical segments in the ink of the chart that a series draws, as `[x, top, bottom]`. The axis lines draw none. */
function verticalInk(svg: string): number[][] {
    const segments: number[][] = [];
    for (const match of svg.matchAll(/<path d="M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)"([^>]*)>/g)) {
        if (!match[5].includes(`stroke="${CHART_INK}"`) || !match[5].includes("ecmeta_series_index") || match[1] !== match[3]) continue;
        segments.push([Number(match[1]), Math.min(Number(match[2]), Number(match[4])), Math.max(Number(match[2]), Number(match[4]))]);
    }
    return segments;
}

describe("the bar of an interval through the server render", () => {
    it("stands each bar on the category axis, with the height of its value", () => {
        const rows: ChartRow[] = [
            { arm: "a", mean: 40, lo: 38, hi: 42 },
            { arm: "b", mean: 30, lo: 27, hi: 33 },
        ];
        const svg = svgOf(barOption({ x: "arm", y: "mean", low: "lo", high: "hi" }, rows), "double");
        const bars = boxesOf(svg, CHART_PALETTE[0]);
        expect(bars.length).toBe(2);
        // The value axis holds zero, thus both bars share one base, and the heights keep the ratio of the values.
        expect(svg).toMatch(/>0<\/text>/);
        expect(bars[0][3]).toBeCloseTo(bars[1][3], 0);
        expect((bars[1][3] - bars[1][1]) / (bars[0][3] - bars[0][1])).toBeCloseTo(0.75, 1);
    });

    it("draws the interval of each group over the center of its own bar", () => {
        const rows: ChartRow[] = [
            { arm: "a", dose: "low", mean: 4, lo: 3, hi: 5 },
            { arm: "a", dose: "high", mean: 6, lo: 5, hi: 7 },
            { arm: "b", dose: "low", mean: 3, lo: 2, hi: 4 },
            { arm: "b", dose: "high", mean: 5, lo: 4, hi: 6 },
        ];
        const svg = svgOf(barOption({ x: "arm", y: "mean", group: "dose", low: "lo", high: "hi" }, rows), "double");
        // The legend draws a filled square of the text size for each group, thus a bar is each wider box.
        const bars = [...boxesOf(svg, CHART_PALETTE[0]), ...boxesOf(svg, CHART_PALETTE[1])].filter((box) => box[2] - box[0] > CHART_PRINT_TEXT_PX + 1);
        const centers = bars.map((box) => (box[0] + box[2]) / 2);
        const whiskers = verticalInk(svg).filter((segment) => segment[2] - segment[1] > 5);
        expect(centers.length).toBe(4);
        expect(whiskers.length).toBe(4);
        for (const whisker of whiskers) {
            expect(Math.min(...centers.map((center) => Math.abs(center - whisker[0])))).toBeLessThan(0.6);
        }
    });
});

describe("the title of a category axis in an export", () => {
    it("draws the title of a horizontal bar clear of its longest term", () => {
        const term = "proteasomal ubiquitin-independent protein catabolic process (GO:0010499)";
        const rows: ChartRow[] = [
            { term, nes: 1.9 },
            { term: "cell-cell junction assembly (GO:0007043)", nes: -1.2 },
        ];
        const block: ChartBlock = {
            kind: "chart",
            id: "nes",
            binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:00", columnLabels: { term: "GO biological process" } },
            chartType: "bar",
            orientation: "horizontal",
            encoding: { x: "term", y: "nes" },
        };
        const svg = svgOf(deriveChartRender(block, rows, undefined, { key: "nes", columns: [] })._unsafeUnwrap().inline, "double");
        // The title turns 90 degrees, thus its transform names its x as the fifth member of the matrix.
        const title = /transform="matrix\(0,-1,1,0,(-?[\d.]+),[^)]*\)"[^>]*>GO biological process</.exec(svg);
        const label = new RegExp(`text-anchor="end"[^>]*transform="translate\\((-?[\\d.]+) [^)]*\\)"[^>]*>${term.replace(/[()]/g, "\\$&")}<`).exec(svg);
        expect(title).not.toBeNull();
        expect(label).not.toBeNull();
        // The label ends at its anchor and runs left at half the text size for each character at least.
        const labelLeft = Number(label?.[1]) - term.length * CHART_PRINT_TEXT_PX * 0.45;
        expect(Number(title?.[1])).toBeLessThan(labelLeft);
    });
});

describe("the renumber of the instance tokens", () => {
    it("keeps a category name that reads as a token, and renumbers the tokens of the runtime alone", () => {
        const option = { ...GRADIENT_OPTION, xAxis: { type: "category", data: ["zr123-cls-1", "b", "c"] } };
        const svg = svgOf(option);
        expect(svg).toContain(">zr123-cls-1<");
        expect(svgOf(option)).toBe(svg);
    });
});

describe("the export option at a column width", () => {
    it("turns the category labels that do not fit the width of the export", () => {
        const names = ["Hypoxia", "Glycolysis", "Angiogenesis", "p53 pathway", "G2M checkpoint", "Apoptosis"];
        const option = { xAxis: { type: "category", data: names, axisLabel: { interval: 0 } }, yAxis: { type: "value" }, series: [] };
        const single = exportOption(option, CHART_PRINT_TEXT_PX, CHART_EXPORT_SIZES.single.widthPx, CHART_EXPORT_SIZES.single.heightPx);
        const slide = exportOption(option, CHART_SLIDE_TEXT_PX, CHART_EXPORT_SIZES.slide.widthPx, CHART_EXPORT_SIZES.slide.heightPx);
        expect(((single.xAxis as EchartOption).axisLabel as EchartOption).rotate).toBe(45);
        expect(((slide.xAxis as EchartOption).axisLabel as EchartOption).rotate).toBeUndefined();
        // An authored rotation stays.
        const turned = { ...option, xAxis: { ...option.xAxis, axisLabel: { interval: 0, rotate: 90 } } };
        expect(((exportOption(turned, CHART_PRINT_TEXT_PX, 336, 253).xAxis as EchartOption).axisLabel as EchartOption).rotate).toBe(90);
    });

    it("wraps the title of a color scale into its band, and keeps the two ends that the page prints", () => {
        const option = {
            xAxis: { type: "value" },
            yAxis: { type: "value" },
            visualMap: [
                { type: "continuous", min: 0.0001, max: 0.13, calculable: false, text: ["Adjusted p\n0.13", "1e-4"] },
                { type: "continuous", show: false, min: 1, max: 2 },
            ],
            series: [],
        };
        const maps = exportOption(option, CHART_PRINT_TEXT_PX, 336, 253).visualMap as EchartOption[];
        // A title wider than the scale band wraps at its spaces, and the upper end stays the last line.
        expect(maps[0]).toEqual(expect.objectContaining({ calculable: false, text: ["Adjusted\np\n0.13", "1e-4"] }));
        // The scale starts at the top of the plot and stays short, thus its lower end never meets the x labels.
        expect(maps[0]).toEqual(expect.objectContaining({ top: "8%", itemHeight: 8 * CHART_PRINT_TEXT_PX }));
        expect(maps[1]).toEqual(option.visualMap[1]);
    });

    it("contains the names of a grid that contains its labels, thus a name at the top edge draws whole", () => {
        const option = {
            grid: { containLabel: true, left: "10%" },
            xAxis: { type: "value" },
            yAxis: { type: "category", data: ["a"], name: "Biopsy" },
            series: [],
        };
        expect(exportOption(option, CHART_PRINT_TEXT_PX, 336, 253).grid).toEqual({
            containLabel: false,
            left: "10%",
            outerBoundsMode: "auto",
            outerBoundsContain: "all",
        });
    });
});

/**
 * The horizontal extent of each text element of an SVG whose text is one of `lines`, as `[left, right]`. The
 * width is the estimate of the export: each character takes 0.6 of the text size.
 */
function textExtents(svg: string, lines: readonly string[]): number[][] {
    const extents: number[][] = [];
    for (const match of svg.matchAll(/<text[^>]*?(?:\sx="(-?[\d.]+)")?[^>]*transform="translate\((-?[\d.]+) (-?[\d.]+)\)"[^>]*>([^<]*)<\/text>/g)) {
        if (!lines.includes(match[4])) continue;
        const center = Number(match[2]) + Number(match[1] ?? 0);
        const half = (match[4].length * CHART_PRINT_TEXT_PX * 0.6) / 2;
        extents.push([center - half, center + half]);
    }
    return extents;
}

/** The right end of the rightmost x axis line of an SVG: the right edge of the plot. */
function plotRightEdge(svg: string): number {
    let edge = 0;
    for (const match of svg.matchAll(/<path d="M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)"[^>]*stroke="#222222"[^>]*stroke-linecap/g)) {
        if (match[2] === match[4]) edge = Math.max(edge, Number(match[3]));
    }
    return edge;
}

describe("the title of a color scale in the column export", () => {
    const TITLE = "Mito reads (%)";

    /** Check that each line of the title stays inside the canvas and at the right of the plot. */
    function expectClear(svg: string): void {
        const lines = svg.match(/>([^<]*)<\/text>/g)?.map((text) => text.slice(1, -7)) ?? [];
        const titleLines = lines.filter((line) => TITLE.includes(line) && line.length > 1 && !/^\d/.test(line));
        expect(titleLines.join(" ")).toBe(TITLE);
        const edge = plotRightEdge(svg);
        expect(edge).toBeGreaterThan(0);
        for (const [left, right] of textExtents(svg, titleLines)) {
            expect(left).toBeGreaterThanOrEqual(edge);
            expect(right).toBeLessThanOrEqual(CHART_EXPORT_SIZES.single.widthPx);
        }
    }

    it("wraps a long title into the band of the scale, thus it never reaches the plot", () => {
        const option = {
            grid: { right: `${COLOR_SCALE_BAND_PCT}%` },
            xAxis: { type: "value" },
            yAxis: { type: "value" },
            visualMap: [
                {
                    type: "continuous",
                    seriesIndex: [0],
                    dimension: 2,
                    min: 4,
                    max: 9.9,
                    calculable: false,
                    orient: "vertical",
                    right: 0,
                    top: "middle",
                    text: [`${TITLE}\n9.9`, "4"],
                },
            ],
            series: [
                {
                    type: "scatter",
                    data: [
                        [30, 15, 4],
                        [55, 20, 9.9],
                    ],
                },
            ],
        };
        expectClear(svgOf(option));
        // The page keeps its title as it is.
        expect(option.visualMap[0].text).toEqual([`${TITLE}\n9.9`, "4"]);
    });

    it("keeps the title of a faceted scatter clear of its rightmost panel", () => {
        // Four panels of twelve libraries each, colored on one scale by the share of mitochondrial reads.
        const rows: ChartRow[] = [];
        for (const [b, batch] of ["Batch 1", "Batch 2", "Batch 3", "Batch 4"].entries()) {
            for (let index = 0; index < 12; index += 1) {
                const depth = 30 + (((b * 12 + index) * 7) % 25);
                rows.push({ batch, depth_m: depth, genes_k: 12 + depth * 0.12, mito_pct: 4 + ((index * 5 + b) % 60) / 10 });
            }
        }
        const block: ChartBlock = {
            kind: "chart",
            id: "batches",
            binding: { kind: "artifact-table", path: "libraries.csv", hash: "sha256:00", columnLabels: { mito_pct: TITLE } },
            chartType: "scatter",
            encoding: { x: "depth_m", y: "genes_k", color: "mito_pct", facet: "batch" },
        };
        const inline = deriveChartRender(block, rows, undefined, { key: block.id, columns: [] })._unsafeUnwrap().inline;
        expectClear(svgOf(inline));
    });
});

describe("the export of a faceted chart", () => {
    /** The inline option of one faceted bar over long category names. */
    function facetedBars(): EchartOption {
        const names = ["Oxidative phosphorylation", "Epithelial mesenchymal transition", "Unfolded protein response", "Interferon gamma response"];
        const rows: ChartRow[] = [];
        for (const panel of ["p1", "p2", "p3"]) for (const [index, name] of names.entries()) rows.push({ panel, k: name, v: index + 1 });
        const block: ChartBlock = {
            kind: "chart",
            id: "f1",
            binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:00" },
            chartType: "bar",
            encoding: { x: "k", y: "v", facet: "panel" },
        };
        return deriveChartRender(block, rows, undefined, { key: "f1", columns: [] })._unsafeUnwrap().inline;
    }

    it("turns the category labels of each panel against the width of its own grid", () => {
        const exported = exportOption(facetedBars(), CHART_PRINT_TEXT_PX, CHART_EXPORT_SIZES.single.widthPx, CHART_EXPORT_SIZES.single.heightPx);
        const axes = exported.xAxis as EchartOption[];
        expect(axes.length).toBe(3);
        for (const axis of axes) expect([45, 90]).toContain((axis.axisLabel as EchartOption).rotate);
    });

    it("keeps the value label of the tallest faceted bar inside its panel", () => {
        const rows: ChartRow[] = [];
        for (const panel of ["p1", "p2"]) for (const k of ["a", "b"]) rows.push({ panel, k, v: k === "a" ? 10 : 4 });
        const block: ChartBlock = {
            kind: "chart",
            id: "f2",
            binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:00" },
            chartType: "bar",
            encoding: { x: "k", y: "v", facet: "panel" },
        };
        const svg = svgOf(deriveChartRender(block, rows, undefined, { key: "f2", columns: [] })._unsafeUnwrap().inline, "double");
        // The top of each panel is the upper end of its y axis line.
        const tops = [...svg.matchAll(/<path d="M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)"[^>]*stroke="#222222"[^>]*stroke-linecap/g)]
            .filter((match) => match[1] === match[3])
            .map((match) => Math.min(Number(match[2]), Number(match[4])));
        const labels = [
            ...svg.matchAll(/<text[^>]*?y="(-?[\d.]+)"[^>]*transform="translate\((-?[\d.]+) (-?[\d.]+)\)"[^>]*paint-order="stroke"[^>]*>10<\/text>/g),
        ].map((match) => Number(match[3]) + Number(match[1]));
        expect(tops.length).toBeGreaterThan(0);
        expect(labels.length).toBe(2);
        for (const label of labels) expect(label).toBeGreaterThanOrEqual(Math.min(...tops));
    });
});

describe("the export bound of a violin", () => {
    /** The inline option of one violin over `count` categories of five values each. */
    function violins(count: number): EchartOption {
        const rows: ChartRow[] = [];
        for (let category = 0; category < count; category += 1) {
            for (let index = 0; index < 5; index += 1) rows.push({ k: `c${category}`, v: index + (category % 4) });
        }
        const block: ChartBlock = {
            kind: "chart",
            id: "v1",
            binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:00" },
            chartType: "violin",
            encoding: { x: "k", y: "v" },
        };
        return deriveChartRender(block, rows, undefined, { key: "v1", columns: [] })._unsafeUnwrap().inline;
    }

    it("counts each vertex of an outline, thus 100 violins pass the point bound and give no SVG", () => {
        // Each outline draws 128 vertices, thus 100 outlines draw 12800, past the crowd count of 10000. The 100
        // slots stay far under the slot bound, thus the derivation keeps the chart.
        expect(chartSvgAssets("v1", violins(100))._unsafeUnwrap()).toBeUndefined();
    });

    it("keeps both SVG files of a violin chart under the point bound", () => {
        const assets = chartSvgAssets("v1", violins(10))._unsafeUnwrap();
        expect(assets?.single.name).toMatch(/-89mm\.svg$/);
        expect(assets?.double.name).toMatch(/-183mm\.svg$/);
    });
});
