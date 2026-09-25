/**
 * The Sankey diagram: the flows between the nodes of some stages, as the ECharts `sankey` series draws them.
 *
 * The figure reads one row for each flow: the `x` column names the source node, the `y` column names the
 * target node, and the `value` column gives the size of the flow. The optional `group` column names the
 * category of each flow, and each flow takes the palette color of its category.
 *
 * - The nodes keep the order of their first appearance in the rows, and the layout runs no iteration. Thus
 *   the order of the table is the order of each stage, and the same rows give the same picture.
 * - The palette starts again at each stage, thus each node takes the palette color of its place in its stage.
 *   Each flow takes the color of its source at a light opacity. With a group, each flow takes the color of its group, the nodes draw gray, and a legend names
 *   each group.
 * - Each label sits beside its node: at the right, and at the left in the last stage, thus each label stays
 *   inside the chart. A label wraps into the room between two stages. The runtime draws a series label at a
 *   fixed size of its own, thus the page and one media rule for each export size state the text size.
 * - Each label sits on a box of the page color, thus no flow covers it.
 * - The node gap holds one label line where the stage of the most nodes has the room, thus the label of a thin
 *   node meets no neighbor. A label that still meets a neighbor hides, and the tooltip of its node names it.
 * - The tooltip of a flow names its two nodes and its value.
 *
 * The figure computes one named summary: the stage of each node. The stage is the longest chain of flows from
 * a node with no inflow, and a node with no outflow takes the last stage, thus each end of the flows lines up
 * at the right. The chart runtime sizes each node by the larger of its inflow and its outflow.
 */

import { err, ok, type Result } from "neverthrow";

import { declaredForColumn } from "../../contracts/report-reference.js";
import type { ChartBlock } from "../../contracts/report-blocks.js";
import type { Cell, ChartRow, EchartOption } from "../chart.js";
import { CHART_BODY_PX, CHART_EXPORT_SIZES, CHART_PAGE_TEXT_PX, CHART_PAGE_WIDTH_PX, MUTED_CHART_COLOR } from "../design.js";
import type { RenderProblem } from "../types.js";
import {
    AREA_LEGEND_ICON,
    categoricalPalette,
    chartProblem,
    demandedColumn,
    firstAppearance,
    legendLineCount,
    legendLinePx,
    plainColumn,
    toNumber,
} from "./common.js";
import type { FigureContext, FigureModule } from "./index.js";

/** The opacity of a flow. A flow reads as the path of its source, and a label reads over it. */
export const SANKEY_LINK_OPACITY = 0.35;

/** The margins of the series at each side, in percent of the chart. */
const SIDE_PCT = 2;
const TOP_PCT = 6;
const BOTTOM_PCT = 6;

/** The width of one node, as a share of the text size. */
const NODE_WIDTH_SHARE = 1;

/** The height of one label line, as a share of the text size. */
const LABEL_LINE_SHARE = 1.25;

/**
 * The largest share of the height of a stage that its node gaps take. The rest draws the flows, thus a stage of
 * many nodes takes a smaller gap than one label line.
 */
const GAP_MAX_SHARE = 0.5;

/** The gap between a node and its label, in pixels at the page text size. */
const LABEL_DISTANCE_PX = 5;

/**
 * The box of a label: the color of the page, and the room at each side of the text, in pixels at the page text
 * size. A label sits over the flows of its node, and the flows of a thin node are thinner than the text. Thus a
 * flow edge would cross the letters, and a halo keeps it visible between them. The box hides each flow under
 * the text.
 */
export const SANKEY_LABEL_BOX_COLOR = "#ffffff";
const LABEL_BOX_PAD_PX = 2;

/**
 * The rich style of the label text. A box of the label itself takes the wrap width, thus it would hide the flows
 * across the room between two stages. A rich style boxes each line of the text alone.
 */
const LABEL_BOX_STYLE = "box";

/** The icon size and the gap of the group legend, in pixels. */
const LEGEND_ICON_PX = 10;
const LEGEND_GAP_PX = 8;

/** The Sankey module: the source, the target, the flow, and the group. */
export const SANKEY_FIGURE: FigureModule = { reads: new Set(["x", "y", "value", "group"]), derive: deriveSankey };

/** One flow of the table: its two nodes. */
export interface SankeyEdge {
    readonly source: string;
    readonly target: string;
}

/** One flow of the table: its two nodes, its value, and its group. */
interface SankeyFlow extends SankeyEdge {
    readonly value: number;
    readonly group?: string;
}

/** The text of one node cell, or `undefined` for an empty cell. */
function nodeName(cell: Cell | undefined): string | undefined {
    if (cell === undefined) return undefined;
    const text = String(cell).trim();
    return text === "" ? undefined : text;
}

/**
 * The stage of each node, in the order of first appearance: the longest chain of flows from a node with no
 * inflow. A node with no outflow takes the last stage. A cycle has no stage, thus it refuses, and the error
 * names the nodes of the cycle.
 */
export function sankeyStages(edges: readonly SankeyEdge[]): Result<Map<string, number>, string> {
    const nodes = firstAppearance(edges.flatMap((edge) => [edge.source, edge.target]));
    const outgoing = new Map<string, string[]>(nodes.map((node) => [node, []]));
    for (const edge of edges) outgoing.get(edge.source)?.push(edge.target);
    const cycle = findCycle(nodes, outgoing);
    if (cycle !== undefined) {
        return err(
            `The flows ${cycle.map((node) => `"${node}"`).join(" → ")} close a cycle. A Sankey diagram draws each flow in one direction, thus a cycle refuses.`,
        );
    }
    const stages = new Map<string, number>(nodes.map((node) => [node, 0]));
    for (const node of topologicalOrder(nodes, outgoing)) {
        const stage = stages.get(node) ?? 0;
        for (const next of outgoing.get(node) ?? []) {
            if ((stages.get(next) ?? 0) < stage + 1) stages.set(next, stage + 1);
        }
    }
    const last = Math.max(...stages.values());
    for (const node of nodes) {
        if ((outgoing.get(node) ?? []).length === 0) stages.set(node, last);
    }
    return ok(stages);
}

/**
 * The first cycle of a depth-first walk over the nodes in order, as its nodes from the first one back to the
 * first one, or `undefined` for a graph with no cycle. The walk keeps its own stack, thus a long chain never
 * spreads onto the call stack.
 */
function findCycle(nodes: readonly string[], outgoing: ReadonlyMap<string, readonly string[]>): string[] | undefined {
    const state = new Map<string, "open" | "done">();
    for (const root of nodes) {
        if (state.has(root)) continue;
        const path: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
        state.set(root, "open");
        while (path.length > 0) {
            const top = path[path.length - 1];
            const targets = outgoing.get(top.node) ?? [];
            if (top.next >= targets.length) {
                state.set(top.node, "done");
                path.pop();
                continue;
            }
            const target = targets[top.next];
            top.next += 1;
            const seen = state.get(target);
            if (seen === "open") {
                const from = path.findIndex((entry) => entry.node === target);
                return [...path.slice(from).map((entry) => entry.node), target];
            }
            if (seen === undefined) {
                state.set(target, "open");
                path.push({ node: target, next: 0 });
            }
        }
    }
    return undefined;
}

/** The nodes of a graph with no cycle in an order where each flow runs forward. A tie keeps the first appearance. */
function topologicalOrder(nodes: readonly string[], outgoing: ReadonlyMap<string, readonly string[]>): string[] {
    const inflow = new Map<string, number>(nodes.map((node) => [node, 0]));
    for (const targets of outgoing.values()) {
        for (const target of targets) inflow.set(target, (inflow.get(target) ?? 0) + 1);
    }
    const order: string[] = [];
    const ready = nodes.filter((node) => inflow.get(node) === 0);
    for (let next = 0; next < ready.length; next += 1) {
        const node = ready[next];
        order.push(node);
        for (const target of outgoing.get(node) ?? []) {
            const left = (inflow.get(target) ?? 0) - 1;
            inflow.set(target, left);
            if (left === 0) ready.push(target);
        }
    }
    return order;
}

/** The flows of the table, or the refusal of the first row that states no flow. */
function readFlows(rows: readonly ChartRow[], source: string, target: string, value: string, group: string | undefined): Result<SankeyFlow[], string> {
    const flows: SankeyFlow[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
        const from = nodeName(row[source]);
        const to = nodeName(row[target]);
        if (from === undefined) return err(`A flow to "${to ?? ""}" names no source node in the "${source}" column.`);
        if (to === undefined) return err(`A flow from "${from}" names no target node in the "${target}" column.`);
        if (from === to) return err(`The flow from "${from}" to "${to}" joins a node to itself. A Sankey flow joins two nodes.`);
        const amount = toNumber(row[value]);
        if (amount === null) return err(`The flow from "${from}" to "${to}" holds no number in the "${value}" column.`);
        if (amount <= 0) return err(`The flow from "${from}" to "${to}" is ${amount}. A Sankey flow is positive.`);
        const groupName = group === undefined ? undefined : (nodeName(row[group]) ?? "");
        const key = JSON.stringify([from, to, groupName ?? null]);
        if (seen.has(key)) return err(`The table holds two flows from "${from}" to "${to}". It holds one row for each flow.`);
        seen.add(key);
        flows.push({ source: from, target: to, value: amount, ...(groupName !== undefined ? { group: groupName } : {}) });
    }
    return ok(flows);
}

/** The size of one chart box and its text: the page, or one export. */
interface ChartBox {
    readonly widthPx: number;
    readonly heightPx: number;
    readonly textPx: number;
}

const PAGE_BOX: ChartBox = { widthPx: CHART_PAGE_WIDTH_PX, heightPx: CHART_BODY_PX, textPx: CHART_PAGE_TEXT_PX };
const EXPORT_SIZES = [CHART_EXPORT_SIZES.single, CHART_EXPORT_SIZES.double, CHART_EXPORT_SIZES.slide] as const;

/**
 * The text and the node size of one box: the label text size, the room of a label between two stages, the node
 * width, and the node gap. A figure of one stage gives its label the half of the width.
 *
 * A label sits at the middle of its node. Thus two labels of one line never overlap where the gap between two
 * nodes holds one label line, however thin the nodes are. The gap takes one line where the stage of the most
 * nodes has the room, and a smaller gap where it does not.
 */
function boxFields(box: ChartBox, stageCount: number, stageNodes: number, bottomPct: number): { label: EchartOption; nodeWidth: number; nodeGap: number } {
    const scale = box.textPx / CHART_PAGE_TEXT_PX;
    const nodeWidth = rounded(box.textPx * NODE_WIDTH_SHARE);
    const distance = rounded(LABEL_DISTANCE_PX * scale);
    const span = box.widthPx * (1 - (2 * SIDE_PCT) / 100);
    const room = stageCount > 1 ? (span - nodeWidth * stageCount) / (stageCount - 1) : span / 2;
    return {
        label: {
            fontSize: box.textPx,
            width: rounded(Math.max(box.textPx, room - 2 * distance)),
            distance,
            rich: { [LABEL_BOX_STYLE]: { backgroundColor: SANKEY_LABEL_BOX_COLOR, padding: [0, rounded(LABEL_BOX_PAD_PX * scale)] } },
        },
        nodeWidth,
        nodeGap: rounded(Math.min(box.textPx * LABEL_LINE_SHARE, gapRoom(box, stageNodes, bottomPct))),
    };
}

/** The largest node gap of a stage of some nodes in one box, in pixels. */
function gapRoom(box: ChartBox, stageNodes: number, bottomPct: number): number {
    if (stageNodes < 2) return Number.POSITIVE_INFINITY;
    const height = box.heightPx * (1 - (TOP_PCT + bottomPct) / 100);
    return (height * GAP_MAX_SHARE) / (stageNodes - 1);
}

/**
 * The color of each node. The palette starts again at each stage, in stage order, thus the nodes of one stage
 * read as distinct colors and two stages never meet at an arbitrary pair of the long list. A stage of more
 * nodes than the Okabe-Ito palette holds takes the wide palette.
 */
function nodeColors(nodes: readonly string[], stages: ReadonlyMap<string, number>): Map<string, string> {
    const byStage = new Map<number, string[]>();
    for (const node of nodes) {
        const stage = stages.get(node) ?? 0;
        byStage.set(stage, [...(byStage.get(stage) ?? []), node]);
    }
    const colors = new Map<string, string>();
    for (const members of byStage.values()) {
        const palette = categoricalPalette(members.length);
        for (const [place, node] of members.entries()) colors.set(node, palette[place % palette.length]);
    }
    return colors;
}

/** One number rounded, thus a float residue never reaches the option. */
function rounded(value: number): number {
    return Math.round(value * 1e4) / 1e4;
}

/**
 * The band of the group legend under the flows, in percent of the chart. The band holds the legend lines of
 * the page and of the single column, whose narrow width wraps the legend into more lines.
 */
function legendBandPct(names: readonly string[]): number {
    const single = CHART_EXPORT_SIZES.single;
    const bandAt = (widthPx: number, heightPx: number, textPx: number): number =>
        ((legendLineCount(names, widthPx, textPx) * legendLinePx(textPx, LEGEND_GAP_PX) + textPx) / heightPx) * 100;
    return rounded(Math.max(bandAt(CHART_PAGE_WIDTH_PX, CHART_BODY_PX, CHART_PAGE_TEXT_PX), bandAt(single.widthPx, single.heightPx, single.textPx)));
}

function deriveSankey(block: ChartBlock, rows: readonly ChartRow[], context: FigureContext): Result<EchartOption, RenderProblem> {
    const source = { blockId: context.blockId, rows, ...(context.columns !== undefined ? { columns: context.columns } : {}) };
    const encoding = block.encoding ?? {};
    const from = demandedColumn("sankey", encoding, "x", source);
    if (from.isErr()) return err(from.error);
    const to = demandedColumn("sankey", encoding, "y", source);
    if (to.isErr()) return err(to.error);
    const value = demandedColumn("sankey", encoding, "value", source);
    if (value.isErr()) return err(value.error);
    const group = plainColumn("sankey", encoding, "group", source);
    if (group.isErr()) return err(group.error);
    if (rows.length === 0) {
        return err(chartProblem(context.blockId, "The sankey figure has no rows. It needs one row for each flow."));
    }
    const flows = readFlows(rows, from.value, to.value, value.value, group.value);
    if (flows.isErr()) return err(chartProblem(context.blockId, flows.error));
    const stages = sankeyStages(flows.value);
    if (stages.isErr()) return err(chartProblem(context.blockId, stages.error));

    const nodes = [...stages.value.keys()];
    const last = Math.max(...stages.value.values());
    const colors = nodeColors(nodes, stages.value);
    const stageSizes = new Map<number, number>();
    for (const stage of stages.value.values()) stageSizes.set(stage, (stageSizes.get(stage) ?? 0) + 1);
    const stageNodes = Math.max(...stageSizes.values());
    const groups = group.value === undefined ? [] : firstAppearance(flows.value.map((entry) => entry.group ?? ""));
    const groupPalette = categoricalPalette(groups.length);
    const groupColors = new Map(groups.map((name, place) => [name, groupPalette[place % groupPalette.length]]));
    const grouped = group.value !== undefined;

    const bottom = grouped ? legendBandPct(groups) + BOTTOM_PCT : BOTTOM_PCT;
    const page = boxFields(PAGE_BOX, last + 1, stageNodes, bottom);
    const series: EchartOption[] = [
        {
            type: "sankey",
            name: declaredForColumn(context.labels, value.value) ?? value.value,
            left: `${SIDE_PCT}%`,
            right: `${SIDE_PCT}%`,
            top: `${TOP_PCT}%`,
            bottom: `${rounded(bottom)}%`,
            layoutIterations: 0,
            nodeAlign: "justify",
            draggable: false,
            nodeWidth: page.nodeWidth,
            nodeGap: page.nodeGap,
            emphasis: { focus: "adjacency" },
            label: { ...page.label, overflow: "break", formatter: `{${LABEL_BOX_STYLE}|{b}}` },
            // A label that still meets a neighbor hides, and the tooltip of its node names it.
            labelLayout: { hideOverlap: true },
            lineStyle: grouped ? { opacity: SANKEY_LINK_OPACITY } : { color: "source", opacity: SANKEY_LINK_OPACITY },
            data: nodes.map((node) => ({
                name: node,
                depth: stages.value.get(node) ?? 0,
                itemStyle: { color: grouped ? MUTED_CHART_COLOR : colors.get(node) },
                label: { position: (stages.value.get(node) ?? 0) === last && last > 0 ? "left" : "right" },
            })),
            links: flows.value.map((entry) => ({
                source: entry.source,
                target: entry.target,
                value: entry.value,
                ...(grouped ? { lineStyle: { color: groupColors.get(entry.group ?? "") } } : {}),
            })),
        },
    ];
    const option: EchartOption = {
        tooltip: { trigger: "item" },
        series,
        media: EXPORT_SIZES.map((size) => {
            const fields = boxFields(size, last + 1, stageNodes, bottom);
            return {
                query: { minWidth: size.widthPx, maxWidth: size.widthPx, minHeight: size.heightPx, maxHeight: size.heightPx },
                option: { series: [{ label: fields.label, nodeWidth: fields.nodeWidth, nodeGap: fields.nodeGap }] },
            };
        }),
    };
    if (!grouped) return ok({ ...option, legend: { show: false } });
    // The chart runtime lists no group of a flow in a legend. Each group takes one empty bar series of its
    // color on hidden axes, thus the legend names each group, and a click of an entry changes no flow.
    return ok({
        ...option,
        grid: { show: false, left: 0, right: 0, top: 0, bottom: 0 },
        xAxis: { type: "value", show: false },
        yAxis: { type: "value", show: false },
        series: [...series, ...groups.map((name) => ({ type: "bar", name, itemStyle: { color: groupColors.get(name) }, data: [] }))],
        legend: {
            bottom: 0,
            selectedMode: false,
            itemWidth: LEGEND_ICON_PX,
            itemHeight: LEGEND_ICON_PX,
            itemGap: LEGEND_GAP_PX,
            data: groups.map((name) => ({ name, icon: AREA_LEGEND_ICON })),
        },
    });
}
