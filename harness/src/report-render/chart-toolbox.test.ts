import { describe, expect, it } from "bun:test";
import * as echarts from "echarts";

import type { ChartType } from "../contracts/report-blocks.js";
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
