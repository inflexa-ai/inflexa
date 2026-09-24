/**
 * The chart card markup.
 *
 * The bootstrap in `page.ts` reads the option from the next element sibling of the container. Thus the
 * `<script type="application/json">` element MUST follow the container div with no element between them.
 *
 * The card is the square corner-accent form of the table and the figure, with the mono title line over it. A
 * report is a document, thus the card wears no application-window costume. The chart body carries a fixed
 * height, because the chart runtime measures the container and a container with no height shows no chart.
 * A faceted chart grows its body one row of height for each row of panels.
 *
 * The export row sits under the chart body: a link to each staged SVG file, and one control for each PNG
 * that the page draws on click.
 */

import { raw } from "hono/html";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import { kebabFilename } from "../../tools/display/normalize-echart-spec.js";
import { stagedSource } from "../assets.js";
import type { EchartOption } from "../chart.js";
import { CHART_EXPORT_SIZES } from "../design.js";
import type { ReferenceLedger } from "../references.js";
import { DEFAULT_VIEW_OPTIONS, lineagePlace, lineageStamp, type ViewOptions } from "./lineage.js";
import { Marker } from "./references-view.js";
import { scriptJson } from "../script-json.js";

/**
 * What the card carries beside the option: the staged names of the two SVG files, and the count of panel
 * rows. A chart past the export bound carries no SVG name, and the card states that the PNG serves it.
 */
export interface ChartCard {
    readonly svg?: { readonly single: string; readonly double: string };
    readonly panelRows: number;
}

/** The card of a chart with one panel row and no SVG file. */
const PLAIN_CARD: ChartCard = { panelRows: 1 };

/** The note of a chart past the export bound. The page draws its PNG, and the render stages no SVG for it. */
export const PNG_ONLY_NOTE = "The chart holds too many points for an SVG file. Use a PNG.";

/** The three PNG controls, in the order that the export row shows them, with the suffix of each file name. */
const PNG_EXPORTS = [
    { kind: "single", suffix: `${CHART_EXPORT_SIZES.single.widthMm}mm` },
    { kind: "double", suffix: `${CHART_EXPORT_SIZES.double.widthMm}mm` },
    { kind: "slide", suffix: "slide" },
] as const;

/**
 * Render the card markup for a chart.
 *
 * The whole-table binding joins the reference ladder, thus the title line carries the marker and the
 * appendix names the artifact that the chart plots. A chart with no title still shows its marker on the
 * same line.
 *
 * `view.lineage` states that the page carries a provenance document. The card then stamps its keys, and the
 * marker carries the control that opens the chain.
 */
export function renderChart(
    block: ChartBlock,
    ledger: ReferenceLedger,
    option: EchartOption,
    view: ViewOptions = DEFAULT_VIEW_OPTIONS,
    card: ChartCard = PLAIN_CARD,
): string {
    const n = ledger.mark(block.binding);
    const containerId = chartContainerId(block.id);
    // The JSON goes to the page through `raw()`, thus `scriptJson` is the sole guard of this sink. It
    // replaces every `<` with `\u003c`, thus a `</script` sequence in a string cell cannot close the
    // element early. The JSON parser reads `\u003c` as `<`, thus the option value stays exact.
    const json = scriptJson(option);
    const bodyClass = card.panelRows > 1 ? `chart-container chart-container-rows-${card.panelRows}` : "chart-container";
    const stem = kebabFilename(block.title ?? block.id);
    return String(
        <div class="report-chart" {...lineageStamp(view.lineage, block.id, [block.binding])}>
            <div class="report-chart-title">
                {block.title}
                <Marker n={n} lineage={lineagePlace(view.lineage, block.binding)} />
            </div>
            <div class="report-chart-card corner-accents">
                <div id={containerId} data-echarts-id={block.id} class={bodyClass}></div>
                <script type="application/json">{raw(json)}</script>
                <div class="report-chart-export">
                    {card.svg !== undefined ? (
                        [
                            <a
                                class="report-chart-export-link"
                                href={stagedSource(card.svg.single)}
                                download={`${stem}-${CHART_EXPORT_SIZES.single.widthMm}mm.svg`}
                            >
                                SVG · {CHART_EXPORT_SIZES.single.label}
                            </a>,
                            <a
                                class="report-chart-export-link"
                                href={stagedSource(card.svg.double)}
                                download={`${stem}-${CHART_EXPORT_SIZES.double.widthMm}mm.svg`}
                            >
                                SVG · {CHART_EXPORT_SIZES.double.label}
                            </a>,
                        ]
                    ) : (
                        <span class="report-chart-export-note">{PNG_ONLY_NOTE}</span>
                    )}
                    {PNG_EXPORTS.map((png) => (
                        <button
                            type="button"
                            class="report-chart-export-button"
                            data-export={png.kind}
                            data-chart={containerId}
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
