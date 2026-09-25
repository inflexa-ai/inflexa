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
 * block and centers it. Each PNG control states the height of its export, which grows with a taller body.
 *
 * The export row sits under the chart body: a link to each staged SVG file, and one control for each PNG
 * that the page draws on click.
 */

import { raw } from "hono/html";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import type { Reference } from "../../contracts/report-reference.js";
import { kebabFilename } from "../../tools/display/normalize-echart-spec.js";
import { stagedSource } from "../assets.js";
import type { EchartOption } from "../chart.js";
import { CHART_BODY_PX, CHART_EXPORT_SIZES, exportSizeFor } from "../design.js";
import type { ReferenceLedger } from "../references.js";
import { DEFAULT_VIEW_OPTIONS, lineagePlace, lineageStamp, type ViewOptions } from "./lineage.js";
import { Marker } from "./references-view.js";
import { scriptJson } from "../script-json.js";

/**
 * What the card carries beside the option: the staged names of the two SVG files, and the box of the chart
 * body. A chart past the export bound carries no SVG name, and the card states that the PNG serves it.
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
 * Each reference of the chart joins the reference ladder: the whole-table binding, the track, and each
 * statistic, in that order. Thus the title line carries one marker for each, and the appendix names the
 * artifact that the chart plots, the second table that it draws, and each cell that it prints. A chart with
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
        ...(block.statistics ?? []).map((statistic) => statistic.value),
    ];
    const markers = references.map((reference, index) => <Marker n={ledger.mark(reference)} lineage={lineagePlace(view.lineage, reference, index)} />);
    const containerId = chartContainerId(block.id);
    // The JSON goes to the page through `raw()`, thus `scriptJson` is the sole guard of this sink. It
    // replaces every `<` with `\u003c`, thus a `</script` sequence in a string cell cannot close the
    // element early. The JSON parser reads `\u003c` as `<`, thus the option value stays exact.
    const json = scriptJson(option);
    const bodyStyle = [
        ...(card.bodyPx !== CHART_BODY_PX ? [`height: ${card.bodyPx}px`] : []),
        ...(card.widthPx !== undefined ? [`max-width: ${card.widthPx}px; margin-inline: auto`] : []),
    ].join("; ");
    const stem = kebabFilename(block.title ?? block.id);
    return String(
        <div class="report-chart" {...lineageStamp(view.lineage, block.id, references)}>
            <div class="report-chart-title">
                {block.title}
                {markers}
            </div>
            <div class="report-chart-card corner-accents">
                <div id={containerId} data-echarts-id={block.id} class="chart-container" {...(bodyStyle !== "" ? { style: bodyStyle } : {})}></div>
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
