/**
 * The page assembly.
 *
 * The skeleton inlines the style rules in the head, and it puts the two scripts at the end of the body.
 * The theme registration runs before the chart bootstrap, thus each chart finds its theme. The
 * navigation, the main content, and the reference frame arrive as already-escaped markup strings, thus
 * `raw()` inserts them byte for byte.
 */

import { raw } from "hono/html";

import { CDN_HEAD, CHART_BOOTSTRAP, ECHARTS_THEME, ECHARTS_THEME_NAME, PAGE_CSS } from "./page.js";
import type { ReferenceLedger } from "./references.js";
import { renderReferenceList } from "./references-view.js";
import { scriptJson } from "./script-json.js";

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
 * Wrap the reference list in one fixed frame. An empty ledger gives an empty string, thus the page shows
 * no empty reference frame.
 */
export function renderReferenceSection(ledger: ReferenceLedger): string {
    const list = renderReferenceList(ledger);
    if (list === "") {
        return "";
    }
    return String(
        <section class="report-references-section mt-16 pt-8 border-t border-slate-200">
            <h2 class="text-xl font-semibold tracking-tight text-slate-900 mb-4">References</h2>
            {raw(list)}
        </section>,
    );
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
                    {raw(CDN_HEAD)}
                    <style>{raw(PAGE_CSS)}</style>
                </head>
                <body>
                    {raw(nav)}
                    <main class="report-main mx-auto max-w-4xl px-6 py-10">
                        <h1 class="report-title text-4xl font-bold tracking-tight text-slate-900 mb-8">{title}</h1>
                        {raw(content)}
                        {references.length > 0 ? raw(references) : null}
                    </main>
                    <script>{raw(THEME_REGISTRATION)}</script>
                    <script>{raw(CHART_BOOTSTRAP)}</script>
                </body>
            </html>,
        )
    );
}
