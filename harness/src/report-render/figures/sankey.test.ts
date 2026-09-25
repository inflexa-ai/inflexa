/**
 * The Sankey figure: the nodes in table order, the computed stage of each node, the node and flow colors, the
 * labels beside the nodes, the export text, the group colors, and each refusal. The small rows are made up: they
 * run from a FAB subtype through a cytogenetic risk to the vital status. The flow table of TCGA LAML in the
 * gallery runs from the FAB subtype through the FLT3 status to the vital status.
 */

import { describe, expect, it } from "bun:test";
import * as echarts from "echarts";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import { chartSvgAssets } from "../chart-export.js";
import { deriveChartOption, type ChartRow, type EchartOption } from "../chart.js";
import { CHART_EXPORT_SIZES, CHART_PALETTE, CHART_PAGE_TEXT_PX, CHART_WIDE_PALETTE, MUTED_CHART_COLOR } from "../design.js";
import { SANKEY_LINK_OPACITY, sankeyStages } from "./sankey.js";

type Encoding = NonNullable<ChartBlock["encoding"]>;

const HASH = `sha256:${"a".repeat(64)}`;

const ENCODING: Encoding = { x: "source", y: "target", value: "patients" };

function sankey(encoding: Encoding = ENCODING, labels?: Record<string, string>): ChartBlock {
    return {
        kind: "chart",
        id: "flows",
        binding: { kind: "artifact-table", path: "sankey_flows.csv", hash: HASH, ...(labels !== undefined ? { columnLabels: labels } : {}) },
        chartType: "sankey",
        encoding,
    };
}

function flow(source: string, target: string, patients: number | string): ChartRow {
    return { source, target, patients };
}

const ROWS: ChartRow[] = [
    flow("M1", "Intermediate", 10),
    flow("M2", "Favorable", 8),
    flow("M1", "Poor", 5),
    flow("M4", "Intermediate", 7),
    flow("Intermediate", "Alive", 6),
    flow("Intermediate", "Dead", 11),
    flow("Favorable", "Alive", 6),
    flow("Favorable", "Dead", 2),
    flow("Poor", "Dead", 5),
];

function derive(rows: readonly ChartRow[] = ROWS, encoding: Encoding = ENCODING): EchartOption {
    return deriveChartOption(sankey(encoding), rows)._unsafeUnwrap();
}

function refusal(rows: readonly ChartRow[], encoding: Encoding = ENCODING): string {
    return deriveChartOption(sankey(encoding), rows)._unsafeUnwrapErr().detail;
}

function sankeySeries(option: EchartOption): EchartOption {
    const found = (option.series as EchartOption[]).find((entry) => entry.type === "sankey");
    if (found === undefined) throw new Error("no sankey series");
    return found;
}

interface Node {
    name: string;
    depth: number;
    itemStyle: { color: string };
    label: { position: string };
}

describe("the sankey stages", () => {
    it("gives each node the longest chain of flows from a node with no inflow, and the last stage to each node with no outflow", () => {
        const stages = sankeyStages([
            { source: "A", target: "B" },
            { source: "B", target: "C" },
            { source: "A", target: "D" },
        ]);
        expect(stages._unsafeUnwrap()).toEqual(
            new Map([
                ["A", 0],
                ["B", 1],
                ["C", 2],
                ["D", 2],
            ]),
        );
    });
});

/** The flow table of TCGA LAML in the gallery: the FAB subtype, the FLT3 status, and the vital status of each patient. */
const LAML_FLOWS: ChartRow[] = [
    flow("M0", "FLT3 mutated", 4),
    flow("M0", "FLT3 wild type", 15),
    flow("M1", "FLT3 mutated", 15),
    flow("M1", "FLT3 wild type", 29),
    flow("M2", "FLT3 mutated", 8),
    flow("M2", "FLT3 wild type", 36),
    flow("M3", "FLT3 mutated", 6),
    flow("M3", "FLT3 wild type", 15),
    flow("M4", "FLT3 mutated", 13),
    flow("M4", "FLT3 wild type", 26),
    flow("M5", "FLT3 mutated", 6),
    flow("M5", "FLT3 wild type", 13),
    flow("M6", "FLT3 wild type", 3),
    flow("M7", "FLT3 wild type", 3),
    flow("FAB unknown", "FLT3 wild type", 1),
    flow("FLT3 mutated", "Alive", 17),
    flow("FLT3 mutated", "Deceased", 35),
    flow("FLT3 wild type", "Alive", 49),
    flow("FLT3 wild type", "Deceased", 92),
];

describe("the sankey figure on the LAML flow table", () => {
    it("puts each FAB subtype in the first stage, each FLT3 status in the second, and each vital status in the last", () => {
        const series = sankeySeries(derive(LAML_FLOWS));
        const stages = Object.fromEntries((series.data as Node[]).map((node) => [node.name, node.depth]));
        expect(stages).toEqual({
            M0: 0,
            "FLT3 mutated": 1,
            "FLT3 wild type": 1,
            M1: 0,
            M2: 0,
            M3: 0,
            M4: 0,
            M5: 0,
            M6: 0,
            M7: 0,
            "FAB unknown": 0,
            Alive: 2,
            Deceased: 2,
        });
        expect((series.links as unknown[]).length).toBe(19);
        const colors = Object.fromEntries((series.data as Node[]).map((node) => [node.name, node.itemStyle.color]));
        // The first stage holds nine subtypes, more than the Okabe-Ito palette, thus it alone takes the wide palette.
        expect(colors.M0).toBe(CHART_WIDE_PALETTE[0]);
        expect(colors["FAB unknown"]).toBe(CHART_WIDE_PALETTE[8]);
        expect([colors["FLT3 mutated"], colors["FLT3 wild type"]]).toEqual([CHART_PALETTE[0], CHART_PALETTE[1]]);
        expect([colors.Alive, colors.Deceased]).toEqual([CHART_PALETTE[0], CHART_PALETTE[1]]);
    });

    it("gives the nodes of a stage one label line of gap at the page and at the single column, and hides a label that still meets a neighbor", () => {
        const option = derive(LAML_FLOWS);
        const series = sankeySeries(option);
        expect(series.nodeGap).toBe(CHART_PAGE_TEXT_PX * 1.25);
        expect(series.labelLayout).toEqual({ hideOverlap: true });
        const single = (option.media as EchartOption[]).find((rule) => (rule.query as EchartOption).maxWidth === CHART_EXPORT_SIZES.single.widthPx);
        const [singleSeries] = (single?.option as EchartOption).series as EchartOption[];
        expect(singleSeries.nodeGap).toBeCloseTo(CHART_EXPORT_SIZES.single.textPx * 1.25, 3);
    });
});

describe("the sankey labels over the flows", () => {
    it("sets each label on a box of the page color, thus no flow covers the label of a thin node", () => {
        const option = derive(LAML_FLOWS);
        const label = sankeySeries(option).label as EchartOption;
        expect(label.formatter).toBe("{box|{b}}");
        expect(label.rich).toEqual({ box: { backgroundColor: "#ffffff", padding: [0, 2] } });
        for (const svg of Object.values(chartSvgAssets(echarts, "flows", option)._unsafeUnwrap() ?? {})) {
            const elements = [...svg.bytes.matchAll(/<(path|text)\b([^>]*)>([^<]*)/g)].map((match) => ({
                tag: match[1],
                attributes: match[2],
                text: match[3],
            }));
            const lastFlow = elements.findLastIndex((element) => element.attributes.includes(`fill-opacity="${SANKEY_LINK_OPACITY}"`));
            const m7 = elements.findIndex((element) => element.tag === "text" && element.text === "M7");
            // The box of the label draws after every flow, and the label draws on its box.
            expect(m7).toBeGreaterThan(lastFlow + 1);
            expect(elements[m7 - 1].tag).toBe("path");
            expect(elements[m7 - 1].attributes).toContain('fill="#ffffff"');
            // The box fits the text, and never the wrap width of the label.
            const boxWidth = Number(/^M0 [-\d.]+l([\d.]+) 0/.exec(/d="([^"]*)"/.exec(elements[m7 - 1].attributes)?.[1] ?? "")?.[1]);
            expect(boxWidth).toBeGreaterThan(0);
            expect(boxWidth).toBeLessThan(30);
        }
    });
});

describe("the sankey figure", () => {
    it("draws one sankey series whose nodes keep the order of their first appearance, and the layout keeps it", () => {
        const series = sankeySeries(derive());
        expect(series.layoutIterations).toBe(0);
        expect((series.data as Node[]).map((node) => node.name)).toEqual(["M1", "Intermediate", "M2", "Favorable", "Poor", "M4", "Alive", "Dead"]);
        expect((series.data as Node[]).map((node) => node.depth)).toEqual([0, 1, 0, 1, 1, 0, 2, 2]);
        expect(series.links).toEqual(ROWS.map((row) => ({ source: row.source, target: row.target, value: row.patients })));
    });

    it("starts the palette again at each stage, and colors each flow in the color of its source at a light opacity", () => {
        const series = sankeySeries(derive());
        const colors = Object.fromEntries((series.data as Node[]).map((node) => [node.name, node.itemStyle.color]));
        expect(colors).toEqual({
            M1: CHART_PALETTE[0],
            M2: CHART_PALETTE[1],
            M4: CHART_PALETTE[2],
            Intermediate: CHART_PALETTE[0],
            Favorable: CHART_PALETTE[1],
            Poor: CHART_PALETTE[2],
            Alive: CHART_PALETTE[0],
            Dead: CHART_PALETTE[1],
        });
        expect(series.lineStyle).toEqual({ color: "source", opacity: SANKEY_LINK_OPACITY });
    });

    it("prints each label beside its node: at the left of the last stage, and at the right of every other stage", () => {
        const nodes = sankeySeries(derive()).data as Node[];
        const positions = Object.fromEntries(nodes.map((node) => [node.name, node.label.position]));
        expect(positions).toEqual({
            M1: "right",
            Intermediate: "right",
            M2: "right",
            Favorable: "right",
            Poor: "right",
            M4: "right",
            Alive: "left",
            Dead: "left",
        });
    });

    it("wraps each label into the room between two stages, and names the flow value in the tooltip", () => {
        const option = derive(ROWS);
        const series = sankeySeries(option);
        const label = series.label as EchartOption;
        expect(label.overflow).toBe("break");
        expect(label.fontSize).toBe(CHART_PAGE_TEXT_PX);
        expect(label.width as number).toBeGreaterThan(100);
        expect(option.tooltip).toEqual({ trigger: "item" });
        expect(series.name).toBe("patients");
        expect(sankeySeries(deriveChartOption(sankey(ENCODING, { patients: "Patients" }), ROWS)._unsafeUnwrap()).name).toBe("Patients");
    });

    it("states the label text size, its wrap width, and the node width of each export in one media rule for each export size", () => {
        const option = derive();
        const media = option.media as EchartOption[];
        for (const size of [CHART_EXPORT_SIZES.single, CHART_EXPORT_SIZES.double, CHART_EXPORT_SIZES.slide]) {
            const rule = media.find((entry) => (entry.query as EchartOption).maxWidth === size.widthPx);
            expect(rule?.query).toEqual({ minWidth: size.widthPx, maxWidth: size.widthPx, minHeight: size.heightPx, maxHeight: size.heightPx });
            const [series] = (rule?.option as EchartOption).series as EchartOption[];
            const label = series.label as EchartOption;
            expect(label.fontSize).toBe(size.textPx);
            // The room between two of the three stages, less the gap of the label on each side.
            expect(label.width as number).toBeLessThan(size.widthPx / 2);
            expect(label.width as number).toBeGreaterThan(size.widthPx / 4);
        }
    });

    it("colors each flow by its group, draws the nodes gray, and names each group in a legend", () => {
        const rows = ROWS.map((row, place) => ({ ...row, sex: place % 2 === 0 ? "Female" : "Male" }));
        const option = derive(rows, { ...ENCODING, group: "sex" });
        const series = sankeySeries(option);
        expect((series.data as Node[]).every((node) => node.itemStyle.color === MUTED_CHART_COLOR)).toBe(true);
        const links = series.links as Array<{ lineStyle: { color: string } }>;
        expect(links[0].lineStyle.color).toBe(CHART_PALETTE[0]);
        expect(links[1].lineStyle.color).toBe(CHART_PALETTE[1]);
        expect((option.legend as EchartOption).data).toEqual([
            { name: "Female", icon: "rect" },
            { name: "Male", icon: "rect" },
        ]);
    });

    it("keeps two flows of one pair apart where their groups differ", () => {
        const rows = [
            { source: "M1", target: "Dead", patients: 3, sex: "Female" },
            { source: "M1", target: "Dead", patients: 4, sex: "Male" },
        ];
        const links = sankeySeries(derive(rows, { ...ENCODING, group: "sex" })).links as unknown[];
        expect(links).toHaveLength(2);
    });

    it("gives the same option for the same rows", () => {
        expect(JSON.stringify(derive())).toBe(JSON.stringify(derive()));
    });
});

describe("the sankey node gap", () => {
    it("takes a gap under one label line where the stage of the most nodes has no room for it", () => {
        const rows = Array.from({ length: 40 }, (_entry, place) => flow(`S${place}`, "Target", 1));
        const series = sankeySeries(derive(rows));
        expect(series.nodeGap as number).toBeLessThan(CHART_PAGE_TEXT_PX * 1.25);
        expect(series.nodeGap as number).toBeGreaterThan(0);
    });
});

describe("the sankey refusals", () => {
    it("refuses a table with no rows", () => {
        expect(refusal([])).toBe("The sankey figure has no rows. It needs one row for each flow.");
    });

    it("refuses a cycle, and names its nodes", () => {
        expect(refusal([...ROWS, flow("Dead", "M1", 1)])).toBe(
            'The flows "M1" → "Intermediate" → "Dead" → "M1" close a cycle. A Sankey diagram draws each flow in one direction, thus a cycle refuses.',
        );
    });

    it("refuses a flow from a node to itself", () => {
        expect(refusal([...ROWS, flow("Poor", "Poor", 1)])).toBe('The flow from "Poor" to "Poor" joins a node to itself. A Sankey flow joins two nodes.');
    });

    it("refuses a flow of zero or less", () => {
        expect(refusal([...ROWS.slice(0, 2), flow("M1", "Poor", 0)])).toBe('The flow from "M1" to "Poor" is 0. A Sankey flow is positive.');
        expect(refusal([flow("M1", "Poor", -2)])).toBe('The flow from "M1" to "Poor" is -2. A Sankey flow is positive.');
    });

    it("refuses a flow with no number", () => {
        expect(refusal([flow("M1", "Poor", "NA")])).toBe('The flow from "M1" to "Poor" holds no number in the "patients" column.');
    });

    it("refuses two rows of one flow", () => {
        expect(refusal([...ROWS, flow("M1", "Poor", 2)])).toBe('The table holds two flows from "M1" to "Poor". It holds one row for each flow.');
    });

    it("refuses a row that names no node", () => {
        expect(refusal([flow("", "Poor", 2)])).toBe('A flow to "Poor" names no source node in the "source" column.');
        expect(refusal([flow("M1", " ", 2)])).toBe('A flow from "M1" names no target node in the "target" column.');
    });

    it("refuses a block with no flow channel", () => {
        expect(refusal(ROWS, { x: "source", y: "target" })).toBe('The sankey figure needs a column for the "value" channel.');
    });
});
