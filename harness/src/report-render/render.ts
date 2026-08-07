/**
 * The page walk: the document walk, the value-map validation, and the problem collection.
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
 * locale. Thus the same document and the same values give the same bytes.
 */

import { err, ok, type Result } from "neverthrow";

import type { Block, ReportDocument } from "../contracts/report-blocks.js";
import { renderChart } from "./chart-view.js";
import { deriveChartOption } from "./chart.js";
import { assemblePage, renderReferenceSection } from "./page-view.js";
import { renderClaim, renderNav, renderSection, renderText } from "./prose.js";
import { ReferenceLedger } from "./references.js";
import type { RenderProblem, RenderValue, RenderValues } from "./types.js";
import { renderCitation, renderFigure, renderMetric, renderTable } from "./values.js";

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

    const nav = renderNav(document.sections);
    const references = renderReferenceSection(ledger);
    return ok(assemblePage(document.title, nav, content.join(""), references));
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
            const parts: string[] = [];
            for (const child of block.blocks) {
                parts.push(renderBlock(child, values, ledger, depth + 1, problems));
            }
            return renderSection(block, depth, parts.join(""));
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
