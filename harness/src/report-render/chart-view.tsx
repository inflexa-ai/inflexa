/**
 * The chart container markup.
 *
 * The bootstrap in `page.ts` reads the option from the next element sibling of the container. Thus the
 * `<script type="application/json">` element MUST follow the container div with no element between them.
 * The title renders above the container, and the caption renders below.
 */

import { raw } from "hono/html";

import type { ChartBlock } from "../contracts/report-blocks.js";
import type { EchartOption } from "./chart.js";
import { scriptJson } from "./script-json.js";

/** Render the container markup for a chart. */
export function renderChart(block: ChartBlock, option: EchartOption): string {
    const containerId = chartContainerId(block.id);
    // The JSON goes to the page through `raw()`, thus `scriptJson` is the sole guard of this sink. It
    // replaces every `<` with `\u003c`, thus a `</script` sequence in a string cell cannot close the
    // element early. The JSON parser reads `\u003c` as `<`, thus the option value stays exact.
    const json = scriptJson(option);
    return String(
        <>
            {block.title !== undefined ? <p class="chart-title">{block.title}</p> : null}
            <div id={containerId} data-echarts-id={block.id} class="chart-container"></div>
            <script type="application/json">{raw(json)}</script>
            {block.caption !== undefined ? <p class="chart-caption">{block.caption}</p> : null}
        </>,
    );
}

/** The container id derives from the block id, thus the id stays stable across renders. */
function chartContainerId(blockId: string): string {
    return `chart-${blockId}`;
}
