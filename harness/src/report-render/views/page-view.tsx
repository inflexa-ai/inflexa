/**
 * The page assembly: the hero, the bands, the reference band, and the footer.
 *
 * The skeleton inlines the style rules in the head, and it puts the three scripts at the end of the body.
 * The theme registration runs before the chart bootstrap, thus each chart finds its theme. The navigation,
 * the main content, and the reference frame arrive as already-escaped markup strings, thus `raw()` inserts
 * them byte for byte.
 *
 * One band holds one top-level section. The band index drives the alternation of the background and of the
 * texture, thus a caller that adds a band passes the next index.
 */

import { raw } from "hono/html";

import { ASSET_HEAD, CHART_BOOTSTRAP, FADE_IN_OBSERVER } from "../page.js";
import { DESIGN_CSS, ECHARTS_THEME, ECHARTS_THEME_NAME } from "../design.js";
import type { ReferenceLedger } from "../references.js";
import { renderReferenceList } from "./references-view.js";
import { scriptJson } from "../script-json.js";

/** The constant eyebrow of the hero. The render reads no clock, thus the hero carries no date. */
const HERO_EYEBROW = "INFLEXA · ANALYSIS REPORT";

/** The constant note of the footer. */
const FOOTER_NOTE = "Powered by Inflexa Cortex";

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
            <div class="report-container fade-in">{raw(inner)}</div>
        </section>,
    );
}

/**
 * Wrap the reference list in the final band. An empty ledger gives an empty string, thus the page shows no
 * empty reference band. The index continues the band alternation of the sections.
 */
export function renderReferenceSection(ledger: ReferenceLedger, index: number): string {
    const list = renderReferenceList(ledger);
    if (list === "") {
        return "";
    }
    const heading = String(<h2 class="report-heading report-heading-2">References</h2>);
    return renderBand(index, heading + list);
}

/**
 * Assemble the page from the title, the navigation, the main content, and the reference frame. The title
 * passes through the runtime as text, and the runtime escapes it. The reference frame is optional, thus
 * an empty frame adds no markup.
 */
export function assemblePage(title: string, nav: string, content: string, references: string): string {
    return (
        "<!doctype html>" +
        String(
            <html lang="en">
                <head>
                    <meta charset="utf-8" />
                    <meta name="viewport" content="width=device-width, initial-scale=1" />
                    <title>{title}</title>
                    {raw(ASSET_HEAD)}
                    <style>{raw(DESIGN_CSS)}</style>
                </head>
                <body>
                    {raw(nav)}
                    <header class="report-hero texture-noise">
                        <div class="report-container">
                            <p class="report-eyebrow">{HERO_EYEBROW}</p>
                            <h1 class="report-display">{title}</h1>
                        </div>
                    </header>
                    <main>
                        {raw(content)}
                        {references.length > 0 ? raw(references) : null}
                    </main>
                    <footer class="report-footer">
                        <div class="report-container report-footer-row">
                            <span class="report-footer-title">{title}</span>
                            <span class="report-footer-note">{FOOTER_NOTE}</span>
                        </div>
                    </footer>
                    <script>{raw(THEME_REGISTRATION)}</script>
                    <script>{raw(CHART_BOOTSTRAP)}</script>
                    <script>{raw(FADE_IN_OBSERVER)}</script>
                </body>
            </html>,
        )
    );
}
