/**
 * The chart panel markup.
 *
 * The bootstrap in `page.ts` reads the option from the next element sibling of the container. Thus the
 * `<script type="application/json">` element MUST follow the container div with no element between them.
 *
 * The panel is the window-chrome form: the three dots on the left, the title in the center, and the
 * `CORTEX` badge on the right. It is the one component with rounded corners. The chart body carries a fixed
 * height, because the chart runtime measures the container and a container with no height shows no chart.
 */

import { raw } from "hono/html";

import type { ChartBlock } from "../../contracts/report-blocks.js";
import type { EchartOption } from "../chart.js";
import { scriptJson } from "../script-json.js";

/** The product badge of a chart panel. */
const PANEL_BADGE = "CORTEX";

/** Render the panel markup for a chart. */
export function renderChart(block: ChartBlock, option: EchartOption): string {
    const containerId = chartContainerId(block.id);
    // The JSON goes to the page through `raw()`, thus `scriptJson` is the sole guard of this sink. It
    // replaces every `<` with `\u003c`, thus a `</script` sequence in a string cell cannot close the
    // element early. The JSON parser reads `\u003c` as `<`, thus the option value stays exact.
    const json = scriptJson(option);
    return String(
        <div class="report-chart">
            <div class="window-chrome">
                <div class="window-chrome-bar">
                    <div class="chrome-dots">
                        <span class="chrome-dot dot-1"></span>
                        <span class="chrome-dot dot-2"></span>
                        <span class="chrome-dot dot-3"></span>
                    </div>
                    {block.title !== undefined ? <span class="window-chrome-title">{block.title}</span> : null}
                    <span class="window-chrome-badge">{PANEL_BADGE}</span>
                </div>
                <div class="window-chrome-body">
                    <div id={containerId} data-echarts-id={block.id} class="chart-container"></div>
                    <script type="application/json">{raw(json)}</script>
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
