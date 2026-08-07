/**
 * The page renderer: the document walk, the value-map validation, and the page assembly.
 *
 * `renderReportPage` walks the sections in document order. It dispatches each block to its kind renderer,
 * and it validates the bound value against the shape that the block needs. A missing entry, or an entry of
 * the wrong shape, becomes one typed problem. The walk collects every problem, thus one render reports each
 * fault at one time. A page with no problem assembles to one HTML string.
 *
 * One shared `ReferenceLedger` threads through the whole walk. Thus a claim marker and a citation marker
 * count by first appearance across the page, and a reference that two blocks share keeps one number and one
 * list entry.
 *
 * The output is a pure function of the two inputs. The renderer reads no clock, no random value, and no
 * locale. A scalar shows through `String(value)` inside the value renderer. Thus the same document and the
 * same values give the same bytes.
 */

import { err, ok, type Result } from "neverthrow";

import type { Block, ReportDocument } from "../contracts/report-blocks.js";
import { deriveChartOption, renderChart } from "./chart.js";
import { escapeHtml } from "./escape.js";
import { CDN_HEAD, CHART_BOOTSTRAP, ECHARTS_THEME, ECHARTS_THEME_NAME, PAGE_CSS } from "./page.js";
import { renderClaim, renderNav, renderSectionClose, renderSectionOpen, renderText } from "./prose.js";
import { ReferenceLedger, renderReferenceList } from "./references.js";
import type { RenderProblem, RenderValue, RenderValues } from "./types.js";
import { renderCitation, renderFigure, renderMetric, renderTable } from "./values.js";

/**
 * The theme object as script-safe JSON. The theme carries no `<` today. The escape of `<` to `<`
 * follows the script-element invariant with no exception, thus a later edit that adds a `<` stays safe. The
 * browser reverses the escape when it parses the script, thus the theme value stays exact.
 */
const THEME_JSON = JSON.stringify(ECHARTS_THEME).replace(/</g, "\\u003c");

/**
 * The registration script for the ECharts theme. It runs before the chart bootstrap, thus each chart reads
 * the registered theme by its name. The guard skips the call when the ECharts runtime did not load.
 */
const THEME_REGISTRATION = `(function () {
  if (typeof echarts === "undefined") {
    return;
  }
  echarts.registerTheme(${JSON.stringify(ECHARTS_THEME_NAME)}, ${THEME_JSON});
})();`;

/**
 * Render a report document and its value map to one HTML string.
 *
 * The walk collects every value problem. When any problem exists, the render returns the problems and no
 * HTML. When no problem exists, the render assembles the page and returns the string.
 */
export function renderReportPage(document: ReportDocument, values: RenderValues): Result<string, RenderProblem[]> {
    const problems: RenderProblem[] = [];
    const ledger = new ReferenceLedger();

    const content: string[] = [];
    for (const section of document.sections) {
        content.push(renderBlock(section, values, ledger, 0, problems));
    }
    if (problems.length > 0) {
        return err(problems);
    }

    const title = escapeHtml(document.title);
    const nav = renderNav(document.sections);
    const references = renderReferenceSection(ledger);
    return ok(assemblePage(title, nav, content.join("\n"), references));
}

/**
 * Render one block to its HTML, and collect a value problem into `problems`. A block whose value is missing
 * or of the wrong shape adds one problem and renders nothing. The empty result drops out, because the whole
 * render fails when any problem exists.
 */
function renderBlock(block: Block, values: RenderValues, ledger: ReferenceLedger, depth: number, problems: RenderProblem[]): string {
    switch (block.kind) {
        case "text":
            return renderText(block);
        case "claim":
            return renderClaim(block, ledger);
        case "citation":
            return renderCitation(block, ledger);
        case "metric": {
            const entry = values[block.id];
            if (entry === undefined) {
                problems.push(missingValue(block.id, "scalar"));
                return "";
            }
            if (entry.type !== "scalar") {
                problems.push(wrongShape(block.id, entry.type, "scalar"));
                return "";
            }
            return renderMetric(block, entry);
        }
        case "table": {
            const entry = values[block.id];
            if (entry === undefined) {
                problems.push(missingValue(block.id, "table"));
                return "";
            }
            if (entry.type !== "table") {
                problems.push(wrongShape(block.id, entry.type, "table"));
                return "";
            }
            return renderTable(block, entry);
        }
        case "figure": {
            const entry = values[block.id];
            if (entry === undefined) {
                problems.push(missingValue(block.id, "figure"));
                return "";
            }
            if (entry.type !== "figure") {
                problems.push(wrongShape(block.id, entry.type, "figure"));
                return "";
            }
            return renderFigure(block, entry);
        }
        case "chart": {
            const entry = values[block.id];
            if (entry === undefined) {
                problems.push(missingValue(block.id, "table"));
                return "";
            }
            if (entry.type !== "table") {
                problems.push(wrongShape(block.id, entry.type, "table"));
                return "";
            }
            const option = deriveChartOption(block, entry.rows, entry.columns);
            if (option.isErr()) {
                problems.push(option.error);
                return "";
            }
            return renderChart(block, option.value);
        }
        case "section": {
            const parts = [renderSectionOpen(block, depth)];
            for (const child of block.blocks) {
                parts.push(renderBlock(child, values, ledger, depth + 1, problems));
            }
            parts.push(renderSectionClose());
            return parts.join("\n");
        }
    }
}

/** A `missing-value` problem that names the block and the shape that it needs. */
function missingValue(blockId: string, expected: RenderValue["type"]): RenderProblem {
    return { blockId, kind: "missing-value", detail: `The block needs a ${expected} value entry.` };
}

/** A `wrong-shape` problem that names the block, the shape that arrived, and the shape that it needs. */
function wrongShape(blockId: string, actual: RenderValue["type"], expected: RenderValue["type"]): RenderProblem {
    return { blockId, kind: "wrong-shape", detail: `The block needs a ${expected} value entry, but the entry is a ${actual}.` };
}

/**
 * Wrap the reference list in one fixed frame. An empty ledger gives an empty string, thus the page shows no
 * empty reference frame.
 */
function renderReferenceSection(ledger: ReferenceLedger): string {
    const list = renderReferenceList(ledger);
    if (list === "") {
        return "";
    }
    return [
        `<section class="report-references-section mt-16 pt-8 border-t border-slate-200">`,
        `<h2 class="text-xl font-semibold tracking-tight text-slate-900 mb-4">References</h2>`,
        list,
        `</section>`,
    ].join("\n");
}

/**
 * Assemble the page from the escaped title, the navigation, the main content, and the reference frame. The
 * style rules inline in the head, and the two scripts sit at the end of the body. The theme registration
 * runs before the chart bootstrap, thus each chart finds its theme.
 */
function assemblePage(title: string, nav: string, content: string, references: string): string {
    const main = [
        `<main class="report-main mx-auto max-w-4xl px-6 py-10">`,
        `<h1 class="report-title text-4xl font-bold tracking-tight text-slate-900 mb-8">${title}</h1>`,
        content,
        references,
        `</main>`,
    ]
        .filter((part) => part.length > 0)
        .join("\n");
    const body = [nav, main, `<script>${THEME_REGISTRATION}</script>`, `<script>${CHART_BOOTSTRAP}</script>`].join("\n");
    return [
        `<!doctype html>`,
        `<html lang="en">`,
        `<head>`,
        `<meta charset="utf-8">`,
        `<meta name="viewport" content="width=device-width, initial-scale=1">`,
        `<title>${title}</title>`,
        CDN_HEAD,
        `<style>${PAGE_CSS}</style>`,
        `</head>`,
        `<body>`,
        body,
        `</body>`,
        `</html>`,
    ].join("\n");
}
