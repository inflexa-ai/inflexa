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
 * list entry. The ledger holds one ladder for the artifact footnotes and one ladder for the literature,
 * thus the two marker sequences count apart.
 *
 * The output is a pure function of the two inputs. The renderer reads no clock, no random value, and no
 * locale. Thus the same document and the same values give the same bytes.
 */

import { err, ok, type Result } from "neverthrow";

import type { Block, ReportDocument } from "../contracts/report-blocks.js";
import { citationRecordOf, type CitationRecords } from "../report-model/reference-resolver.js";
import { renderChart } from "./views/chart-view.js";
import { deriveChartOption } from "./chart.js";
import { assemblePage, renderBand, renderReferenceSection } from "./views/page-view.js";
import { renderClaim, renderNav, renderSection, renderText } from "./views/prose.js";
import { citationKeyOf, derivationChains, ReferenceLedger, type DerivationChain } from "./references.js";
import { encodeTablePayload, tableDataAsset, type DataAsset } from "./table-data.js";
import type { RenderedPage, RenderProblem, RenderValue, RenderValues } from "./types.js";
import { renderCitation, renderFigure, renderMetric, renderMetricGrid, renderTable, tableColumns, tableDisplay } from "./views/values.js";

/**
 * Render a report document, its value map, and the pinned citation records to one page and its data assets.
 *
 * The walk collects every value problem. When any problem exists, the render returns the problems and no
 * page. When no problem exists, the render assembles the page and returns it beside the assets that the
 * page references.
 *
 * The records are the bibliography of the pin, and they are optional. A caller that passes none renders
 * each citation from its key alone, thus a stored pin that holds no record map renders as it did before.
 *
 * The derivations are the chains of the session, and they are optional too. An appendix entry whose path a
 * chain names states its sources and its script. A document that binds no derived path renders
 * byte-identically with the chains and without them.
 *
 * The renderer writes no file. The data assets ride the result, and the caller stages them beside the page.
 * Thus the render stays pure, and two renders of one document give byte-identical assets.
 */
export function renderReportPage(
    document: ReportDocument,
    values: RenderValues,
    records?: CitationRecords,
    derivations?: readonly DerivationChain[],
): Result<RenderedPage, RenderProblem[]> {
    const problems: RenderProblem[] = [];
    const ledger = new ReferenceLedger();
    const dataAssets: DataAsset[] = [];

    const content: string[] = [];
    for (const [index, section] of document.sections.entries()) {
        content.push(renderBand(index, renderBlock(section, values, ledger, records, dataAssets, 0, problems)));
    }
    if (problems.length > 0) {
        return err(problems);
    }

    const nav = renderNav(document.sections);
    const references = renderReferenceSection(ledger, document.sections.length, records, derivationChains(derivations));
    return ok({ html: assemblePage(document.title, nav, content.join(""), references, dataAssets), dataAssets });
}

/**
 * Render one block to its HTML, and collect a value problem into `problems`. A block whose value is missing
 * or of the wrong shape adds one problem and renders nothing. The empty result drops out, because the whole
 * render fails when any problem exists.
 */
function renderBlock(
    block: Block,
    values: RenderValues,
    ledger: ReferenceLedger,
    records: CitationRecords | undefined,
    dataAssets: DataAsset[],
    depth: number,
    problems: RenderProblem[],
): string {
    switch (block.kind) {
        case "text":
            return renderText(block);
        case "claim":
            return renderClaim(block, ledger);
        case "citation":
            return renderCitation(block, ledger, citationRecordOf(records, citationKeyOf(block.binding)));
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
            return renderMetric(block, ledger, entry);
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
            // The rows of the block ride a data asset, and the card holds one empty mount. The payload
            // carries the column order, thus a cell of an encoded row names its column by position and the
            // display entry of that column sits at the same index.
            const columns = tableColumns(entry);
            dataAssets.push(tableDataAsset(block.id, encodeTablePayload(columns, entry.rows, tableDisplay(block, entry, columns))));
            return renderTable(block, ledger, entry.rows.length);
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
            return renderFigure(block, ledger, entry);
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
            return renderChart(block, ledger, option.value);
        }
        case "section":
            return renderSection(block, depth, renderChildren(block.blocks, values, ledger, records, dataAssets, depth + 1, problems));
    }
}

/**
 * Render the children of one section, and group a consecutive run of metric siblings into one grid.
 *
 * A run of two or more metric blocks reads as one row of statistics, thus the grid holds the whole run. A
 * lone metric stays one card, and no grid wraps it. A block of a different kind ends the run.
 */
function renderChildren(
    blocks: Block[],
    values: RenderValues,
    ledger: ReferenceLedger,
    records: CitationRecords | undefined,
    dataAssets: DataAsset[],
    depth: number,
    problems: RenderProblem[],
): string {
    const parts: string[] = [];
    let index = 0;
    while (index < blocks.length) {
        const run = metricRunLength(blocks, index);
        const rendered: string[] = [];
        for (let offset = 0; offset < Math.max(run, 1); offset += 1) {
            rendered.push(renderBlock(blocks[index + offset], values, ledger, records, dataAssets, depth, problems));
        }
        parts.push(run > 1 ? renderMetricGrid(rendered.join("")) : rendered.join(""));
        index += Math.max(run, 1);
    }
    return parts.join("");
}

/** The count of the metric blocks that start at `start`. A block of a different kind gives zero. */
function metricRunLength(blocks: Block[], start: number): number {
    let length = 0;
    while (start + length < blocks.length && blocks[start + length].kind === "metric") {
        length += 1;
    }
    return length;
}

/** A `missing-value` problem that names the block and the shape that it needs. */
function missingValue(blockId: string, expected: RenderValue["type"]): RenderProblem {
    return { blockId, kind: "missing-value", detail: `The block needs a ${expected} value entry.` };
}

/** A `wrong-shape` problem that names the block, the shape that arrived, and the shape that it needs. */
function wrongShape(blockId: string, actual: RenderValue["type"], expected: RenderValue["type"]): RenderProblem {
    return { blockId, kind: "wrong-shape", detail: `The block needs a ${expected} value entry, but the entry is a ${actual}.` };
}
