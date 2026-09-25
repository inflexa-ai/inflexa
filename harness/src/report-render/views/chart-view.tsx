/**
 * The chart card markup.
 *
 * The bootstrap in `page.ts` reads the option from the next element sibling of the container. Thus the
 * `<script type="application/json">` element MUST follow the container div with no element between them.
 *
 * The card is the square corner-accent form of the table and the figure, with the mono title line over it. A
 * report is a document, thus the card wears no application-window costume. The chart body carries a fixed
 * height, because the chart runtime measures the container and a container with no height shows no chart.
 * A faceted chart grows its body one row of height for each row of panels, and a figure of many rows states
 * its own height. A figure that draws a block of a fixed size, for example a square, narrows the body to the
 * block and centers it. Each export entry states the height of its export, which grows with a taller body.
 *
 * The option of the page carries the toolbox of the chart, and the download control of the toolbox opens the
 * download menu of the card. The runtime draws that control on the canvas and binds a mouse click alone, thus the
 * title line also carries a download button that the keyboard reaches and that opens the same menu. The menu
 * follows the option script, and it holds the two SVG entries and the three PNG entries. An SVG entry links a
 * staged file, or it names the hybrid file that the page builds for a dense chart. The page draws each PNG on
 * click.
 */

import { raw } from "hono/html";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import type { Reference } from "../../contracts/report-reference.js";
import { kebabFilename } from "../../tools/display/normalize-echart-spec.js";
import { stagedSource } from "../assets.js";
import type { EchartOption } from "../chart.js";
import { chartMenuControlId, chartMenuId, MENU_CONTROL_ATTRIBUTE, MENU_FAULT_CLASS, pageChartOption } from "../chart-toolbox.js";
import { CHART_BODY_PX, CHART_EXPORT_SIZES, exportSizeFor } from "../design.js";
import { holdsPointLayer } from "../hybrid-svg.js";
import type { ReferenceLedger } from "../references.js";
import { DEFAULT_VIEW_OPTIONS, lineagePlace, lineageStamp, type ViewOptions } from "./lineage.js";
import { Marker } from "./references-view.js";
import { scriptJson } from "../script-json.js";

/**
 * What the card carries beside the option: the staged names of the two SVG files, and the box of the chart
 * body. A chart past the export bound carries no SVG name. The page then builds the hybrid SVG of a chart that
 * holds a point layer, and the menu states that the PNG serves each other such chart.
 * `bodyPx` is the height of the body, and `widthPx` is the width of a figure that draws a block of a fixed
 * size.
 */
export interface ChartCard {
    readonly svg?: { readonly single: string; readonly double: string };
    readonly bodyPx: number;
    readonly widthPx?: number;
}

/** The card of a chart with the default body and no SVG file. */
const PLAIN_CARD: ChartCard = { bodyPx: CHART_BODY_PX };

/**
 * The note of a chart past the export bound that holds no point layer. The page draws its PNG, and no SVG
 * serves it.
 */
export const PNG_ONLY_NOTE = "The chart holds too many points for an SVG file. Use a PNG.";

/** The note that the menu of a dense chart shows when the page cannot build its hybrid SVG file. */
export const HYBRID_FAULT_NOTE = "The page could not build the SVG file. Use a PNG.";

/** The name of the download menu for a reader who hears the page instead of seeing it. */
const MENU_LABEL = "Download the chart";

/** The text of the download control in the title line of the card. */
export const DOWNLOAD_CONTROL_LABEL = "Download";

/** The two SVG entries of the menu, in the order that the menu shows them. */
const SVG_EXPORTS = ["single", "double"] as const;

/** The three PNG entries, in the order that the menu shows them, with the suffix of each file name. */
const PNG_EXPORTS = [
    { kind: "single", suffix: `${CHART_EXPORT_SIZES.single.widthMm}mm` },
    { kind: "double", suffix: `${CHART_EXPORT_SIZES.double.widthMm}mm` },
    { kind: "slide", suffix: "slide" },
] as const;

/**
 * Render the card markup for a chart.
 *
 * Each reference of the chart joins the reference ladder: the whole-table binding, the track, the tree of `x`,
 * the tree of `y`, and each statistic, in that order. Thus the title line carries one marker for each, and the
 * appendix names the artifact that the chart plots, each second table that it draws, and each cell that it
 * prints. A chart with
 * no title still shows its markers on the same line.
 *
 * `view.lineage` states that the page carries a provenance document. The card then stamps the keys of its
 * references, and each marker carries the control that opens the chain of its own key.
 */
export function renderChart(
    block: ChartBlock,
    ledger: ReferenceLedger,
    option: EchartOption,
    view: ViewOptions = DEFAULT_VIEW_OPTIONS,
    card: ChartCard = PLAIN_CARD,
): string {
    const references: Reference[] = [
        block.binding,
        ...(block.track !== undefined ? [block.track.binding] : []),
        ...(block.trees?.x !== undefined ? [block.trees.x.binding] : []),
        ...(block.trees?.y !== undefined ? [block.trees.y.binding] : []),
        ...(block.statistics ?? []).map((statistic) => statistic.value),
    ];
    const markers = references.map((reference, index) => <Marker n={ledger.mark(reference)} lineage={lineagePlace(view.lineage, reference, index)} />);
    const containerId = chartContainerId(block.id);
    // The JSON goes to the page through `raw()`, thus `scriptJson` is the sole guard of this sink. It
    // replaces every `<` with `\u003c`, thus a `</script` sequence in a string cell cannot close the
    // element early. The JSON parser reads `\u003c` as `<`, thus the option value stays exact.
    const json = scriptJson(pageChartOption(option, block.chartType));
    const bodyStyle = [
        ...(card.bodyPx !== CHART_BODY_PX ? [`height: ${card.bodyPx}px`] : []),
        ...(card.widthPx !== undefined ? [`max-width: ${card.widthPx}px; margin-inline: auto`] : []),
    ].join("; ");
    const stem = kebabFilename(block.title ?? block.id);
    const hybrid = card.svg === undefined && holdsPointLayer(option);
    return String(
        <div class="report-chart" {...lineageStamp(view.lineage, block.id, references)}>
            <div class="report-chart-title">
                {block.title}
                {markers}
                <button
                    type="button"
                    id={chartMenuControlId(containerId)}
                    class="report-chart-download"
                    aria-haspopup="menu"
                    aria-expanded="false"
                    aria-controls={chartMenuId(containerId)}
                    {...{ [MENU_CONTROL_ATTRIBUTE]: containerId }}
                >
                    {DOWNLOAD_CONTROL_LABEL}
                </button>
            </div>
            <div class="report-chart-card corner-accents">
                <div id={containerId} data-echarts-id={block.id} class="chart-container" {...(bodyStyle !== "" ? { style: bodyStyle } : {})}></div>
                <script type="application/json">{raw(json)}</script>
                <div id={chartMenuId(containerId)} class="report-chart-menu" role="menu" aria-label={MENU_LABEL}>
                    {SVG_EXPORTS.map((kind) => {
                        const size = exportSizeFor(CHART_EXPORT_SIZES[kind], card.bodyPx);
                        const file = `${stem}-${size.widthMm}mm.svg`;
                        const label = `SVG · ${size.label}`;
                        if (card.svg !== undefined) {
                            return (
                                <a class="report-chart-menu-item" role="menuitem" tabindex={-1} href={stagedSource(card.svg[kind])} download={file}>
                                    {label}
                                </a>
                            );
                        }
                        if (!hybrid) return null;
                        return (
                            <button
                                type="button"
                                class="report-chart-menu-item"
                                role="menuitem"
                                tabindex={-1}
                                data-hybrid={kind}
                                data-chart={containerId}
                                data-height={String(size.heightPx)}
                                data-height-mm={String(size.heightMm)}
                                data-file={file}
                            >
                                {label}
                            </button>
                        );
                    })}
                    {card.svg === undefined && !hybrid ? (
                        <span class="report-chart-menu-note" role="menuitem" aria-disabled="true">
                            {PNG_ONLY_NOTE}
                        </span>
                    ) : null}
                    {hybrid ? (
                        <span class={`report-chart-menu-note ${MENU_FAULT_CLASS}`} role="menuitem" aria-disabled="true" tabindex={-1}>
                            {HYBRID_FAULT_NOTE}
                        </span>
                    ) : null}
                    <div class="report-chart-menu-rule" role="separator"></div>
                    {PNG_EXPORTS.map((png) => (
                        <button
                            type="button"
                            class="report-chart-menu-item"
                            role="menuitem"
                            tabindex={-1}
                            data-export={png.kind}
                            data-chart={containerId}
                            data-height={String(exportSizeFor(CHART_EXPORT_SIZES[png.kind], card.bodyPx).heightPx)}
                            data-file={`${stem}-${png.suffix}.png`}
                        >
                            PNG · {CHART_EXPORT_SIZES[png.kind].label}
                        </button>
                    ))}
                </div>
            </div>
            {block.caption !== undefined ? <p class="report-caption">{block.caption}</p> : null}
        </div>,
    );
}

/** The container id derives from the block id, thus the id stays stable across renders. */
function chartContainerId(blockId: string): string {
    return `chart-${blockId}`;
}
