/**
 * The page assembly: the hero, the bands, the appendix band, and the footer.
 *
 * The skeleton inlines the style rules in the head, and it puts the page scripts at the end of the body.
 * The script order is a contract. The theme registration runs before the chart bootstrap, thus each chart
 * finds its theme. The fade-in observer also runs before the chart bootstrap, thus the bootstrap finds the
 * reveal gate and it signals readiness after the first reveal pass. The grid boot runs before the chart
 * bootstrap too, thus every grid stands before the page signals that it is ready. The scrollspy reads the
 * sections alone, thus its position is free. The navigation, the main content, and the reference frame
 * arrive as already-escaped markup strings, thus `raw()` inserts them byte for byte.
 *
 * One band holds one top-level section. The band index drives the alternation of the background and of the
 * texture, thus a caller that adds a band passes the next index.
 *
 * The container gives the full-bleed gutter of a region, and the content column inside it gives the one
 * measure of the page. The hero, each band, and the footer use the same pair. Thus every block kind reads at
 * one width, and the title over them sits on the same left edge.
 */

import { raw } from "hono/html";

import { ASSET_HEAD, CHART_BOOTSTRAP, FADE_IN_OBSERVER, GRID_ASSET_HEAD, GRID_BOOTSTRAP, SECTION_SPY, TABLE_DATA_DECODER } from "../page.js";
import { stagedSource } from "../assets.js";
import { DESIGN_CSS, ECHARTS_THEME, ECHARTS_THEME_NAME } from "../design.js";
import type { DataAsset } from "../table-data.js";
import type { CitationRecords } from "../../report-model/reference-resolver.js";
import type { DerivationChains, ReferenceLedger } from "../references.js";
import { renderReferences } from "./references-view.js";
import { scriptJson } from "../script-json.js";

/** The constant eyebrow of the hero. The render reads no clock, thus the hero carries no date. */
const HERO_EYEBROW = "INFLEXA · ANALYSIS REPORT";

/** The constant note of the footer. */
const FOOTER_NOTE = "Powered by Inflexa";

/** The title of the one appendix. It holds each artifact and each paper that the report names. */
const REFERENCES_TITLE = "References";

/**
 * The theme object as script-safe JSON. `scriptJson` replaces every `<` with `\u003c`, thus a later edit
 * that adds a `<` to the theme stays safe inside the script sink. The JSON parser reads `\u003c` as `<`, thus
 * the theme value stays exact.
 */
const THEME_JSON = scriptJson(ECHARTS_THEME);

/**
 * The registration script for the ECharts theme. It runs before the chart bootstrap, thus each chart
 * reads the registered theme by its name. The guard skips the call when the ECharts runtime did not load.
 */
const THEME_REGISTRATION = `(function () {
  if (typeof echarts === "undefined") {
    return;
  }
  echarts.registerTheme(${JSON.stringify(ECHARTS_THEME_NAME)}, ${THEME_JSON});
})();`;

/**
 * Wrap already-escaped markup in one full-bleed band. An even index gives the white background and the dot
 * texture, and an odd index gives the slate background and the grid texture. The noise texture lies over
 * both.
 */
export function renderBand(index: number, inner: string): string {
    const surface = index % 2 === 0 ? "report-band-white texture-dots" : "report-band-slate texture-grid";
    return String(
        <section class={`report-band ${surface} texture-noise`}>
            <div class="report-container fade-in">
                <div class="report-content">{raw(inner)}</div>
            </div>
        </section>,
    );
}

/**
 * Wrap the one appendix in a band of its own, under the one title.
 *
 * The two reference kinds answer different questions, but one marker notation sends the reader to both.
 * Thus one list serves them, and the kind tag of an entry states which question it answers.
 *
 * An empty ledger renders no band. The index continues the band alternation of the sections, thus the
 * appendix takes the next surface. The records carry the bibliography of each cited key, and a ledger with
 * no citation reads none of them. The chains carry the derivation of each derived path, and an entry of
 * such a path states it.
 */
export function renderReferenceSection(ledger: ReferenceLedger, index: number, records?: CitationRecords, chains?: DerivationChains): string {
    const references = renderReferences(ledger, records, chains);
    if (references === "") {
        return "";
    }
    const heading = String(<h2 class="report-heading report-heading-3 report-ref-title">{REFERENCES_TITLE}</h2>);
    return renderBand(index, heading + references);
}

/**
 * Assemble the page from the title, the navigation, the main content, the reference frame, and the data
 * assets. The title passes through the runtime as text, and the runtime escapes it. The reference frame is
 * optional, thus an empty frame adds no markup.
 *
 * Each data asset rides a classic `script` tag at the end of the body, and the decoder runs after the last
 * of them. Thus every payload is registered before any reader looks. A page with no asset carries no tag
 * and no decoder.
 *
 * `grids` states that the content holds a grid mount. The grid runtime weighs about two megabytes, thus a
 * page whose only payload feeds a chart references neither the runtime nor the grid boot.
 */
export function assemblePage(title: string, nav: string, content: string, references: string, dataAssets: readonly DataAsset[], grids: boolean): string {
    return (
        "<!doctype html>" +
        String(
            <html lang="en">
                <head>
                    <meta charset="utf-8" />
                    <meta name="viewport" content="width=device-width, initial-scale=1" />
                    <title>{title}</title>
                    {raw(ASSET_HEAD)}
                    {grids ? raw(GRID_ASSET_HEAD) : null}
                    <style>{raw(DESIGN_CSS)}</style>
                </head>
                <body>
                    {raw(nav)}
                    <header class="report-hero texture-noise">
                        <div class="report-container">
                            <div class="report-content">
                                <p class="report-eyebrow">{HERO_EYEBROW}</p>
                                <h1 class="report-display">{title}</h1>
                            </div>
                        </div>
                    </header>
                    <main>
                        {raw(content)}
                        {references.length > 0 ? raw(references) : null}
                    </main>
                    <footer class="report-footer">
                        <div class="report-container">
                            <div class="report-content report-footer-row">
                                <span class="report-footer-title">{title}</span>
                                <span class="report-footer-note">{FOOTER_NOTE}</span>
                            </div>
                        </div>
                    </footer>
                    {dataAssets.map((asset) => (
                        <script src={stagedSource(asset.name)}></script>
                    ))}
                    {dataAssets.length > 0 ? <script>{raw(TABLE_DATA_DECODER)}</script> : null}
                    <script>{raw(THEME_REGISTRATION)}</script>
                    <script>{raw(FADE_IN_OBSERVER)}</script>
                    {grids ? <script>{raw(GRID_BOOTSTRAP)}</script> : null}
                    <script>{raw(CHART_BOOTSTRAP)}</script>
                    <script>{raw(SECTION_SPY)}</script>
                </body>
            </html>,
        )
    );
}
