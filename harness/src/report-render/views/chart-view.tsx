/**
 * The chart card markup.
 *
 * The bootstrap in `page.ts` reads the option from the next element sibling of the container. Thus the
 * `<script type="application/json">` element MUST follow the container div with no element between them.
 *
 * The card is the square corner-accent form of the table and the figure, with the mono title line over it. A
 * report is a document, thus the card wears no application-window costume. The chart body carries a fixed
 * height, because the chart runtime measures the container and a container with no height shows no chart.
 */

import { raw } from "hono/html";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import type { EchartOption } from "../chart.js";
import { scriptJson } from "../script-json.js";

/** Render the card markup for a chart. */
export function renderChart(block: ChartBlock, option: EchartOption): string {
    const containerId = chartContainerId(block.id);
    // The JSON goes to the page through `raw()`, thus `scriptJson` is the sole guard of this sink. It
    // replaces every `<` with `\u003c`, thus a `</script` sequence in a string cell cannot close the
    // element early. The JSON parser reads `\u003c` as `<`, thus the option value stays exact.
    const json = scriptJson(option);
    return String(
        <div class="report-chart">
            {block.title !== undefined ? <div class="report-chart-title">{block.title}</div> : null}
            <div class="report-chart-card corner-accents">
                <div id={containerId} data-echarts-id={block.id} class="chart-container"></div>
                <script type="application/json">{raw(json)}</script>
            </div>
            {block.caption !== undefined ? <p class="report-caption">{block.caption}</p> : null}
        </div>,
    );
}

/** The container id derives from the block id, thus the id stays stable across renders. */
function chartContainerId(blockId: string): string {
    return `chart-${blockId}`;
}
