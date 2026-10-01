import { describe, expect, it } from "bun:test";
import * as echarts from "echarts";

import type { ChartBlock, ChartType } from "../contracts/report-blocks.js";
import { deriveChartRender, type ChartInputs, type ChartRow } from "./chart.js";
import { registerChartRenderers } from "./chart-renderers.js";
import { CHART_PAGE_WIDTH_PX, ECHARTS_THEME, ECHARTS_THEME_NAME } from "./design.js";
import {
    CHART_TOOLBOX_SOURCE,
    chartMenuId,
    chartToolbox,
    DATA_VIEW_FUNCTION,
    DATA_VIEW_ROW_LIMIT,
    DENSE_CARTESIAN_CHARTS,
    chartMenuControlId,
    EXPORT_MENU_FUNCTION,
    MENU_CONTROL_ATTRIBUTE,
    MENU_FAULT_CLASS,
    MENU_FAULT_SHOWN_CLASS,
    MENU_OPEN_CLASS,
    pageChartOption,
    TOOLBOX_FUNCTION_MEMBERS,
    TOOLBOX_PAGE_FUNCTIONS,
    TOOLBOX_ZLEVEL,
} from "./chart-toolbox.js";

/** The feature member of one toolbox. */
function features(toolbox: Record<string, unknown>): Record<string, Record<string, unknown>> {
    return toolbox.feature as Record<string, Record<string, unknown>>;
}

interface DataView {
    columns: string[];
    rows: string[][];
    total: number;
}

/** A node of the stub document: its tag, its class, its text, its children, and its attributes. */
interface StubNode {
    tag: string;
    className: string;
    textContent: string;
    children: StubNode[];
    classList: { add(name: string): void; remove(name: string): void; contains(name: string): boolean };
    style: Record<string, string>;
    attributes: Record<string, string>;
    appendChild(child: StubNode): void;
    focus(): void;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    closest(selector: string): StubNode | null;
    querySelector(selector: string): StubNode | null;
    querySelectorAll(selector: string): StubNode[];
}

/** The page functions of the fragment, over one stub document. */
function pageFunctions(document: unknown): {
    rows: (option: Record<string, unknown>, limit: number) => DataView;
    content: (option: Record<string, unknown>) => StubNode;
    bind: (option: Record<string, unknown>) => void;
    open: (model: unknown, api: unknown, icon: string, event: unknown) => void;
    click: (event: unknown) => void;
    key: (event: unknown) => void;
    fault: (entry: unknown) => void;
    named: Record<string, unknown>;
} {
    return new Function(
        "document",
        `${CHART_TOOLBOX_SOURCE}\nreturn { rows: reportDataViewRows, content: reportDataViewContent, bind: reportBindToolbox, open: reportOpenExportMenu, click: reportMenuClick, key: reportMenuKey, fault: reportMenuFault, named: reportToolboxFunctions };`,
    )(document) as ReturnType<typeof pageFunctions>;
}

/** A stub document that builds nodes, holds a focus, and finds one element by its id. */
function stubDocument(byId: Record<string, StubNode> = {}): {
    document: Record<string, unknown>;
    node: (tag: string, attributes?: Record<string, string>) => StubNode;
} {
    const document: Record<string, unknown> = { activeElement: null };
    function node(tag: string, attributes: Record<string, string> = {}): StubNode {
        const classes = new Set<string>();
        const self: StubNode = {
            tag,
            className: "",
            textContent: "",
            children: [],
            classList: {
                add: (name) => classes.add(name),
                remove: (name) => classes.delete(name),
                contains: (name) => classes.has(name),
            },
            style: {},
            attributes,
            appendChild: (child) => {
                self.children.push(child);
            },
            focus: () => {
                document.activeElement = self;
            },
            getAttribute: (name) => attributes[name] ?? null,
            setAttribute: (name, value) => {
                attributes[name] = value;
            },
            closest: (selector) => {
                if (selector === '[role="menu"]') return byId.menu ?? null;
                if (selector === `[${MENU_CONTROL_ATTRIBUTE}]`) return attributes[MENU_CONTROL_ATTRIBUTE] !== undefined ? self : null;
                return attributes.role === "menuitem" ? self : null;
            },
            querySelector: (selector) =>
                self.children.find((child) => selector === `.${MENU_FAULT_CLASS}` && child.attributes.class === MENU_FAULT_CLASS) ?? null,
            querySelectorAll: () => self.children.filter((child) => child.attributes.role === "menuitem" && child.attributes["aria-disabled"] !== "true"),
        };
        return self;
    }
    document.createElement = (tag: string) => node(tag);
    document.getElementById = (id: string) => byId[id] ?? null;
    return { document, node };
}

describe("the toolbox of a page chart", () => {
    it("gives each chart the data view and the download control, with the download control last", () => {
        const toolbox = chartToolbox("bar");
        expect(Object.keys(features(toolbox))).toEqual(["dataView", "myExport"]);
        expect(features(toolbox).myExport).toEqual(expect.objectContaining({ show: true, onclick: EXPORT_MENU_FUNCTION }));
        expect(String(features(toolbox).myExport.icon).startsWith("path://")).toBe(true);
        expect(features(toolbox).dataView).toEqual(expect.objectContaining({ readOnly: true, optionToContent: DATA_VIEW_FUNCTION }));
        expect(toolbox).toEqual(expect.objectContaining({ show: true, right: expect.any(Number), top: 0 }));
    });

    it("adds the zoom and the restore controls to each dense cartesian chart type alone", () => {
        const all: ChartType[] = ["bar", "line", "heatmap", "pie", "box", "violin", "km", "forest", "roc", "pca", "dotplot", "gsea", "oncoprint", "lollipop"];
        for (const chartType of DENSE_CARTESIAN_CHARTS) {
            expect(Object.keys(features(chartToolbox(chartType)))).toEqual(["dataZoom", "restore", "dataView", "myExport"]);
        }
        for (const chartType of all) {
            expect(Object.keys(features(chartToolbox(chartType)))).toEqual(["dataView", "myExport"]);
        }
        expect(Object.keys(features(chartToolbox(undefined)))).toEqual(["dataView", "myExport"]);
        expect([...DENSE_CARTESIAN_CHARTS].sort()).toEqual(["embedding", "locuszoom", "ma", "manhattan", "qq", "scatter", "volcano"]);
    });

    it("holds no magic type, because a reader must not change the form that the author chose", () => {
        for (const chartType of DENSE_CARTESIAN_CHARTS) expect(features(chartToolbox(chartType)).magicType).toBeUndefined();
    });

    it("stays JSON: each handler is the name of a page function", () => {
        const toolbox = chartToolbox("manhattan");
        expect(JSON.parse(JSON.stringify(toolbox))).toEqual(toolbox);
    });

    it("adds the toolbox to a copy of the derived option, and leaves the derived option as it is", () => {
        const derived = { series: [] };
        const page = pageChartOption(derived, "volcano");
        expect(page.toolbox).toEqual(chartToolbox("volcano"));
        expect("toolbox" in derived).toBe(false);
    });

    it("names the menu of a chart after its container", () => {
        expect(chartMenuId("chart-gwas")).toBe("chart-gwas-menu");
    });
});

describe("the canvas layer of the toolbox", () => {
    /** The count of drawn elements on each canvas layer of one option, keyed by the layer. */
    function layerCounts(option: Record<string, unknown>): Record<string, number> {
        const chart = echarts.init(null, undefined, { renderer: "svg", ssr: true, width: 600, height: 400 });
        try {
            chart.setOption(option);
            const counts: Record<string, number> = {};
            for (const element of chart.getZr().storage.getDisplayList(true)) counts[element.zlevel] = (counts[element.zlevel] ?? 0) + 1;
            return counts;
        } finally {
            chart.dispose();
        }
    }

    it("holds the toolbox alone, also over the layers that the runtime gives a dense series", () => {
        const data: number[][] = [];
        for (let index = 0; index < 4000; index += 1) data.push([index, index % 7]);
        const plain = {
            xAxis: { type: "value" },
            yAxis: { type: "value" },
            legend: {},
            series: [
                { type: "scatter", name: "a", data },
                { type: "scatter", name: "b", data: data.slice(0, 10) },
            ],
        };
        const option = pageChartOption(plain, "scatter");
        pageFunctions(stubDocument().document).bind(option);
        const bare = layerCounts(plain);
        const shown = layerCounts(option);
        // A series past the chunk threshold of the runtime takes a layer of its own, and each later component rises one layer.
        expect(Object.keys(bare).length).toBeGreaterThan(2);
        expect(shown[TOOLBOX_ZLEVEL]).toBeGreaterThan(0);
        expect(Object.fromEntries(Object.entries(shown).filter(([zlevel]) => Number(zlevel) !== TOOLBOX_ZLEVEL))).toEqual(bare);
    });
});

describe("the band of the toolbox", () => {
    const HASH = `sha256:${"a".repeat(64)}`;

    /** One box in the pixels of a chart body, with y down. */
    interface Box {
        readonly left: number;
        readonly top: number;
        readonly right: number;
        readonly bottom: number;
    }

    /** One element that the runtime draws. */
    type Drawn = ReturnType<ReturnType<echarts.ECharts["getZr"]>["storage"]["getDisplayList"]>[number];

    /** The box of one drawn element in the pixels of the chart body. */
    function drawnBox(element: Drawn): Box {
        const rect = element.getBoundingRect().clone();
        if (element.transform) rect.applyTransform(element.transform);
        return { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height };
    }

    /** One box as text, to one decimal. */
    function boxText(box: Box): string {
        return `x ${box.left.toFixed(1)} to ${box.right.toFixed(1)}, y ${box.top.toFixed(1)} to ${box.bottom.toFixed(1)}`;
    }

    /**
     * Each plot area and each drawn text that the toolbox covers on the page. The chart draws as the page draws
     * it: the page option of the block, the page theme, the named renderers, and the body box of its card. The
     * box of the toolbox is the box that the runtime lays out for it, thus it holds the padding and the hit area
     * of each icon. A pixel is under the toolbox when its center is inside that box, thus a plot that starts at
     * the bottom edge of the toolbox is clear of it.
     */
    function underToolbox(block: ChartBlock, rows: readonly ChartRow[], inputs: ChartInputs = {}): string[] {
        const columns = Object.keys(rows[0]);
        const render = deriveChartRender(block, rows, columns, { key: block.id, columns }, inputs)._unsafeUnwrap();
        const width = render.widthPx ?? CHART_PAGE_WIDTH_PX;
        const option = pageChartOption(render.option, block.chartType);
        pageFunctions(stubDocument().document).bind(option);
        echarts.registerTheme(ECHARTS_THEME_NAME, ECHARTS_THEME);
        registerChartRenderers({ registerCustomSeries: (name, draw) => echarts.registerCustomSeries(name, draw as unknown as echarts.CustomSeriesRenderItem) });
        const chart = echarts.init(null, ECHARTS_THEME_NAME, { renderer: "svg", ssr: true, width, height: render.bodyPx });
        try {
            chart.setOption(option);
            const drawn = chart.getZr().storage.getDisplayList(true);
            const parts = drawn.filter((element) => element.zlevel === TOOLBOX_ZLEVEL).map(drawnBox);
            const box: Box = {
                left: Math.min(...parts.map((part) => part.left)),
                top: Math.min(...parts.map((part) => part.top)),
                right: Math.max(...parts.map((part) => part.right)),
                bottom: Math.max(...parts.map((part) => part.bottom)),
            };
            const covered: string[] = [];
            const grids = Array.isArray(option.grid) ? option.grid.length : 1;
            for (let grid = 0; grid < grids; grid += 1) {
                let hit: string | undefined;
                for (let x = Math.ceil(box.left - 0.5); x + 0.5 < box.right && hit === undefined; x += 1) {
                    for (let y = Math.ceil(box.top - 0.5); y + 0.5 < box.bottom && hit === undefined; y += 1) {
                        if (chart.containPixel({ gridIndex: grid }, [x + 0.5, y + 0.5]))
                            hit = `the plot area of grid ${grid} at (${x}, ${y}), under the toolbox at ${boxText(box)}`;
                    }
                }
                if (hit !== undefined) covered.push(hit);
            }
            for (const element of drawn) {
                if (element.zlevel === TOOLBOX_ZLEVEL || element.type !== "tspan") continue;
                const text = drawnBox(element);
                if (text.left < box.right && text.right > box.left && text.top < box.bottom && text.bottom > box.top) {
                    covered.push(`the text "${String(element.style.text)}" at ${boxText(text)}, under the toolbox at ${boxText(box)}`);
                }
            }
            return covered;
        } finally {
            chart.dispose();
        }
    }

    it("leaves the plot and each text of a bar chart clear of the toolbox", () => {
        const block: ChartBlock = {
            kind: "chart",
            id: "b1",
            binding: { kind: "artifact-table", path: "counts.csv", hash: HASH },
            chartType: "bar",
            encoding: { x: "gene", y: "count" },
        };
        const rows: ChartRow[] = [
            { gene: "TP53", count: 12 },
            { gene: "KRAS", count: 30 },
            { gene: "EGFR", count: 21 },
        ];
        expect(underToolbox(block, rows)).toEqual([]);
    });

    it("leaves the column titles of a forest clear of the toolbox", () => {
        // The Cox model of the NCCTG lung table, as the forest figure test reads it.
        const block: ChartBlock = {
            kind: "chart",
            id: "f1",
            binding: { kind: "artifact-table", path: "cox_forest.csv", hash: HASH, columnLabels: { term: "Covariate", hr: "Hazard ratio", pvalue: "p-value" } },
            chartType: "forest",
            encoding: { y: "term", x: "hr", low: "lower", high: "upper", p: "pvalue" },
        };
        const rows: ChartRow[] = [
            { term: "Age (per year)", hr: 1.0152725322439, lower: 0.99603004960191, upper: 1.03488676384906, pvalue: 0.120538258209777 },
            { term: "Female vs male", hr: 0.531834967483113, lower: 0.375837377499962, upper: 0.752581966485737, pvalue: 0.00036433764194166 },
            { term: "ECOG performance score", hr: 2.09636398838477, lower: 1.44080207397493, upper: 3.05020519554927, pvalue: 0.000109424049741189 },
            { term: "Karnofsky score (physician)", hr: 1.01536757487862, lower: 0.996056535985802, upper: 1.03505300639841, pvalue: 0.119552522237802 },
            { term: "Weight loss (lb)", hr: 0.990745350649488, lower: 0.977821803396287, upper: 1.00383970415085, pvalue: 0.165167923804808 },
        ];
        expect(underToolbox(block, rows)).toEqual([]);
    });

    it("leaves the square of a ROC curve clear of the toolbox", () => {
        // An excerpt of the ROC table of the NCCTG lung data, as the ROC figure test reads it, with the AUC of each model.
        const full = "ECOG + Karnofsky + age";
        const alone = "ECOG alone";
        const auc = (label: string, row: number): NonNullable<ChartBlock["statistics"]>[number] => ({
            label,
            value: { kind: "artifact-value", path: "roc_auc.csv", hash: HASH, locator: { column: "auc", row } },
        });
        const block: ChartBlock = {
            kind: "chart",
            id: "r1",
            binding: { kind: "artifact-table", path: "roc.csv", hash: HASH, columnLabels: { fpr: "False positive rate", tpr: "True positive rate" } },
            chartType: "roc",
            encoding: { x: "fpr", y: "tpr", group: "model" },
            statistics: [auc(`AUC, ${full}`, 0), auc(`AUC, ${alone}`, 1)],
        };
        const rows: ChartRow[] = [
            { fpr: 0, tpr: 0, model: full },
            { fpr: 0.0154, tpr: 0.0168, model: full },
            { fpr: 0, tpr: 0.0084, model: full },
            { fpr: 0.4, tpr: 0.62, model: full },
            { fpr: 1, tpr: 1, model: full },
            { fpr: 0, tpr: 0, model: alone },
            { fpr: 0, tpr: 0.0083, model: alone },
            { fpr: 0.1385, tpr: 0.3167, model: alone },
            { fpr: 0.6615, tpr: 0.8, model: alone },
            { fpr: 1, tpr: 1, model: alone },
        ];
        const inputs: ChartInputs = {
            statistics: [
                { label: `AUC, ${full}`, value: 0.626761473820297 },
                { label: `AUC, ${alone}`, value: 0.619166666666667 },
            ],
        };
        expect(underToolbox(block, rows, inputs)).toEqual([]);
    });

    it("leaves the square of an embedding clear of the wide toolbox of a dense chart", () => {
        // An excerpt of the PBMC 3k UMAP table, as the embedding figure test reads it.
        const block: ChartBlock = {
            kind: "chart",
            id: "e1",
            binding: { kind: "artifact-table", path: "cells.csv", hash: HASH },
            chartType: "embedding",
            encoding: { x: "UMAP_1", y: "UMAP_2", group: "cluster" },
        };
        const rows: ChartRow[] = [
            { UMAP_1: 1.35285573560809, UMAP_2: 2.26612718696679, cluster: "CD4 T" },
            { UMAP_1: 2.165888749165179, UMAP_2: -0.2448122627872643, cluster: "CD4 T" },
            { UMAP_1: -0.47802448287846216, UMAP_2: 7.877304234882818, cluster: "B" },
            { UMAP_1: -0.2, UMAP_2: 8.4, cluster: "B" },
            { UMAP_1: -8.69549315663449, UMAP_2: 4.516540904583949, cluster: "CD14 Monocytes" },
            { UMAP_1: -8.1, UMAP_2: 3.9, cluster: "CD14 Monocytes" },
        ];
        expect(underToolbox(block, rows)).toEqual([]);
    });

    it("leaves the top panel of a GSEA plot and its statistics clear of the toolbox", () => {
        // One set whose running score peaks above zero, thus the statistics sit at the top right of the top panel.
        const block: ChartBlock = {
            kind: "chart",
            id: "g1",
            binding: { kind: "artifact-table", path: "gsea_running.csv", hash: HASH },
            chartType: "gsea",
            encoding: { x: "rank", y: "running_es", group: "term", hit: "hit", metric: "ranked_metric" },
            statistics: [{ label: "NES", value: { kind: "artifact-value", path: "gsea_results.csv", hash: HASH, locator: { column: "NES", row: 0 } } }],
        };
        const hits = new Set([1, 2, 4, 7]);
        let score = 0;
        const rows: ChartRow[] = Array.from({ length: 20 }, (_entry, index) => {
            const rank = index + 1;
            score += hits.has(rank) ? 0.25 : -1 / 16;
            return { term: "cell-cell junction assembly", rank, running_es: score, hit: hits.has(rank) ? 1 : 0, ranked_metric: 10 - rank };
        });
        expect(underToolbox(block, rows, { statistics: [{ label: "NES", value: 1.9 }] })).toEqual([]);
    });

    it("leaves the legend and the statistics of a survival curve clear of the toolbox", () => {
        // An excerpt of the Kaplan-Meier table of the NCCTG lung data by sex, as the km figure test reads it.
        const block: ChartBlock = {
            kind: "chart",
            id: "k1",
            binding: { kind: "artifact-table", path: "km_curve.csv", hash: HASH },
            chartType: "km",
            encoding: { x: "time", y: "surv", group: "strata", low: "lower", high: "upper", censor: "n_censor", risk: "n_risk" },
            statistics: [{ label: "Log-rank p", value: { kind: "artifact-value", path: "logrank.csv", hash: HASH, locator: { column: "pvalue", row: 0 } } }],
        };
        const rows: ChartRow[] = [
            { strata: "Female", time: 0, surv: 1, lower: 1, upper: 1, n_risk: 90, n_censor: 0 },
            { strata: "Female", time: 371, surv: 0.509, lower: 0.386, upper: 0.619, n_risk: 30, n_censor: 1 },
            { strata: "Female", time: 765, surv: 0.083, lower: 0.019, upper: 0.212, n_risk: 3, n_censor: 1 },
            { strata: "Male", time: 0, surv: 1, lower: 1, upper: 1, n_risk: 138, n_censor: 0 },
            { strata: "Male", time: 270, surv: 0.494, lower: 0.406, upper: 0.576, n_risk: 59, n_censor: 0 },
            { strata: "Male", time: 883, surv: 0.036, lower: 0.009, upper: 0.097, n_risk: 3, n_censor: 1 },
        ];
        expect(underToolbox(block, rows, { statistics: [{ label: "Log-rank p", value: 0.00131116452035549 }] })).toEqual([]);
    });
});

describe("the bootstrap binding of the toolbox", () => {
    it("holds a page function for each name that a toolbox can carry", () => {
        const { document } = stubDocument();
        const named = pageFunctions(document).named;
        expect(Object.keys(named).sort()).toEqual([...TOOLBOX_PAGE_FUNCTIONS].sort());
        for (const name of TOOLBOX_PAGE_FUNCTIONS) expect(typeof named[name]).toBe("function");
        // Each handler name of a toolbox is a page function, thus the bootstrap binds each one.
        for (const feature of Object.values(features(chartToolbox("qq")))) {
            for (const member of TOOLBOX_FUNCTION_MEMBERS) {
                if (typeof feature[member] === "string") expect(TOOLBOX_PAGE_FUNCTIONS).toContain(feature[member] as (typeof TOOLBOX_PAGE_FUNCTIONS)[number]);
            }
        }
    });

    it("replaces each handler name with its function, and removes a name that the page does not hold", () => {
        const { document } = stubDocument();
        const page = pageFunctions(document);
        const option = pageChartOption({ series: [] }, "scatter");
        features(option.toolbox as Record<string, unknown>).restore.onclick = "constructor";
        page.bind(option);
        const bound = features(option.toolbox as Record<string, unknown>);
        expect(bound.myExport.onclick).toBe(page.named[EXPORT_MENU_FUNCTION]);
        expect(bound.dataView.optionToContent).toBe(page.named[DATA_VIEW_FUNCTION]);
        expect("onclick" in bound.restore).toBe(false);
    });

    it("leaves an option with no toolbox as it is", () => {
        const { document } = stubDocument();
        const option = { series: [] };
        pageFunctions(document).bind(option);
        expect(option).toEqual({ series: [] });
    });
});

describe("the data view", () => {
    const { document } = stubDocument();
    const page = pageFunctions(document);

    it("reads each number of a category axis as its category, and names each column by its axis", () => {
        const view = page.rows(
            {
                xAxis: { type: "category", name: "Sample", data: ["s1", { value: "s2" }] },
                yAxis: { type: "category", name: "Gene", data: ["TP53"] },
                series: [
                    {
                        type: "heatmap",
                        name: "z",
                        data: [
                            [0, 0, 1.23456789],
                            [1, 0, -2],
                        ],
                    },
                ],
            },
            DATA_VIEW_ROW_LIMIT,
        );
        expect(view).toEqual({
            columns: ["Series", "Sample", "Gene", "Value 3"],
            rows: [
                ["z", "s1", "TP53", "1.23457"],
                ["z", "s2", "TP53", "-2"],
            ],
            total: 2,
        });
    });

    it("pairs a bar value with its category, and keeps the name of each point", () => {
        const bars = page.rows(
            { xAxis: { type: "category", data: ["a", "b"] }, yAxis: { type: "value" }, series: [{ type: "bar", name: "n", data: [3, 4] }] },
            10,
        );
        expect(bars.rows).toEqual([
            ["n", "a", "3"],
            ["n", "b", "4"],
        ]);
        const points = page.rows(
            {
                xAxis: { type: "value", name: "effect" },
                yAxis: { type: "value" },
                series: [{ type: "scatter", name: "Up", data: [{ name: "FTO", value: [1.5, 20] }] }],
            },
            10,
        );
        expect(points.columns).toEqual(["Series", "Name", "effect", "y"]);
        expect(points.rows).toEqual([["Up", "FTO", "1.5", "20"]]);
    });

    it("skips a series that the reader cannot hover, because it holds no data of the figure", () => {
        const view = page.rows(
            {
                xAxis: { type: "value" },
                yAxis: { type: "value" },
                series: [
                    { type: "scatter", name: "points", data: [[1, 2]] },
                    { type: "scatter", name: "Point names", silent: true, data: [{ name: "FTO", value: [3, 4] }] },
                    { type: "line", name: "guide", tooltip: { show: false }, data: [[0, 0]] },
                ],
            },
            10,
        );
        expect(view.rows).toEqual([["points", "1", "2"]]);
    });

    it("stops at the row limit and still counts each row", () => {
        const data: number[][] = [];
        for (let index = 0; index < 25; index += 1) data.push([index, index]);
        const view = page.rows({ xAxis: { type: "value" }, yAxis: { type: "value" }, series: [{ type: "scatter", name: "s", data }] }, 10);
        expect(view.rows.length).toBe(10);
        expect(view.total).toBe(25);
    });

    it("builds one plain table with a note of the rows that it holds back, and writes each cell as text", () => {
        const data: (number | Record<string, unknown>)[][] = [];
        for (let index = 0; index < DATA_VIEW_ROW_LIMIT + 5; index += 1) data.push([index, index]);
        const root = page.content({ xAxis: { type: "value" }, yAxis: { type: "value" }, series: [{ type: "scatter", name: "<b>x</b>", data }] });
        expect(root.className).toBe("report-data-view");
        const [note, table] = root.children;
        expect(note.textContent).toBe("The view shows the first 1,000 of 1,005 rows.");
        const [head, body] = table.children;
        expect(head.children[0].children.map((cell) => cell.textContent)).toEqual(["Series", "x", "y"]);
        expect(body.children.length).toBe(DATA_VIEW_ROW_LIMIT);
        expect(body.children[0].children[0].textContent).toBe("<b>x</b>");
    });
});

describe("the download menu", () => {
    /**
     * One open menu under a container of 600 × 400 pixels at the place 16, 16 of its card. The event of the icon
     * opens it, and the container holds the one node `inside`.
     */
    function openMenu(
        event: { event: { type: string } } = { event: { type: "click" } },
        inside: object = {},
    ): { page: ReturnType<typeof pageFunctions>; menu: StubNode; items: StubNode[]; document: Record<string, unknown>; event: { event: object } } {
        const byId: Record<string, StubNode> = {};
        const { document, node } = stubDocument(byId);
        const menu = node("div", { role: "menu" });
        Object.assign(menu, { offsetWidth: 140 });
        const items = [node("a", { role: "menuitem" }), node("button", { role: "menuitem" }), node("button", { role: "menuitem" })];
        for (const item of items) menu.appendChild(item);
        byId["chart-gwas-menu"] = menu;
        byId.menu = menu;
        const page = pageFunctions(document);
        const container = { id: "chart-gwas", offsetLeft: 16, offsetTop: 16, clientWidth: 600, contains: (target: unknown) => target === inside };
        page.open({}, { getDom: () => container }, "myExport", event);
        return { page, menu, items, document, event };
    }

    it("opens the menu of the chart under the download icon, and gives the focus to the first entry", () => {
        const { menu, items, document } = openMenu();
        expect(menu.classList.contains(MENU_OPEN_CLASS)).toBe(true);
        // The right edge of the menu meets the right edge of the icon: the card place, the body width, less the gap and the padding.
        expect(menu.style.left).toBe(`${16 + 600 - 9 - 140}px`);
        expect(menu.style.top).toBe(`${16 + 0 + 5 + 14 + 4}px`);
        expect(document.activeElement).toBe(items[0]);
    });

    it("moves the focus with the arrow keys, Home, and End, and wraps at each end", () => {
        const { page, items, document } = openMenu();
        const press = (key: string) => page.key({ key, preventDefault: () => undefined });
        press("ArrowDown");
        expect(document.activeElement).toBe(items[1]);
        press("End");
        expect(document.activeElement).toBe(items[2]);
        press("ArrowDown");
        expect(document.activeElement).toBe(items[0]);
        press("ArrowUp");
        expect(document.activeElement).toBe(items[2]);
        press("Home");
        expect(document.activeElement).toBe(items[0]);
    });

    it("closes on Escape", () => {
        const { page, menu } = openMenu();
        page.key({ key: "Escape", preventDefault: () => undefined });
        expect(menu.classList.contains(MENU_OPEN_CLASS)).toBe(false);
    });

    it("stays open for the click that opened it, and closes on a click outside", () => {
        const { page, menu, event } = openMenu();
        page.click(event.event);
        expect(menu.classList.contains(MENU_OPEN_CLASS)).toBe(true);
        page.click({ target: { closest: () => null } });
        expect(menu.classList.contains(MENU_OPEN_CLASS)).toBe(false);
    });

    it("stays open for the click that the browser sends after a tap on the icon, and closes on the next click", () => {
        const chart = { closest: () => null };
        const tap = { event: { type: "touchend" } };
        // The runtime fires the click of the icon from the touch end, and the browser then sends its own click to the chart.
        const tapped = openMenu(tap, chart);
        tapped.page.click({ target: chart });
        expect(tapped.menu.classList.contains(MENU_OPEN_CLASS)).toBe(true);
        tapped.page.click({ target: chart });
        expect(tapped.menu.classList.contains(MENU_OPEN_CLASS)).toBe(false);
        const outside = openMenu(tap, chart);
        outside.page.click({ target: { closest: () => null } });
        expect(outside.menu.classList.contains(MENU_OPEN_CLASS)).toBe(false);
        // A click opens the menu with no tap, thus the next click in the chart closes it.
        const clicked = openMenu(undefined, chart);
        clicked.page.click({ target: chart });
        expect(clicked.menu.classList.contains(MENU_OPEN_CLASS)).toBe(false);
    });

    it("closes on a click on an entry, and on a second click on the icon", () => {
        const first = openMenu();
        first.page.click({ target: first.items[1] });
        expect(first.menu.classList.contains(MENU_OPEN_CLASS)).toBe(false);
        const second = openMenu();
        second.page.open({}, { getDom: () => ({ id: "chart-gwas", offsetLeft: 0, offsetTop: 0, clientWidth: 600 }) }, "myExport", {});
        expect(second.menu.classList.contains(MENU_OPEN_CLASS)).toBe(false);
    });
});

describe("the download control of the card", () => {
    /** One closed menu of three entries, its fault note, its container, and the download control of its card. */
    function card(): {
        page: ReturnType<typeof pageFunctions>;
        menu: StubNode;
        items: StubNode[];
        fault: StubNode;
        control: StubNode;
        document: Record<string, unknown>;
    } {
        const byId: Record<string, StubNode> = {};
        const { document, node } = stubDocument(byId);
        const menu = node("div", { role: "menu" });
        Object.assign(menu, { offsetWidth: 140 });
        const items = [node("a", { role: "menuitem" }), node("button", { role: "menuitem" }), node("button", { role: "menuitem" })];
        const fault = node("span", { role: "menuitem", "aria-disabled": "true", class: MENU_FAULT_CLASS });
        for (const item of [items[0], items[1], fault, items[2]]) menu.appendChild(item);
        const control = node("button", { [MENU_CONTROL_ATTRIBUTE]: "chart-gwas", "aria-expanded": "false" });
        const container = node("div", { id: "chart-gwas" });
        Object.assign(container, { id: "chart-gwas", offsetLeft: 16, offsetTop: 16, clientWidth: 600 });
        byId["chart-gwas"] = container;
        byId["chart-gwas-menu"] = menu;
        byId[chartMenuControlId("chart-gwas")] = control;
        byId.menu = menu;
        return { page: pageFunctions(document), menu, items, fault, control, document };
    }

    it("names the control of a chart after its container", () => {
        expect(chartMenuControlId("chart-gwas")).toBe("chart-gwas-download");
    });

    it("opens the menu on a click or a key on the control, states it open, and gives the focus to the first entry", () => {
        const { page, menu, items, control, document } = card();
        control.focus();
        // A button fires a click for the Enter key and the Space key, thus one click path serves the keyboard.
        const event = { target: control };
        page.click(event);
        expect(menu.classList.contains(MENU_OPEN_CLASS)).toBe(true);
        expect(menu.style.left).toBe(`${16 + 600 - 9 - 140}px`);
        expect(control.attributes["aria-expanded"]).toBe("true");
        expect(document.activeElement).toBe(items[0]);
    });

    it("closes on Escape, states it closed, and gives the focus back to the control", () => {
        const { page, menu, control, document } = card();
        page.click({ target: control });
        page.key({ key: "Escape", preventDefault: () => undefined });
        expect(menu.classList.contains(MENU_OPEN_CLASS)).toBe(false);
        expect(control.attributes["aria-expanded"]).toBe("false");
        expect(document.activeElement).toBe(control);
    });

    it("gives the focus back to the control after an entry fires, and leaves it where an outside click puts it", () => {
        const entry = card();
        entry.page.click({ target: entry.control });
        entry.page.click({ target: entry.items[2] });
        expect(entry.menu.classList.contains(MENU_OPEN_CLASS)).toBe(false);
        expect(entry.document.activeElement).toBe(entry.control);
        const outside = card();
        outside.page.click({ target: outside.control });
        outside.page.click({ target: { closest: () => null } });
        expect(outside.menu.classList.contains(MENU_OPEN_CLASS)).toBe(false);
        expect(outside.document.activeElement).toBe(outside.items[0]);
    });

    it("closes on a second click on the control, and gives the focus back to it", () => {
        const { page, menu, control, document } = card();
        page.click({ target: control });
        page.click({ target: control });
        expect(menu.classList.contains(MENU_OPEN_CLASS)).toBe(false);
        expect(document.activeElement).toBe(control);
    });

    it("closes on Tab from the control, thus the next Tab stop comes after the control", () => {
        const { page, menu, control, document } = card();
        page.click({ target: control });
        let prevented = false;
        page.key({ key: "Tab", preventDefault: () => (prevented = true) });
        expect(menu.classList.contains(MENU_OPEN_CLASS)).toBe(false);
        expect(document.activeElement).toBe(control);
        expect(prevented).toBe(false);
    });

    it("states the control open and gives the focus back to it when the toolbox icon opens the menu", () => {
        const { page, control, document } = card();
        page.open({}, { getDom: () => (document.getElementById as (id: string) => unknown)("chart-gwas") }, "myExport", { event: {} });
        expect(control.attributes["aria-expanded"]).toBe("true");
        page.key({ key: "Escape", preventDefault: () => undefined });
        expect(document.activeElement).toBe(control);
        expect(control.attributes["aria-expanded"]).toBe("false");
    });

    it("shows the fault note in the open menu and gives it the focus, and the close hides the note again", () => {
        const { page, menu, items, fault, document } = card();
        page.open({}, { getDom: () => (document.getElementById as (id: string) => unknown)("chart-gwas") }, "myExport", { event: {} });
        page.fault(items[1]);
        expect(menu.classList.contains(MENU_OPEN_CLASS)).toBe(true);
        expect(fault.classList.contains(MENU_FAULT_SHOWN_CLASS)).toBe(true);
        expect(document.activeElement).toBe(fault);
        page.key({ key: "Escape", preventDefault: () => undefined });
        expect(fault.classList.contains(MENU_FAULT_SHOWN_CLASS)).toBe(false);
    });
});
