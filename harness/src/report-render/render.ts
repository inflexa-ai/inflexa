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
 * list entry. The ledger holds one ladder over both reference kinds, thus the page carries one marker
 * notation and one appendix.
 *
 * The output is a pure function of the two inputs. The renderer reads no clock, no random value, and no
 * locale. Thus the same document and the same values give the same bytes.
 */

import { err, ok, type Result } from "neverthrow";

import type { Block, ReportDocument } from "../contracts/report-blocks.js";
import { serializeReference, type ArtifactTableReference } from "../contracts/report-reference.js";
import { citationRecordOf, type CitationRecords } from "../report-model/reference-resolver.js";
import { renderChart } from "./views/chart-view.js";
import { deriveChartRender } from "./chart.js";
import { assemblePage, renderBand, renderReferenceSection } from "./views/page-view.js";
import type { ViewOptions } from "./views/lineage.js";
import { renderClaim, renderNav, renderSection, renderText } from "./views/prose.js";
import { citationKeyOf, derivationChains, ReferenceLedger, type DerivationChain } from "./references.js";
import { provenanceDataAssets, type ProvenanceExport } from "./provenance-data.js";
import { encodeTablePayload, tableDataAsset, type TablePayload } from "./table-data.js";
import type { RenderedPage, RenderProblem, RenderValue, RenderValues } from "./types.js";
import { renderCitation, renderFigure, renderMetric, renderMetricGrid, renderTable, tableColumns, tableDisplay } from "./views/values.js";

/**
 * The optional inputs of one render: the bibliography of the pin, the chains of the session, and the frozen
 * provenance of the analysis.
 *
 * Each member is absent on its own, and a caller gives the members that it holds. A positional tail of
 * three optional inputs made a caller of the last one pad the two before it, thus the three ride one bag.
 */
export interface RenderOptions {
    readonly records?: CitationRecords;
    readonly derivations?: readonly DerivationChain[];
    readonly provenance?: ProvenanceExport;
}

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
 * byte-identically with the chains and without them. A chain carries the relative source of its staged
 * script and of its derived file as data, thus the entry links both and this module stages nothing.
 *
 * The provenance is the frozen document of the analysis, and it is optional too. The renderer moves the
 * opaque text into two data assets that register one page global, and it parses no byte of it. Each
 * grounded block then stamps its keys, and its marker carries the control that opens the chain. A caller
 * that passes none renders the page byte for byte without the provenance script, without a stamp, and
 * without a control.
 *
 * The renderer writes no file. The data assets ride the result, and the caller stages them beside the page.
 * Thus the render stays pure, and two renders of one document give byte-identical assets.
 *
 * One artifact gives one payload. A table block and a chart block that bind it read that one asset, and a
 * chart under the inline bound carries its rows in its own option and registers none.
 */
export function renderReportPage(
    document: ReportDocument,
    values: RenderValues,
    { records, derivations, provenance }: RenderOptions = {},
): Result<RenderedPage, RenderProblem[]> {
    const problems: RenderProblem[] = [];
    const ledger = new ReferenceLedger();
    const data: PageData = { payloads: new Map(), mounts: 0, view: { lineage: provenance !== undefined } };

    const content: string[] = [];
    for (const [index, section] of document.sections.entries()) {
        content.push(renderBand(index, renderBlock(section, values, ledger, records, data, 0, problems)));
    }
    if (problems.length > 0) {
        return err(problems);
    }

    const tableAssets = [...data.payloads.values()].map((entry) => tableDataAsset(entry.ids, entry.payload));
    // The two asset groups stay apart in the skeleton, because the table decoder answers for a table payload
    // alone. Thus a page that carries the provenance and no table loads no decoder.
    const provenanceAssets = provenance === undefined ? [] : provenanceDataAssets(provenance);
    const nav = renderNav(document.sections);
    const references = renderReferenceSection(ledger, document.sections.length, records, derivationChains(derivations));
    return ok({
        html: assemblePage(document.title, nav, content.join(""), references, { dataAssets: tableAssets, grids: data.mounts > 0, provenanceAssets }),
        dataAssets: [...provenanceAssets, ...tableAssets],
    });
}

/**
 * One registered payload: the blocks that read it, in document order, and the encoded table.
 *
 * A table block and a chart block over one artifact read one payload, thus the page holds one copy of the
 * rows and each block finds it under its own id.
 */
interface PayloadRegistration {
    readonly ids: string[];
    readonly payload: TablePayload;
}

/**
 * The page-level state of one walk: the payload of each bound artifact, the count of the grid mounts, and
 * the view options of the page.
 *
 * The payloads key on the stable serialization of the binding. Two blocks whose bindings differ in any
 * field resolve different rows, thus they take different payloads.
 *
 * `mounts` counts the table cards. The grid runtime weighs about two megabytes, thus a page that builds no
 * grid references neither the runtime nor its boot.
 *
 * `view` holds the page-wide truths that each view reads. The bag is constant across the whole walk, thus
 * each block of one page decides it alike.
 */
interface PageData {
    readonly payloads: Map<string, PayloadRegistration>;
    mounts: number;
    readonly view: ViewOptions;
}

/**
 * Register the payload of one bound artifact, and name this block as a reader of it.
 *
 * The first block of an artifact encodes the payload. A later block over the same binding adds its id and
 * encodes nothing, thus the page carries one copy of the rows.
 */
function registerPayload(data: PageData, binding: ArtifactTableReference, blockId: string, encode: () => TablePayload): void {
    const key = serializeReference(binding);
    const registered = data.payloads.get(key);
    if (registered !== undefined) {
        registered.ids.push(blockId);
        return;
    }
    data.payloads.set(key, { ids: [blockId], payload: encode() });
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
    data: PageData,
    depth: number,
    problems: RenderProblem[],
): string {
    switch (block.kind) {
        case "text":
            return renderText(block);
        case "claim":
            return renderClaim(block, ledger, data.view);
        case "citation":
            return renderCitation(block, ledger, citationRecordOf(records, citationKeyOf(block.binding)), data.view);
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
            return renderMetric(block, ledger, entry, data.view);
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
            data.mounts += 1;
            registerPayload(data, block.binding, block.id, () => payloadOf(block.binding, entry, columns));
            return renderTable(block, ledger, entry.rows.length, entry.total, data.view);
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
            return renderFigure(block, ledger, entry, data.view);
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
            // A chart whose inline option would carry every row reads the payload of its artifact instead.
            // The payload key is the block id, thus a chart and a table over one artifact read one payload
            // under two ids. One binding resolves one row set, thus the column places and the row places of
            // the descriptors address the registered payload whichever block encoded it.
            const columns = tableColumns(entry);
            const derived = deriveChartRender(block, entry.rows, entry.columns, { key: block.id, columns });
            if (derived.isErr()) {
                problems.push(derived.error);
                return "";
            }
            if (derived.value.readsPayload) {
                registerPayload(data, block.binding, block.id, () => payloadOf(block.binding, entry, columns));
            }
            return renderChart(block, ledger, derived.value.option, data.view);
        }
        case "section":
            return renderSection(block, depth, renderChildren(block.blocks, values, ledger, records, data, depth + 1, problems));
    }
}

/**
 * The payload of one bound artifact: the encoded rows, the display of each column, and the pre-bound total.
 *
 * A table and a chart bind the same whole-table reference, thus one function serves both and the two read
 * one shape. The binding gives the declared labels and meanings, and the value gives the rows.
 */
function payloadOf(binding: ArtifactTableReference, entry: Extract<RenderValue, { type: "table" }>, columns: readonly string[]): TablePayload {
    return encodeTablePayload(columns, entry.rows, tableDisplay(binding, entry, columns), entry.total);
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
    data: PageData,
    depth: number,
    problems: RenderProblem[],
): string {
    const parts: string[] = [];
    let index = 0;
    while (index < blocks.length) {
        const run = metricRunLength(blocks, index);
        const rendered: string[] = [];
        for (let offset = 0; offset < Math.max(run, 1); offset += 1) {
            rendered.push(renderBlock(blocks[index + offset], values, ledger, records, data, depth, problems));
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
