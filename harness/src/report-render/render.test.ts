import { describe, expect, it } from "bun:test";
import { load } from "cheerio";

import type { Block, ChartBlock, CitationBlock, FigureBlock, MetricBlock, ReportDocument, TableBlock, TextBlock } from "../contracts/report-blocks.js";
import { AG_GRID_ASSET, ASSETS_DIR, DEPS_DIR, ECHARTS_ASSET, PAGE_ASSETS, TSPROV_ASSET, tableSidecarName } from "./assets.js";
import { CHART_SOURCE_MEMBER, deriveChartOption } from "./chart.js";
import {
    CHART_INLINE_OPTION_BOUND,
    DESIGN_CSS,
    GRID_HEADER_BORDER_PX,
    GRID_HEADER_HEIGHT_PX,
    GRID_MIN_COLUMN_WIDTH_PX,
    GRID_PRINT_ROW_CAP,
    GRID_ROW_HEIGHT_PX,
    GRID_THEME_PARAMS,
    GRID_VISIBLE_ROWS,
} from "./design.js";
import { FIXTURE_DOCUMENT, FIXTURE_PROVENANCE, FIXTURE_VALUES } from "./fixture.js";
import {
    CHART_BOOTSTRAP,
    GRID_BOOTSTRAP,
    LINEAGE_COMPLETE_NOTE,
    LINEAGE_NO_ANSWER_NOTE,
    LINEAGE_NO_LIBRARY_NOTE,
    LINEAGE_NO_NODE_NOTE,
    LINEAGE_POPOVER,
    LINEAGE_RECORD_NOTE,
    LINEAGE_SIGNED_NOTE,
    LINEAGE_TRUNCATED_NOTE,
    SECTION_SPY,
    TABLE_DATA_DECODER,
    TSPROV_GLOBAL,
} from "./page.js";
import { formatTableCell } from "./number-format.js";
import { REPORT_PROVENANCE_GLOBAL } from "./provenance-data.js";
import { TABLE_DATA_GLOBAL } from "./table-data.js";
import { renderReportPage } from "./render.js";
import type { RenderValues } from "./types.js";
import { LINEAGE_BLOCK_ATTRIBUTE, LINEAGE_CONTROL_CLASS, LINEAGE_KEY_ATTRIBUTE, LINEAGE_KEYS_ATTRIBUTE } from "./views/lineage.js";
import { GRID_COUNT_CLASS, GRID_MOUNT_ATTRIBUTE, GRID_NOTE_CLASS } from "./views/values.js";

/**
 * The site of the navigation brand. It is the one reference of the page that names a remote host.
 *
 * A brand link is a navigation, and a navigation costs no request. Thus the page still opens with no
 * network, and the stands-alone gate admits this one value.
 */
const BRAND_LINK = "https://inflexa.ai/";

/** One citation reference. A claim binding and a citation binding both admit it. */
const citation: CitationBlock["binding"] = { kind: "citation", idKind: "pmid", id: "12345", raw: "Doe 2020" };

/** One scalar reference for a metric block. The renderer never reads it. */
const scalarRef: MetricBlock["value"] = { kind: "artifact-value", path: "runs/r1/de.csv", hash: "sha256:aaa", locator: { column: "padj", row: 0 } };

/** The descriptor form of one `srcset` candidate: a pixel ratio such as `2x`, or a width such as `600w`. */
const SRCSET_DESCRIPTOR = /^\d+(?:\.\d+)?[wx]$/;

/**
 * Each candidate URL of one `srcset` value.
 *
 * A candidate URL holds no whitespace, and its descriptor follows it after whitespace. Thus whitespace
 * divides the list into a URL token and a descriptor token, and a comma divides two candidates that no
 * whitespace separates. A `data:` candidate holds its own commas, thus it stays whole.
 */
function srcsetCandidates(list: string): string[] {
    const candidates: string[] = [];
    for (const token of list.split(/\s+/)) {
        const trimmed = token.replace(/^,+|,+$/g, "");
        if (trimmed === "" || SRCSET_DESCRIPTOR.test(trimmed)) continue;
        if (trimmed.startsWith("data:")) {
            candidates.push(trimmed);
            continue;
        }
        for (const part of trimmed.split(",")) {
            if (part !== "") candidates.push(part);
        }
    }
    return candidates;
}

/**
 * Each `src`, `href`, and `srcset` value of the page, in document order.
 *
 * An attribute value rides a double quote or a single quote, and both forms are valid HTML. Thus the
 * pattern reads both, and a single-quoted remote source cannot pass the gate unread. A `srcset` value holds
 * a candidate list, thus it divides into its candidates.
 */
function attributeReferences(html: string): string[] {
    const references: string[] = [];
    for (const match of html.matchAll(/\b(srcset|src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        const value = match[2] ?? match[3];
        if (match[1] === "srcset") references.push(...srcsetCandidates(value));
        else references.push(value);
    }
    return references;
}

/**
 * The tag name and the attribute name of each element that carries the given value in a reference
 * attribute, in document order. One element gives one entry for each attribute that names the value.
 *
 * The gate admits one remote value. A navigation to it costs no request, but a subresource with the same
 * value fetches on open. Thus the admission binds to the element, and a value alone never earns it.
 */
function referenceSites(html: string, value: string): string[] {
    const page = load(html);
    const sites: string[] = [];
    for (const element of page("[href], [src], [srcset]").toArray()) {
        for (const name of ["href", "src", "srcset"]) {
            const attribute = page(element).attr(name);
            if (attribute === undefined) continue;
            const values = name === "srcset" ? srcsetCandidates(attribute) : [attribute];
            if (values.includes(value)) sites.push(`${element.tagName}[${name}]`);
        }
    }
    return sites;
}

/**
 * Each remote-capable reference of a style sheet, without its quotes. The `@font-face` rules reach the page
 * through the inline sheet, thus the font references live here and not in an attribute.
 *
 * Three forms name a source. `url(...)` is the common one. A bare `@import` string and an `image-set()`
 * candidate each name a source with no `url()` wrapper, thus the `url(...)` pattern alone reads neither one.
 */
function styleReferences(css: string): string[] {
    const references: string[] = [];
    for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*))\s*\)/g)) {
        references.push(match[1] ?? match[2] ?? match[3]);
    }
    for (const match of css.matchAll(/@import\s+(?:"([^"]*)"|'([^']*)')/g)) {
        references.push(match[1] ?? match[2]);
    }
    // One declaration ends at its semicolon, thus the scan of a list stops there. A comma divides the
    // candidates, and each candidate leads with its quoted source. Thus a `type(...)` hint inside a
    // candidate never reads as a source of its own.
    for (const list of css.matchAll(/image-set\(([^;]*)/g)) {
        for (const candidate of list[1].split(",")) {
            const quoted = /^\s*(?:"([^"]*)"|'([^']*)')/.exec(candidate);
            if (quoted !== null) references.push(quoted[1] ?? quoted[2]);
        }
    }
    return references;
}

/** Each table binding of a block tree, in document order. The sidecar of a card names its pinned artifact. */
function tableBindingsOf(blocks: readonly Block[]): TableBlock["binding"][] {
    const bindings: TableBlock["binding"][] = [];
    for (const block of blocks) {
        if (block.kind === "table") {
            bindings.push(block.binding);
        }
        if (block.kind === "section") {
            bindings.push(...tableBindingsOf(block.blocks));
        }
    }
    return bindings;
}

describe("renderReportPage assembly", () => {
    it("gives byte-identical output for the same document and values", () => {
        const first = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES);
        const second = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES);
        expect(first.isOk()).toBe(true);
        expect(second.isOk()).toBe(true);
        expect(first._unsafeUnwrap().html).toBe(second._unsafeUnwrap().html);
        // The payload of a table is a pure function of its rows, thus the assets match byte for byte.
        expect(first._unsafeUnwrap().dataAssets).toEqual(second._unsafeUnwrap().dataAssets);
    });

    it("renders from in-memory inputs with no directory and no file", () => {
        const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap().html;
        expect(typeof html).toBe("string");
        expect(html.startsWith("<!doctype html>")).toBe(true);
        expect(html).toContain("The cohort holds 48 primary lung adenocarcinoma biopsies.");
        expect(html).toContain("A teal point rises under hypoxia");
    });
});

describe("renderReportPage text lists", () => {
    /** One page whose section holds the given text block. */
    function pageOfText(block: TextBlock): ReturnType<typeof load> {
        const document: ReportDocument = { title: "T", sections: [{ kind: "section", id: "s", title: "S", blocks: [block] }] };
        return load(renderReportPage(document, {})._unsafeUnwrap().html);
    }

    it("holds the lead paragraph and the ordered list of six items", () => {
        const items = [
            "The cohort is small.",
            "The batch confounds.",
            "No cohort validates.",
            "The profile is bulk.",
            "The follow-up is short.",
            "One database.",
        ];
        const page = pageOfText({ kind: "text", id: "t1", content: { prose: "Six limits bound the reading.", list: { ordered: true, items } } });

        expect(page("p.report-prose").text()).toBe("Six limits bound the reading.");
        expect(page("ol.report-list li").length).toBe(6);
        expect(
            page("ol.report-list li")
                .toArray()
                .map((node) => page(node).text()),
        ).toEqual(items);
    });

    it("holds the unordered list alone for a block with an empty prose", () => {
        const page = pageOfText({ kind: "text", id: "t2", content: { prose: "", list: { ordered: false, items: ["One.", "Two.", "Three."] } } });

        expect(page("ul.report-list li").length).toBe(3);
        // An empty prose gives no paragraph, thus the band holds the list alone.
        expect(page("p.report-prose").length).toBe(0);
    });

    it("fills the content column with the list, the same as with a paragraph", () => {
        const listRules = [...DESIGN_CSS.matchAll(/\.report-list\s*\{([^}]*)\}/g)].map((match) => match[1]);
        expect(listRules.length).toBe(1);
        // A list reads at the measure of the prose around it, thus no inner width caps it.
        expect(listRules[0]).not.toContain("max-width");
        expect(listRules[0]).toContain("line-height: 1.7");
    });
});

describe("the table data assets", () => {
    const TABLE_PATH = "runs/run-1/step-a/output/de.csv";
    const TABLE_HASH = `sha256:${"a".repeat(64)}`;

    /** One page of one table block over the given rows. */
    function tableDocument(): ReportDocument {
        return {
            title: "T",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [{ kind: "table", id: "tbl", binding: { kind: "artifact-table", path: TABLE_PATH, hash: TABLE_HASH } }],
                },
            ],
        };
    }

    /** A table value of `count` rows, with a gene name, a p-value, and one of two directions. */
    function valuesOf(count: number): RenderValues {
        const rows = [];
        for (let index = 0; index < count; index += 1) {
            rows.push({ gene: `G${index}`, padj: index / count, direction: index % 2 === 0 ? "up" : "down" });
        }
        return { tbl: { type: "table", columns: ["gene", "padj", "direction"], rows } };
    }

    /**
     * Run one data asset as the page runs it, and give back the registered payload.
     *
     * The asset is browser source text, thus a read of the source string would test the serialization and
     * not the value that a reader takes. `decode` runs the page decoder over the payload as well.
     */
    function registeredPayload(asset: { bytes: string }, decode = false): { columns: string[]; rows: unknown[]; dict: Record<string, string[]> } {
        const window: Record<string, unknown> = {};
        new Function("window", asset.bytes)(window);
        if (decode) {
            new Function("window", TABLE_DATA_DECODER)(window);
        }
        const registry = window[TABLE_DATA_GLOBAL] as Record<string, { columns: string[]; rows: unknown[]; dict: Record<string, string[]> }>;
        return registry["tbl"];
    }

    it("holds one empty grid mount, and the payload holds every row", () => {
        const rendered = renderReportPage(tableDocument(), valuesOf(14201))._unsafeUnwrap();
        const page = load(rendered.html);

        expect(page(`[${GRID_MOUNT_ATTRIBUTE}="tbl"]`).length).toBe(1);
        expect(page(`[${GRID_MOUNT_ATTRIBUTE}]`).text()).toBe("");
        expect(rendered.dataAssets.length).toBe(1);

        const payload = registeredPayload(rendered.dataAssets[0]);
        expect(payload.columns).toEqual(["gene", "padj", "direction"]);
        expect(payload.rows.length).toBe(14201);
    });

    it("carries the display of each column beside the rows", () => {
        const rendered = renderReportPage(tableDocument(), valuesOf(3))._unsafeUnwrap();
        const payload = registeredPayload(rendered.dataAssets[0]) as unknown as { display: { label: string; kind: string; bound?: number }[] };

        // The server resolves the label, the kind, and the bound one time for each column. Thus the page
        // formats each cell with no read of a declaration.
        expect(payload.display.map((entry) => entry.kind)).toEqual(["compact-scientific", "scientific", "compact-scientific"]);
        expect(payload.display.map((entry) => entry.label)).toEqual(["gene", "padj", "direction"]);
        expect(payload.display[1].bound).toBe(1 / 3);
    });

    it("compresses a repeated category into the dictionary of its column", () => {
        const rendered = renderReportPage(tableDocument(), valuesOf(100))._unsafeUnwrap();
        const payload = registeredPayload(rendered.dataAssets[0]);

        // The direction column holds two values across one hundred rows, thus the payload names each one
        // time and each row holds its index.
        expect(payload.dict).toEqual({ direction: ["up", "down"] });
        expect(payload.rows[0]).toEqual(["G0", 0, 0]);
        expect(payload.rows[1]).toEqual(["G1", 0.01, 1]);
    });

    it("gives byte-identical assets and one asset name over two renders", () => {
        const first = renderReportPage(tableDocument(), valuesOf(500))._unsafeUnwrap();
        const second = renderReportPage(tableDocument(), valuesOf(500))._unsafeUnwrap();

        expect(second.dataAssets).toEqual(first.dataAssets);
        expect(second.html).toBe(first.html);
    });

    it("references each asset from a classic script tag, and decodes after the last of them", () => {
        const rendered = renderReportPage(tableDocument(), valuesOf(3))._unsafeUnwrap();
        const source = `${ASSETS_DIR}/${rendered.dataAssets[0].name}`;

        // A `fetch` is refused on a `file://` page. A classic script loads on any page, thus the data
        // reaches the reader through a script tag and never through a request.
        expect(rendered.html).toContain(`<script src="${source}"></script>`);
        expect(rendered.html.indexOf(source)).toBeLessThan(rendered.html.indexOf(TABLE_DATA_DECODER));
        expect(rendered.html.indexOf(TABLE_DATA_DECODER)).toBeLessThan(rendered.html.indexOf(GRID_BOOTSTRAP));
    });

    it("decodes the payload into plain rows, one time, in the page script", () => {
        const rendered = renderReportPage(tableDocument(), valuesOf(4))._unsafeUnwrap();
        const window: Record<string, unknown> = {};

        // The asset is browser source text. It arrives as a classic script, thus the global is the whole
        // interface between the payload and the decoder.
        new Function("window", rendered.dataAssets[0].bytes)(window);
        new Function("window", TABLE_DATA_DECODER)(window);

        const registry = window[TABLE_DATA_GLOBAL] as Record<string, { rows: Record<string, string | number>[] }>;
        expect(registry["tbl"].rows.length).toBe(4);
        expect(registry["tbl"].rows[0]).toEqual({ gene: "G0", padj: 0, direction: "up" });
        expect(registry["tbl"].rows[1]).toEqual({ gene: "G1", padj: 0.25, direction: "down" });

        // A second run finds the decoded rows and leaves them, thus a late script pays the decode one time.
        new Function("window", TABLE_DATA_DECODER)(window);
        expect(registry["tbl"].rows[0]).toEqual({ gene: "G0", padj: 0, direction: "up" });
    });

    it("decodes a column that names a prototype member as an ordinary column", () => {
        const document = tableDocument();
        // An object literal sends a `__proto__` key to the prototype. The rows arrive from a parse in the
        // real path, thus the test builds them the same way and the column stays an own key.
        const rows = JSON.parse('[{"constructor":"up","__proto__":"left","gene":"TP53"},{"constructor":"up","__proto__":"right","gene":"MYC"}]') as Record<
            string,
            string | number
        >[];
        const values: RenderValues = { tbl: { type: "table", columns: ["constructor", "__proto__", "gene"], rows } };
        const rendered = renderReportPage(document, values)._unsafeUnwrap();
        const window: Record<string, unknown> = {};

        new Function("window", rendered.dataAssets[0].bytes)(window);
        new Function("window", TABLE_DATA_DECODER)(window);

        // A column name is authored text. An object literal would send `__proto__` to the prototype, and a
        // plain record would read `constructor` off the prototype instead of the dictionary of the column.
        const registry = window[TABLE_DATA_GLOBAL] as Record<string, { rows: Record<string, string | number>[] }>;
        const first = registry["tbl"].rows[0];
        expect(Object.hasOwn(first, "__proto__")).toBe(true);
        expect(first["__proto__"]).toBe("left");
        expect(first["constructor"]).toBe("up");
        expect(registry["tbl"].rows[1]["constructor"]).toBe("up");
    });

    it("omits a column that a ragged row does not hold, thus no key reads as an empty value", () => {
        const document = tableDocument();
        const values: RenderValues = { tbl: { type: "table", columns: ["gene", "padj"], rows: [{ gene: "TP53", padj: 0.01 }, { gene: "MYC" }] } };
        const rendered = renderReportPage(document, values)._unsafeUnwrap();
        const window: Record<string, unknown> = {};

        new Function("window", rendered.dataAssets[0].bytes)(window);
        new Function("window", TABLE_DATA_DECODER)(window);

        const registry = window[TABLE_DATA_GLOBAL] as Record<string, { rows: Record<string, string | number>[] }>;
        expect(registry["tbl"].rows[1]).toEqual({ gene: "MYC" });
    });

    it("links the staged raw bytes of the artifact as the download of the card", () => {
        const rendered = renderReportPage(tableDocument(), valuesOf(3))._unsafeUnwrap();
        const link = load(rendered.html)("a.report-table-download");

        expect(link.attr("href")).toBe(`${ASSETS_DIR}/${tableSidecarName(TABLE_HASH, TABLE_PATH)}`);
        expect(link.attr("download")).toBe(tableSidecarName(TABLE_HASH, TABLE_PATH));
    });

    it("stages no data asset for a document with no table, and renders that page as before", () => {
        const document: ReportDocument = {
            title: "T",
            sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "text", id: "t1", content: { prose: "No table here." } }] }],
        };
        const rendered = renderReportPage(document, {})._unsafeUnwrap();

        expect(rendered.dataAssets).toEqual([]);
        // A page with no payload registers no map, and it carries neither the decoder nor the grid boot,
        // thus it stays what it was. The chart bootstrap names the map, because a dense chart reads it.
        expect(rendered.html).not.toContain(`window.${TABLE_DATA_GLOBAL}=`);
        expect(rendered.html).not.toContain(TABLE_DATA_DECODER);
        expect(rendered.html).not.toContain(GRID_BOOTSTRAP);
        expect(rendered.html).not.toContain(".data.js");
        expect(rendered.html).toBe(renderReportPage(document, {})._unsafeUnwrap().html);
    });
});

describe("the provenance data assets", () => {
    const DOCUMENT = '{"entity":{"e1":{"prov:type":"file"}}}';
    const ATTESTATION = '{"signature":"AAAA"}';

    /** One document of one table block, thus the page carries a table payload beside the provenance. */
    function pageDocument(): ReportDocument {
        return {
            title: "T",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [{ kind: "table", id: "tbl", binding: { kind: "artifact-table", path: "runs/r1/de.csv", hash: "sha256:aaa" } }],
                },
            ],
        };
    }

    /** The value of the one table block. */
    const pageValues: RenderValues = { tbl: { type: "table", columns: ["gene"], rows: [{ gene: "TP53" }] } };

    /** The provenance assets of a render, in load order. The table payload keeps its own prefix. */
    function provenanceAssets(assets: readonly { name: string; bytes: string }[]): { name: string; bytes: string }[] {
        return assets.filter((asset) => asset.name.startsWith("prov-"));
    }

    /**
     * Run the provenance assets as the page runs them, and give back the registered global.
     *
     * An asset is browser source text, thus a read of the source string would test the serialization and not
     * the value that a reader takes.
     */
    function registeredProvenance(assets: readonly { name: string; bytes: string }[]): { document?: string; attestation?: string } {
        const window: Record<string, unknown> = {};
        for (const asset of provenanceAssets(assets)) {
            new Function("window", asset.bytes)(window);
        }
        return (window[REPORT_PROVENANCE_GLOBAL] ?? {}) as { document?: string; attestation?: string };
    }

    it("registers the document and the attestation under one global, byte for byte", () => {
        const rendered = renderReportPage(pageDocument(), pageValues, undefined, undefined, {
            document: DOCUMENT,
            attestation: ATTESTATION,
        })._unsafeUnwrap();

        expect(provenanceAssets(rendered.dataAssets).length).toBe(2);
        // The renderer moves the text and never parses it, thus the reader takes the bytes that the source
        // gave.
        expect(registeredProvenance(rendered.dataAssets)).toEqual({ document: DOCUMENT, attestation: ATTESTATION });
    });

    it("names each asset by the hash of its own bytes, and two renders give one name", () => {
        const first = renderReportPage(pageDocument(), pageValues, undefined, undefined, { document: DOCUMENT, attestation: ATTESTATION })._unsafeUnwrap();
        const second = renderReportPage(pageDocument(), pageValues, undefined, undefined, { document: DOCUMENT, attestation: ATTESTATION })._unsafeUnwrap();

        const [documentAsset, attestationAsset] = provenanceAssets(first.dataAssets);
        expect(documentAsset.name).toMatch(/^prov-[0-9a-f]{12}\.data\.js$/);
        expect(attestationAsset.name).toMatch(/^prov-[0-9a-f]{12}\.sig\.data\.js$/);
        expect(second.dataAssets).toEqual(first.dataAssets);
        expect(second.html).toBe(first.html);
    });

    it("gives a new name for a changed document, and keeps the attestation name", () => {
        const first = renderReportPage(pageDocument(), pageValues, undefined, undefined, { document: DOCUMENT, attestation: ATTESTATION })._unsafeUnwrap();
        const changed = renderReportPage(pageDocument(), pageValues, undefined, undefined, {
            document: '{"entity":{"e2":{"prov:type":"file"}}}',
            attestation: ATTESTATION,
        })._unsafeUnwrap();

        // The name carries the hash of the bytes, thus a changed document lands under a new name and the
        // sweep of the stage removes the name that the page does not reference any more.
        expect(provenanceAssets(changed.dataAssets)[0].name).not.toBe(provenanceAssets(first.dataAssets)[0].name);
        expect(provenanceAssets(changed.dataAssets)[1].name).toBe(provenanceAssets(first.dataAssets)[1].name);
    });

    it("references each asset from a classic script tag, before the table assets and every bootstrap", () => {
        const rendered = renderReportPage(pageDocument(), pageValues, undefined, undefined, {
            document: DOCUMENT,
            attestation: ATTESTATION,
        })._unsafeUnwrap();
        const [documentAsset, attestationAsset] = provenanceAssets(rendered.dataAssets);
        const tableAsset = rendered.dataAssets.find((asset) => asset.name.startsWith("t-"));

        // A `fetch` is refused on a `file://` page, thus the document reaches the reader through a script tag
        // and never through a request.
        expect(rendered.html).toContain(`<script src="${ASSETS_DIR}/${documentAsset.name}"></script>`);
        expect(rendered.html).toContain(`<script src="${ASSETS_DIR}/${attestationAsset.name}"></script>`);
        expect(tableAsset).toBeDefined();
        const documentAt = rendered.html.indexOf(documentAsset.name);
        expect(documentAt).toBeLessThan(rendered.html.indexOf(attestationAsset.name));
        expect(rendered.html.indexOf(attestationAsset.name)).toBeLessThan(rendered.html.indexOf(tableAsset!.name));
        expect(documentAt).toBeLessThan(rendered.html.indexOf(TABLE_DATA_DECODER));
        expect(documentAt).toBeLessThan(rendered.html.indexOf(CHART_BOOTSTRAP));
        expect(documentAt).toBeLessThan(rendered.html.indexOf(SECTION_SPY));
    });

    it("carries the document alone when the export holds no attestation", () => {
        const rendered = renderReportPage(pageDocument(), pageValues, undefined, undefined, { document: DOCUMENT })._unsafeUnwrap();

        // An unsigned document still rides the page, thus the reader finds the document and no attestation.
        expect(provenanceAssets(rendered.dataAssets).length).toBe(1);
        expect(rendered.html).not.toContain(".sig.data.js");
        expect(registeredProvenance(rendered.dataAssets)).toEqual({ document: DOCUMENT });
    });

    it("keeps a document that names the script element as data", () => {
        const hostile = '{"note":"</script><img src=x>"}';
        const rendered = renderReportPage(pageDocument(), pageValues, undefined, undefined, { document: hostile })._unsafeUnwrap();

        // The text rides as a JSON string, thus a `</script` sequence inside it cannot close the element.
        expect(provenanceAssets(rendered.dataAssets)[0].bytes).not.toContain("</script");
        expect(registeredProvenance(rendered.dataAssets).document).toBe(hostile);
    });

    it("stages no provenance asset for a render that takes none, and that page is what it was", () => {
        const rendered = renderReportPage(pageDocument(), pageValues)._unsafeUnwrap();

        expect(provenanceAssets(rendered.dataAssets)).toEqual([]);
        expect(rendered.html).not.toContain(`window.${REPORT_PROVENANCE_GLOBAL}`);
        expect(rendered.html).not.toContain("prov-");
        // A page whose only payload is the table renders byte for byte as it did before the seam.
        expect(rendered.html).toBe(renderReportPage(pageDocument(), pageValues, undefined, undefined, undefined)._unsafeUnwrap().html);
    });
});

describe("the lineage stamp and the popover control", () => {
    /** The provenance of a lineage render. The renderer parses no byte of it, thus one literal serves. */
    const PROVENANCE = { document: '{"entity":{}}' };

    /** The whole-table pin that the claim, the table, and the chart all bind. */
    const tablePin: TableBlock["binding"] = { kind: "artifact-table", path: "runs/r1/de.csv", hash: "sha256:aaa" };

    /** The whole-file pin of the figure. */
    const filePin: FigureBlock["binding"] = { kind: "artifact-file", path: "runs/r1/volcano.svg", hash: "sha256:bbb" };

    /** A derivation over two cells. It computes a value, thus it names no file of its own. */
    const ratio: MetricBlock["value"] = {
        kind: "derivation",
        op: "ratio",
        inputs: [
            { kind: "artifact-value", path: "runs/r1/de.csv", hash: "sha256:aaa", locator: { column: "padj", row: 0 } },
            { kind: "artifact-value", path: "runs/r1/de.csv", hash: "sha256:aaa", locator: { column: "padj", row: 1 } },
        ],
    };

    /** One document that holds every grounded kind, plus a metric over the derivation. */
    function groundedDocument(): ReportDocument {
        return {
            title: "T",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [
                        { kind: "claim", id: "clm", content: { prose: "The depth is enough." }, bindings: [tablePin, citation] },
                        { kind: "metric", id: "met", label: "Genes tested", value: scalarRef },
                        { kind: "metric", id: "drv", label: "Ratio", value: ratio },
                        { kind: "table", id: "tbl", title: "Genes", binding: tablePin },
                        { kind: "chart", id: "cht", title: "Scores", binding: tablePin, chartType: "bar", encoding: { x: "gene", y: "score" } },
                        { kind: "figure", id: "fig", binding: filePin, caption: "Volcano" },
                        { kind: "citation", id: "cit", binding: citation },
                    ],
                },
            ],
        };
    }

    /** The value of each block of the grounded document. */
    const groundedValues: RenderValues = {
        met: { type: "scalar", value: 18432 },
        drv: { type: "scalar", value: 1.5 },
        tbl: { type: "table", columns: ["gene", "score"], rows: [{ gene: "TP53", score: 2 }] },
        cht: { type: "table", columns: ["gene", "score"], rows: [{ gene: "TP53", score: 2 }] },
        fig: { type: "figure", src: "plot.svg" },
    };

    /** The page of the grounded document, with a provenance document or without one. */
    function groundedPage(provenance?: { document: string }): string {
        return renderReportPage(groundedDocument(), groundedValues, undefined, undefined, provenance)._unsafeUnwrap().html;
    }

    /** The keys that one block stamped, read back from the container of the block. */
    function keysOf(html: string, blockId: string): unknown[] {
        const value = load(html)(`[${LINEAGE_BLOCK_ATTRIBUTE}="${blockId}"]`).attr(LINEAGE_KEYS_ATTRIBUTE);
        return value === undefined ? [] : (JSON.parse(value) as unknown[]);
    }

    /** The place that each control of one block names, in document order. */
    function placesOf(html: string, blockId: string): string[] {
        const page = load(html);
        return page(`[${LINEAGE_BLOCK_ATTRIBUTE}="${blockId}"] .${LINEAGE_CONTROL_CLASS}`)
            .toArray()
            .map((control) => page(control).attr(LINEAGE_KEY_ATTRIBUTE) ?? "");
    }

    it("stamps the block id and the pin of each grounded kind", () => {
        const html = groundedPage(PROVENANCE);

        // Every grounded kind carries the same stamp, thus one reader of the markup serves them all.
        expect(keysOf(html, "met")).toEqual([{ path: "runs/r1/de.csv", hash: "sha256:aaa" }]);
        expect(keysOf(html, "tbl")).toEqual([{ path: tablePin.path, hash: tablePin.hash }]);
        expect(keysOf(html, "cht")).toEqual([{ path: tablePin.path, hash: tablePin.hash }]);
        expect(keysOf(html, "fig")).toEqual([{ path: filePin.path, hash: filePin.hash }]);
    });

    it("keeps one key for each binding of a claim, in marker order", () => {
        const html = groundedPage(PROVENANCE);

        // The claim binds an artifact and a paper. The place of a control indexes the bindings, thus the two
        // controls address the two keys in the order of the markers.
        expect(keysOf(html, "clm")).toEqual([
            { path: tablePin.path, hash: tablePin.hash },
            { idKind: "pmid", id: "12345" },
        ]);
        expect(placesOf(html, "clm")).toEqual(["0", "1"]);
    });

    it("stamps the external record of a citation in place of a pin", () => {
        // A paper is no artifact, thus no pin addresses it and the record identity answers instead.
        expect(keysOf(groundedPage(PROVENANCE), "cit")).toEqual([{ idKind: "pmid", id: "12345" }]);
    });

    it("gives no key and no control to a binding that pins no file", () => {
        const html = groundedPage(PROVENANCE);

        // A derivation computes over two inputs, thus the document holds no node of its own bytes. The place
        // stays in the list, thus the places of the other bindings of a block do not move.
        expect(keysOf(html, "drv")).toEqual([null]);
        expect(placesOf(html, "drv")).toEqual([]);
    });

    it("emits one control beside the marker of each stamped key", () => {
        const page = load(groundedPage(PROVENANCE));

        // The document binds eight references over seven blocks. Seven of them give a key, and the
        // derivation gives none. The control sits inside the marker, thus one emission point serves each
        // kind.
        expect(page(`.report-marker > .${LINEAGE_CONTROL_CLASS}`).length).toBe(7);
        expect(page(`button.${LINEAGE_CONTROL_CLASS}[aria-expanded="false"]`).length).toBe(7);
    });

    it("carries no stamp, no control, and no popover script without a document", () => {
        const html = groundedPage();

        // Absence of the document is a normal condition. The page then holds the markup that it holds
        // without the lineage, thus nothing on it opens a panel.
        expect(html).not.toContain("data-lineage");
        expect(html).not.toContain("<button");
        expect(html).not.toContain(LINEAGE_POPOVER);
        expect(load(html)(`.${LINEAGE_CONTROL_CLASS}`).length).toBe(0);
    });

    it("rides the page as one script for a page that carries a document", () => {
        expect(groundedPage(PROVENANCE)).toContain(LINEAGE_POPOVER);
    });

    it("keeps a hostile pin inside its attribute", () => {
        const hostile: TableBlock["binding"] = { kind: "artifact-table", path: 'x" onclick="alert(1)', hash: "sha256:aaa" };
        const document: ReportDocument = {
            title: "T",
            sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "table", id: "tbl", binding: hostile }] }],
        };
        const html = renderReportPage(
            document,
            { tbl: { type: "table", columns: ["gene"], rows: [{ gene: "TP53" }] } },
            undefined,
            undefined,
            PROVENANCE,
        )._unsafeUnwrap().html;

        // The markup runtime escapes each attribute value, thus a hostile path reaches the page as text and
        // it opens no event handler.
        expect(html).not.toContain('onclick="alert(1)"');
        expect(keysOf(html, "tbl")).toEqual([{ path: hostile.path, hash: hostile.hash }]);
    });

    it("names the provenance library through one global, and states each absence in its own form", () => {
        // The page and the library meet at one name. Each absence is a normal condition, thus each one
        // carries a note of its own and none of them reads as the other.
        expect(LINEAGE_POPOVER).toContain(`window.${TSPROV_GLOBAL}`);
        expect(LINEAGE_POPOVER).toContain(JSON.stringify(LINEAGE_NO_LIBRARY_NOTE));
        expect(LINEAGE_POPOVER).toContain(JSON.stringify(LINEAGE_NO_ANSWER_NOTE));
        expect(LINEAGE_POPOVER).toContain(JSON.stringify(LINEAGE_NO_NODE_NOTE));
        expect(LINEAGE_POPOVER).toContain(JSON.stringify(LINEAGE_TRUNCATED_NOTE));
        expect(LINEAGE_POPOVER).toContain(JSON.stringify(LINEAGE_RECORD_NOTE));
    });

    it("claims a signature in the footer only where the page carries an attestation", () => {
        // The carrier holds the attestation where the source held one. Thus the footer of a page over an
        // unsigned document never states that the analysis document signs the chain.
        expect(LINEAGE_POPOVER).toContain('typeof carrier.attestation === "string"');
        expect(LINEAGE_POPOVER).toContain(`signed ? ${JSON.stringify(LINEAGE_SIGNED_NOTE)} : ${JSON.stringify(LINEAGE_COMPLETE_NOTE)}`);
    });

    it("reads the document, builds the graph one time, and walks backward over the dataflow", () => {
        // The walk belongs to the library. The graph builds on the first click and it stands after that,
        // thus a second panel of one page parses nothing again.
        expect(LINEAGE_POPOVER).toContain("library.provToGraph(library.read(text))");
        expect(LINEAGE_POPOVER).toContain("if (graph === null && !graphFailed) {");
        expect(LINEAGE_POPOVER).toContain('library.lineage(built, found.record, { direction: "backward", relations: "dataflow" })');

        // The walk rides the depth bound of the library, thus the page names none of its own.
        expect(LINEAGE_POPOVER).not.toContain("depth:");
    });

    it("resolves the node of a pin by the path and the hash of the document writer", () => {
        // The writer of the document stamps these two names on a file entity. A selector over any other
        // name resolves nothing, and each popover would then show the absence note.
        expect(LINEAGE_POPOVER).toContain("library.resolveUnique(built, {");
        expect(LINEAGE_POPOVER).toContain('{ name: "inflexa:path", equals: key.path }');
        expect(LINEAGE_POPOVER).toContain('{ name: "inflexa:hash", equals: key.hash }');
    });

    it("references the provenance library on a page that carries a document, and never without one", () => {
        const html = groundedPage(PROVENANCE);
        const tag = `<script src="${ASSETS_DIR}/${TSPROV_ASSET.file}"></script>`;

        // The library walks a pin, and a page with no document holds no pin to walk. The popover reads the
        // global, thus the tag stands before the script. The manifest still stages the file for the whole
        // directory, the same as the grid runtime.
        expect(html).toContain(tag);
        expect(html.indexOf(tag)).toBeLessThan(html.indexOf(LINEAGE_POPOVER));
        expect(PAGE_ASSETS).toContain(TSPROV_ASSET);
        expect(groundedPage()).not.toContain(TSPROV_ASSET.file);
    });

    it("builds the rail from the edges of the walk, and never from its node set", () => {
        // The node set is flat: it holds the siblings and the bookkeeping beside the chain. The edges carry
        // the structure, thus the rail reads them and the panel shows the chain alone.
        expect(LINEAGE_POPOVER).toContain("for (var e = 0; e < walked.edges.length; e++) {");
        expect(LINEAGE_POPOVER).toContain("edge.relation instanceof library.ProvGeneration");
        expect(LINEAGE_POPOVER).toContain("edge.relation instanceof library.ProvUsage");
        expect(LINEAGE_POPOVER).toContain("edge.relation instanceof library.ProvCommunication");
        expect(LINEAGE_POPOVER).not.toContain("walked.nodes");
    });

    it("expands an execution alone, and reads the step through the edge that names it", () => {
        // A step, a run, and a lifecycle action are the bookkeeping of the analysis. The rail expands the two
        // execution types alone, thus no bookkeeping node becomes a row. A command activity carries no step
        // id, thus the step comes from the activity at the end of its communication edge.
        expect(LINEAGE_POPOVER).toContain('if (type !== "Command" && type !== "FileToolWrite") {');
        expect(LINEAGE_POPOVER).toContain("var stepUri = ranIn[uri];");
        expect(LINEAGE_POPOVER).toContain('attrText(stepNode.element, "inflexa:stepId")');
    });

    it("collapses the other outputs of one command behind a count row", () => {
        // The backward walk never traverses the generation edge of a sibling output, thus the graph answers
        // for the count. One row then states what the rail leaves out, and no off-chain file becomes a hop.
        expect(LINEAGE_POPOVER).toContain("var into = built.inEdges(commandUri);");
        expect(LINEAGE_POPOVER).toContain("return total - onRail;");
        expect(LINEAGE_POPOVER).toContain('rows.push({ form: "more", level: level + 1, count: others, step: command.step });');
    });

    it("guards the walk against a document whose edges lead back to a command that the rail showed", () => {
        // Without the visited set such a document would build rows forever.
        expect(LINEAGE_POPOVER).toContain("if (seenCommand[commandUri]) {");
        expect(LINEAGE_POPOVER).toContain("seenCommand[commandUri] = true;");
        expect(LINEAGE_POPOVER).toContain("if (seenFile[inputs[i]]) {");
    });

    it("names the pin as the last hop where the walk gives nothing", () => {
        // The page knows the pin on its own. Thus a reader of a chain that stops still reads what the block
        // binds, and the note states why the chain stops there.
        expect(LINEAGE_POPOVER).toContain('rows = [{ form: "pin", level: 0, path: String(key.path), hash: String(key.hash) }];');
    });

    it("shows the external record of a citation and walks nothing for it", () => {
        // The walk resolves a node by a pin. A record names a paper, thus the pin branch alone calls the
        // library and the record branch names the record.
        expect(LINEAGE_POPOVER).toContain('var pinned = typeof key.path === "string";');
        expect(LINEAGE_POPOVER).toContain(`var walked = pinned ? walk(key) : { rows: [], note: ${JSON.stringify(LINEAGE_RECORD_NOTE)}, hops: 1 };`);
        expect(LINEAGE_POPOVER).toContain('rows = [{ form: "record", level: 0, path: recordName(key), hash: "" }];');
    });

    it("opens one panel at a time, and closes on a click outside and on the Escape key", () => {
        const handler = LINEAGE_POPOVER.slice(LINEAGE_POPOVER.indexOf('document.addEventListener("click"'));

        // One delegated listener serves the whole page. It closes the open panel before it opens another,
        // thus two panels never stand together.
        expect(handler.indexOf("close();")).toBeLessThan(handler.indexOf("openFor(control);"));
        expect(handler).toContain("if (!insidePanel(event.target)) {");
        expect(LINEAGE_POPOVER).toContain('document.addEventListener("keydown"');
        expect(LINEAGE_POPOVER).toContain('event.key === "Escape"');
    });

    it("asks for nothing over the network", () => {
        // The document rides the page already, thus the panel reads it in memory and a `file://` page still
        // opens every chain.
        expect(LINEAGE_POPOVER).not.toContain("fetch(");
        expect(LINEAGE_POPOVER).not.toContain("XMLHttpRequest");
    });

    it("parses as browser source", () => {
        // The script rides the page as text. Thus a syntax fault would show in a browser alone, and the
        // parse here catches it at build time.
        expect(() => new Function(LINEAGE_POPOVER)).not.toThrow();
    });

    it("holds no popover rule that no emitter writes", () => {
        const html = groundedPage(PROVENANCE);
        const classes = [...new Set([...DESIGN_CSS.matchAll(/\.(report-lineage[a-z-]*)/g)].map((match) => match[1]))];

        expect(classes.length).toBeGreaterThan(1);
        for (const name of classes) {
            // A rule with no emitter is dead. The view emits the control, and the page script emits each
            // class of the panel.
            expect(html.includes(`class="${name}"`) || LINEAGE_POPOVER.includes(`"${name}"`)).toBe(true);
        }
    });

    it("builds the header, the scrolling body, and the completion footer of the locked anatomy", () => {
        // The header names the marker and the depth of the chain, the body holds the rail, and the footer
        // states the outcome. A reader reads the size of the chain before the body scrolls.
        expect(LINEAGE_POPOVER).toContain('"report-lineage-header"');
        expect(LINEAGE_POPOVER).toContain('"report-lineage-count"');
        expect(LINEAGE_POPOVER).toContain('"report-lineage-body"');
        expect(LINEAGE_POPOVER).toContain('"report-lineage-footer"');
        expect(LINEAGE_POPOVER).toContain('countText(marker, walked.hops, walked.note === "")');
    });

    it("gives the rail one form for the pin, one for a producer, and one for a raw input", () => {
        // The three forms carry the chain. A row with no modifier is an artifact that the rail continues
        // past, thus the base row is the form that the panel shows most.
        expect(LINEAGE_POPOVER).toContain('"report-lineage-row-pin"');
        expect(LINEAGE_POPOVER).toContain('"report-lineage-row-producer"');
        expect(LINEAGE_POPOVER).toContain('"report-lineage-row-raw"');
        expect(LINEAGE_POPOVER).toContain('"report-lineage-more"');

        // The connector labels ride the indent rails between two levels of the rail.
        expect(LINEAGE_POPOVER).toContain('"report-lineage-link"');
        expect(LINEAGE_POPOVER).toContain('"report-lineage-rail"');
        expect(LINEAGE_POPOVER).toContain('"MADE BY"');
        expect(LINEAGE_POPOVER).toContain('return count === 1 ? "READ 1 FILE" : "READ " + count + " FILES";');
    });

    it("caps the body inside the viewport and holds the panel above the control where it does not fit", () => {
        const bodyRule = /\.report-lineage-body\s*\{([^}]*)\}/.exec(DESIGN_CSS);
        if (bodyRule === null) {
            throw new Error("The design sheet holds no body rule for the lineage popover.");
        }

        // A deep pipeline builds more rows than a window holds. The cap reads against the viewport, thus the
        // body scrolls inside the panel and the page never grows under it.
        expect(bodyRule[1]).toContain("max-height: 60vh");
        expect(bodyRule[1]).toContain("overflow-y: auto");
        expect(LINEAGE_POPOVER).toContain("box.top - panel.offsetHeight - 8");
    });

    it("drops the shared run prefix from each row, and rides the whole path on the hover", () => {
        // Every hop of one chain sits under the run directory of the pin, thus the head repeats on each row
        // and it carries nothing. The title states the whole path on each row, cut or not, thus the reader
        // reads the head back with no second panel. A path outside the run keeps its whole form.
        expect(LINEAGE_POPOVER).toContain('if (path.indexOf("runs/") !== 0) {');
        expect(LINEAGE_POPOVER).toContain('var cut = path.indexOf("/", 5);');
        expect(LINEAGE_POPOVER).toContain('return prefix !== "" && path.indexOf(prefix) === 0 ? path.slice(prefix.length) : path;');
        expect(LINEAGE_POPOVER).toContain('var prefix = pinned ? runPrefix(String(key.path)) : "";');
        expect(LINEAGE_POPOVER).toContain("pathNode(shownPath(row.path, prefix), row.path)");
        expect(LINEAGE_POPOVER).toContain('node.setAttribute("title", full);');
    });

    it("cuts a long tail at its start, thus the file name stays on the row", () => {
        // The measure runs against the laid-out row, and the cut takes whole segments off the front. A
        // reordering of the text would mangle the punctuation of a path, thus the script measures and the
        // sheet holds no bidi rule.
        expect(LINEAGE_POPOVER).toContain("while (parts.length > 1 && node.scrollWidth > node.clientWidth) {");
        expect(LINEAGE_POPOVER).toContain("parts.shift();");
        expect(LINEAGE_POPOVER).toContain('writePath(node, "…/" + parts.join("/"));');
        expect(LINEAGE_POPOVER).toContain("fitPaths(panel);");
        expect(LINEAGE_POPOVER.indexOf("fitPaths(panel);")).toBeLessThan(LINEAGE_POPOVER.indexOf("place(panel, control);"));
        expect(DESIGN_CSS).not.toContain("direction: rtl");
    });

    it("cuts an over-long name in its middle, thus the start and the extension both stay on the row", () => {
        const script = LINEAGE_POPOVER.slice(LINEAGE_POPOVER.indexOf("function nameTail("), LINEAGE_POPOVER.indexOf("function fitPaths("));

        // A name that overflows the row on its own leaves no segment to cut. The tail starts at the last dot,
        // thus the extension stays and two siblings that differ in their extension alone read apart. A dot far
        // from the end belongs to the name, thus the fixed count answers there and the start still stays.
        expect(script).toContain('var dot = name.lastIndexOf(".");');
        expect(script).toContain("var extension = dot > 0 ? name.length - dot : 0;");
        expect(script).toContain("name.slice(name.length - (extension > 0 && extension <= 8 ? extension : 4))");
        expect(script).toContain("while (keep > 1 && node.scrollWidth > node.clientWidth) {");
        expect(script).toContain('writePath(node, head + name.slice(0, keep) + "…" + tail);');

        // The segment cut runs first and the name cut runs after it, thus a long directory still goes before
        // one character of the name goes. The mark of the segment cut stands in front of the cut name.
        const fitPath = script.slice(script.indexOf("function fitPath("));
        expect(fitPath).toContain('fitName(node, whole > 1 ? "…/" : "", parts[0]);');
        expect(fitPath.indexOf("parts.shift();")).toBeLessThan(fitPath.indexOf("fitName(node,"));

        // The rule of the sheet stays as the last guard, for a row too narrow to hold even a cut name.
        expect(DESIGN_CSS).toContain("text-overflow: ellipsis;");
    });

    it("sizes the panel to its longest row up to a cap, and holds that width across the fit", () => {
        const rule = /\.report-lineage-popover \{([^}]*)\}/.exec(DESIGN_CSS);
        if (rule === null) {
            throw new Error("The design sheet holds no rule for the lineage popover.");
        }

        // The panel grows to its longest row, thus a normal window shows each name whole and the cut answers
        // a narrow window alone. The cap bounds the panel against the design and against the viewport.
        expect(rule[1]).toContain("width: max-content;");
        expect(rule[1]).toContain("max-width: min(48rem, calc(100vw - 24px));");

        // A cut shortens the row that sized the panel. Without the pin the panel would shrink under the fit,
        // and each later row would then measure against a narrower box.
        expect(LINEAGE_POPOVER).toContain('panel.style.width = panel.getBoundingClientRect().width + "px";');
        expect(LINEAGE_POPOVER.indexOf("panel.style.width =")).toBeLessThan(LINEAGE_POPOVER.indexOf("fitPaths(panel);"));
    });

    it("opens the panel under the control, flips it over the control on short space, and covers it never", () => {
        // The reader reads down from what was clicked, thus the panel opens under the control. Where neither
        // side holds the whole panel, the body shrinks to the larger side. Thus the panel never covers the
        // control, and the horizontal clamp holds it inside the two margins of the viewport.
        expect(LINEAGE_POPOVER).toContain("var below = root.clientHeight - box.bottom - 8 * 2;");
        expect(LINEAGE_POPOVER).toContain("var above = box.top - 8 * 2;");
        expect(LINEAGE_POPOVER).toContain("var over = panel.offsetHeight > below && above > below;");
        expect(LINEAGE_POPOVER).toContain("var top = over ? box.top - panel.offsetHeight - 8 : box.bottom + 8;");
        expect(LINEAGE_POPOVER).toContain('body.style.maxHeight = (room - chrome > 0 ? room - chrome : 0) + "px";');
        expect(LINEAGE_POPOVER).toContain("if (left < 12) {");
    });

    it("places the open panel again on a resize", () => {
        const handler = LINEAGE_POPOVER.slice(LINEAGE_POPOVER.indexOf('window.addEventListener("resize"'));

        // A resize moves the box of the control. The panel stands against the document, thus it would hold
        // the place of the old box without this listener.
        expect(handler).toContain("place(openPanel, openControl);");
        expect(handler).not.toContain("close()");
    });

    it("draws the control as a stroke branch glyph that takes the color of its button", () => {
        const page = load(groundedPage(PROVENANCE));
        const glyph = page(`button.${LINEAGE_CONTROL_CLASS} svg.report-lineage-glyph`).first();

        // The drawing strokes in the current color, thus the muted color of the button and its primary color
        // on hover both reach it. It is decoration, thus the label of the button answers a reader who hears
        // the page.
        expect(glyph.length).toBe(1);
        expect(glyph.attr("stroke")).toBe("currentColor");
        expect(glyph.attr("stroke-width")).toBe("1.5");
        expect(glyph.attr("aria-hidden")).toBe("true");
        expect(glyph.find("circle").length).toBe(3);
        expect(glyph.find("path").length).toBe(3);
    });

    it("hides the control and the panel in print, and drops the open motion under reduced motion", () => {
        const printAt = DESIGN_CSS.indexOf("@media print");
        const print = DESIGN_CSS.slice(printAt);
        const reduced = DESIGN_CSS.slice(DESIGN_CSS.indexOf("@media (prefers-reduced-motion: reduce)"), printAt);

        // Paper opens no panel, and the appendix carries the same references. Thus the print loses no
        // evidence with the control gone.
        expect(print).toContain(".report-lineage,");
        expect(print).toContain(".report-lineage-popover");
        expect(reduced).toContain(".report-lineage-popover");
        expect(reduced).toContain("animation: none;");
    });

    it("shows the control on the design fixture, which carries a document", () => {
        const page = load(renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES, undefined, undefined, FIXTURE_PROVENANCE)._unsafeUnwrap().html);

        // A person examines the fixture page after an edit of the design. A fixture with no control would
        // keep the panel out of that look.
        expect(page(`button.${LINEAGE_CONTROL_CLASS}`).length).toBeGreaterThan(0);
    });
});

describe("the page stands alone", () => {
    /** A page whose citation card carries a pinned record, thus the body holds a PubMed navigation. */
    function pageWithACitation(): string {
        const document: ReportDocument = {
            title: "T",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [{ kind: "citation", id: "cit1", binding: { kind: "citation", idKind: "pmid", id: "26997480", raw: "Hugo W, et al." } }],
                },
            ],
        };
        return renderReportPage(document, {}, { "pmid:26997480": { citation: "Hugo et al. 2016" } })._unsafeUnwrap().html;
    }

    /**
     * A page whose appendix chain links the staged script of a derivation and the derived file itself.
     *
     * The derived file sits beside the page and not under `assets/`, thus this page is the one that proves
     * the containment rule against a page-relative link.
     */
    function pageWithADerivationChain(): string {
        const document: ReportDocument = {
            title: "T",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [
                        {
                            kind: "claim",
                            id: "c1",
                            content: { prose: "The derived table carries the counts." },
                            bindings: [{ kind: "artifact-file", path: "derived/counts.csv", hash: "sha256:ccc" }],
                        },
                    ],
                },
            ],
        };
        const chain = {
            outputPath: "derived/counts.csv",
            sources: [{ path: "runs/r1/de.csv", hash: "sha256:aaa" }],
            scriptHash: "sha256:bbb",
            scriptSource: `${ASSETS_DIR}/d-bbb.py`,
            outputSource: "derived/counts.csv",
        };
        return renderReportPage(document, {}, undefined, [chain])._unsafeUnwrap().html;
    }

    /**
     * The rule reads the element and never the value. A navigation costs no request when the page opens,
     * thus an anchor admits a remote host. A `src`, a `srcset`, and a stylesheet source each fetch on
     * open, thus none of them admits one.
     */
    function remoteSitesOf(html: string): string[] {
        const remote = [...attributeReferences(html), ...styleReferences(DESIGN_CSS)].filter((value) => /^https?:/i.test(value));
        return [...new Set(remote.flatMap((value) => referenceSites(html, value)))];
    }

    /**
     * True when one reference resolves inside the page directory.
     *
     * A value that names no scheme is relative, thus it resolves beside the page: a staged asset, a derived
     * file that the appendix chain links, or an anchor of the page itself. A leading slash and a parent
     * segment each leave that directory, thus neither one passes.
     *
     * A value that names a scheme resolves elsewhere. The inline data URI carries its own bytes, and the
     * remote value answers to the site rule above. Every other scheme fails here. The scheme test reads the
     * start of the value, thus a namespace URI inside a data URI never reads as one.
     */
    function insideThePage(value: string): boolean {
        if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
            return value.startsWith("data:") || /^https?:/i.test(value);
        }
        return !value.startsWith("/") && !value.split("/").includes("..");
    }

    it("names a remote host at a navigation anchor and at no other element", () => {
        for (const html of [renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap().html, pageWithACitation(), pageWithADerivationChain()]) {
            const references = [...attributeReferences(html), ...styleReferences(DESIGN_CSS)];
            expect(references.length).toBeGreaterThan(0);

            // A remote value of the style sheet reaches no element of the page, thus it gives no site and
            // the empty list fails this equality.
            expect(remoteSitesOf(html)).toEqual(["a[href]"]);

            expect(references.filter((value) => !insideThePage(value))).toEqual([]);
        }
    });

    it("refuses a reference that leaves the page directory", () => {
        // The rule is containment and not a prefix, thus the two escapes must fail it and the two page-side
        // forms must pass it.
        expect(insideThePage("../secret.csv")).toBe(false);
        expect(insideThePage("/etc/passwd")).toBe(false);
        expect(insideThePage("file:///etc/passwd")).toBe(false);
        expect(insideThePage("derived/counts.csv")).toBe(true);
        expect(insideThePage(`${ASSETS_DIR}/echarts.min.js`)).toBe(true);
    });

    it("links the derived file of a chain as a page-relative path", () => {
        // The chain link is the one reference of the page that names no `assets/` prefix. Thus the fixture
        // holds it, and the containment rule above reads it.
        const html = pageWithADerivationChain();
        expect(attributeReferences(html)).toContain("derived/counts.csv");
    });

    it("names the brand host one time, thus no second surface fetches it", () => {
        const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap().html;
        expect(html.split(BRAND_LINK).length - 1).toBe(1);
    });

    it("names a staged file for each asset reference of the page", () => {
        const rendered = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap();
        const sidecars = tableBindingsOf(FIXTURE_DOCUMENT.sections).map((binding) => tableSidecarName(binding.hash, binding.path));
        const staged = new Set([...PAGE_ASSETS.map((asset) => asset.file), ...rendered.dataAssets.map((asset) => asset.name), ...sidecars]);
        const prefix = `${ASSETS_DIR}/`;
        const stagedReferences = [...attributeReferences(rendered.html), ...styleReferences(DESIGN_CSS)].filter((value) => value.startsWith(prefix));
        expect(stagedReferences.length).toBeGreaterThan(0);

        // A reference that no staged file answers is a request that fails when the page opens. The three
        // kinds together are what the preview writes beside the page.
        const unstaged = stagedReferences.filter((value) => !staged.has(value.slice(prefix.length)));
        expect(unstaged).toEqual([]);
    });

    it("names each library and each font under the deps directory, and each report-side file at the root", () => {
        const rendered = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap();
        const deps = `${ASSETS_DIR}/${DEPS_DIR}/`;

        // The shipped libraries and fonts sit apart from what the report produced. The manifest carries the
        // subpath, thus the head tag, the font rule, and the stage step read one source.
        expect(PAGE_ASSETS.filter((asset) => !asset.file.startsWith(`${DEPS_DIR}/`))).toEqual([]);
        expect(rendered.html).toContain(`<script src="${deps}`);
        expect(DESIGN_CSS).toContain(deps);

        // A data asset is a file that this render produced, thus it stays at the root of the directory.
        expect(rendered.dataAssets.length).toBeGreaterThan(0);
        expect(rendered.dataAssets.filter((asset) => asset.name.includes("/"))).toEqual([]);
        for (const asset of rendered.dataAssets) {
            expect(rendered.html).toContain(`<script src="${ASSETS_DIR}/${asset.name}"></script>`);
        }
    });
});

describe("the stands-alone extraction", () => {
    /** The remote references of a value list. The test reads the start of a value, as the gate does. */
    function remote(values: string[]): string[] {
        return values.filter((value) => /^https?:/i.test(value));
    }

    it("reads a remote source out of each attribute form that HTML admits", () => {
        // Each line carries one remote source in a form that the double-quoted `src`/`href` pattern misses.
        const doctored = [
            `<img srcset="assets/one.png 1x, https://cdn.example.com/two.png 2x"/>`,
            `<img src='https://cdn.example.com/single.png'/>`,
            `<a href="#top">anchor</a>`,
        ].join("");
        expect(remote(attributeReferences(doctored))).toEqual(["https://cdn.example.com/two.png", "https://cdn.example.com/single.png"]);
    });

    it("reads a remote source out of each style form that CSS admits", () => {
        const doctored = [
            `@import "https://cdn.example.com/sheet.css";`,
            `.a { background-image: image-set("https://cdn.example.com/one.avif" 1x, "assets/one.png" 2x); }`,
            `.b { background-image: url("assets/local.svg"); }`,
        ].join("\n");
        expect(remote(styleReferences(doctored))).toEqual(["https://cdn.example.com/sheet.css", "https://cdn.example.com/one.avif"]);
    });

    it("names the element and the attribute of each site of one value", () => {
        // The exemption of the gate rides on the anchor. Thus the extraction must divide a navigation from
        // a subresource that names the same value.
        const doctored = `<a href="https://inflexa.ai/">brand</a><script src="https://inflexa.ai/"></script>`;
        expect(referenceSites(doctored, "https://inflexa.ai/")).toEqual(["a[href]", "script[src]"]);
    });

    it("keeps a data URI whole and reads no scheme out of the middle of one", () => {
        // The namespace URI inside the data URI names no host to fetch. The value must stay one value, thus
        // no fragment of it reaches the gate as a reference of its own.
        const dataUri = `data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E`;
        const references = [
            ...attributeReferences(`<img srcset="${dataUri} 1x, assets/one.png 2x"/>`),
            ...styleReferences(`.a { background-image: url("${dataUri}"); }`),
        ];
        expect(references).toEqual([dataUri, "assets/one.png", dataUri]);
        expect(remote(references)).toEqual([]);
    });
});

describe("renderReportPage metric grouping", () => {
    /** One metric block. The label doubles as the id, thus a failure names the block that it renders. */
    function metric(id: string): Block {
        return { kind: "metric", id, label: id, value: scalarRef };
    }

    /** One text block. A block of a different kind ends a metric run. */
    function text(id: string): Block {
        return { kind: "text", id, content: { prose: id } };
    }

    /** A one-section document over the given blocks. */
    function pageOf(blocks: Block[]): ReportDocument {
        return { title: "T", sections: [{ kind: "section", id: "s", title: "S", blocks }] };
    }

    /** One scalar entry for each metric id. */
    function scalars(...ids: string[]): RenderValues {
        const values: RenderValues = {};
        for (const id of ids) {
            values[id] = { type: "scalar", value: 1 };
        }
        return values;
    }

    /** The grid count, the card count, and the count of the cards inside a grid. */
    function counts(html: string): { grids: number; cards: number; grouped: number } {
        const page = load(html);
        return {
            grids: page(".report-metric-grid").length,
            cards: page(".stat-card").length,
            grouped: page(".report-metric-grid .stat-card").length,
        };
    }

    it("groups a run of three metrics into one grid of three cards", () => {
        const html = renderReportPage(pageOf([metric("m1"), metric("m2"), metric("m3")]), scalars("m1", "m2", "m3"))._unsafeUnwrap().html;
        expect(counts(html)).toEqual({ grids: 1, cards: 3, grouped: 3 });
    });

    it("leaves a lone metric between two texts as a bare card", () => {
        const html = renderReportPage(pageOf([text("t1"), metric("m1"), text("t2")]), scalars("m1"))._unsafeUnwrap().html;
        // One metric reads as one statistic, not as a row of statistics. Thus no grid wraps it.
        expect(counts(html)).toEqual({ grids: 0, cards: 1, grouped: 0 });
    });

    it("groups a run of two that ends the section", () => {
        const html = renderReportPage(pageOf([text("t1"), metric("m1"), metric("m2")]), scalars("m1", "m2"))._unsafeUnwrap().html;
        expect(counts(html)).toEqual({ grids: 1, cards: 2, grouped: 2 });
    });

    it("groups a run inside a nested section", () => {
        const nested: Block = {
            kind: "section",
            id: "inner",
            title: "Inner",
            blocks: [metric("m1"), metric("m2"), text("t1")],
        };
        const html = renderReportPage(pageOf([text("t0"), nested]), scalars("m1", "m2"))._unsafeUnwrap().html;
        expect(counts(html)).toEqual({ grids: 1, cards: 2, grouped: 2 });
    });

    it("reports the missing value of one metric inside a run", () => {
        const problems = renderReportPage(pageOf([metric("m1"), metric("m2"), metric("m3")]), scalars("m1", "m3"))._unsafeUnwrapErr();
        expect(problems.length).toBe(1);
        expect(problems[0].kind).toBe("missing-value");
        expect(problems[0].blockId).toBe("m2");
    });
});

describe("renderReportPage value validation", () => {
    it("reports a missing metric value and gives no HTML", () => {
        const document: ReportDocument = {
            title: "T",
            sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "metric", id: "m1", label: "L", value: scalarRef }] }],
        };
        // `_unsafeUnwrapErr` throws on an ok result, thus the direct chain asserts the err case and no HTML.
        const problems = renderReportPage(document, {})._unsafeUnwrapErr();
        expect(problems.length).toBe(1);
        expect(problems[0].kind).toBe("missing-value");
        expect(problems[0].blockId).toBe("m1");
    });

    it("reports a wrong shape when a chart gets a scalar", () => {
        const document: ReportDocument = {
            title: "T",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [
                        {
                            kind: "chart",
                            id: "c1",
                            binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:aaa" },
                            chartType: "bar",
                            encoding: { x: "day", y: "count" },
                        },
                    ],
                },
            ],
        };
        const problems = renderReportPage(document, { c1: { type: "scalar", value: 1 } })._unsafeUnwrapErr();
        expect(problems.length).toBe(1);
        expect(problems[0].kind).toBe("wrong-shape");
        expect(problems[0].blockId).toBe("c1");
        // The detail names the expected shape.
        expect(problems[0].detail).toContain("table");
    });

    it("collects both problems when two entries are absent", () => {
        const document: ReportDocument = {
            title: "T",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [
                        { kind: "metric", id: "m1", label: "L", value: scalarRef },
                        { kind: "table", id: "tbl", binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:aaa" } },
                    ],
                },
            ],
        };
        const problems = renderReportPage(document, {})._unsafeUnwrapErr();
        expect(problems.length).toBe(2);
        const ids = problems.map((problem) => problem.blockId);
        expect(ids).toContain("m1");
        expect(ids).toContain("tbl");
    });

    it("renders a claim with no value entry", () => {
        const document: ReportDocument = {
            title: "T",
            sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "claim", id: "c1", content: { prose: "A claim." }, bindings: [citation] }] }],
        };
        const result = renderReportPage(document, {});
        expect(result.isOk()).toBe(true);
        const html = result._unsafeUnwrap().html;
        expect(html).toContain("A claim.");
        expect(html).toContain(`href="#ref-1"`);
    });
});

describe("renderReportPage navigation and references", () => {
    it("targets the three section ids from the navigation", () => {
        const child: TextBlock = { kind: "text", id: "t", content: { prose: "x" } };
        const document: ReportDocument = {
            title: "T",
            sections: [
                { kind: "section", id: "sec-1", title: "One", blocks: [child] },
                { kind: "section", id: "sec-2", title: "Two", blocks: [child] },
                { kind: "section", id: "sec-3", title: "Three", blocks: [child] },
            ],
        };
        const html = renderReportPage(document, {})._unsafeUnwrap().html;
        expect(html).toContain(`href="#sec-1"`);
        expect(html).toContain(`href="#sec-2"`);
        expect(html).toContain(`href="#sec-3"`);
    });

    it("lists one entry for a reference that a claim and a citation share", () => {
        const shared: CitationBlock["binding"] = { kind: "citation", idKind: "pmid", id: "999", raw: "Shared source" };
        const document: ReportDocument = {
            title: "T",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [
                        { kind: "claim", id: "c1", content: { prose: "A claim." }, bindings: [shared] },
                        { kind: "citation", id: "cit1", binding: shared },
                    ],
                },
            ],
        };
        const html = renderReportPage(document, {})._unsafeUnwrap().html;
        // The appendix holds one entry.
        expect(html.split(`<li id="ref-`).length - 1).toBe(1);
        // The claim marker and the citation marker point at the same entry.
        expect(html.split(`href="#ref-1"`).length - 1).toBe(2);
    });

    it("lists one entry for one paper that two blocks name with different display text", () => {
        const document: ReportDocument = {
            title: "T",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [
                        {
                            kind: "claim",
                            id: "c1",
                            content: { prose: "A claim." },
                            bindings: [{ kind: "citation", idKind: "pmid", id: "26997480", raw: "Hugo W, et al. Science. 2016." }],
                        },
                        {
                            kind: "citation",
                            id: "cit1",
                            binding: { kind: "citation", idKind: "pmid", id: "26997480", raw: "Hugo 2016" },
                        },
                    ],
                },
            ],
        };
        const html = renderReportPage(document, {})._unsafeUnwrap().html;

        // The key names the paper, and the raw text is the words of the author. Thus one paper takes one
        // number, and the two markers point at the one entry.
        expect(html.split(`<li id="ref-`).length - 1).toBe(1);
        expect(html.split(`href="#ref-1"`).length - 1).toBe(2);
    });
});

describe("the citation card and its appendix entry", () => {
    /**
     * One page whose section holds two artifact claims and two citation blocks.
     *
     * One ladder counts the four references in document order. Thus the two artifact claims take `[1]` and
     * `[2]`, and the two citation cards take `[3]` and `[4]`.
     */
    const twoOfEach: ReportDocument = {
        title: "T",
        sections: [
            {
                kind: "section",
                id: "s",
                title: "S",
                blocks: [
                    { kind: "claim", id: "c1", content: { prose: "The first claim." }, bindings: [scalarRef] },
                    {
                        kind: "claim",
                        id: "c2",
                        content: { prose: "The second claim." },
                        bindings: [{ kind: "artifact-table", path: "runs/r1/de.csv", hash: "sha256:bbb" }],
                    },
                    { kind: "citation", id: "cit1", binding: citation, note: "the first paper" },
                    {
                        kind: "citation",
                        id: "cit2",
                        binding: { kind: "citation", idKind: "pmid", id: "26997480", raw: "Hugo W, et al." },
                        note: "the second paper",
                    },
                ],
            },
        ],
    };

    it("shows the marker, the short citation, the note, and the PubMed link of a recorded key", () => {
        const html = renderReportPage(
            twoOfEach,
            {},
            { "pmid:26997480": { citation: "Hugo et al. 2016", description: "The resistance paper." } },
        )._unsafeUnwrap().html;
        const card = load(html)("div.report-citation").last();

        expect(card.find("span.report-marker").text()).toBe("[4]");
        expect(card.find("a.report-citation-source").text()).toBe("Hugo et al. 2016");
        expect(card.find("a.report-citation-source").attr("href")).toBe("https://pubmed.ncbi.nlm.nih.gov/26997480/");
        expect(card.find("span.report-citation-note").text()).toBe("the second paper");
        expect(card.find("span.report-citation-key").text()).toBe("pmid:26997480");
        // The card sits in the body, thus it carries the short citation and never the description.
        expect(card.text()).not.toContain("The resistance paper.");

        // The appendix entry names the paper beside the key, and it carries the description under them.
        const entry = load(html)("li#ref-4");
        expect(entry.text()).toContain("Hugo et al. 2016");
        expect(entry.text()).toContain("pmid:26997480");
        expect(entry.find("div.report-cite-description").text()).toBe("The resistance paper.");
    });

    it("adds no description line to a record that carries none", () => {
        const html = renderReportPage(twoOfEach, {}, { "pmid:26997480": { citation: "Hugo et al. 2016" } })._unsafeUnwrap().html;

        expect(load(html)("li#ref-4").text()).toContain("Hugo et al. 2016");
        expect(load(html)("li#ref-4 div.report-cite-description").length).toBe(0);
    });

    it("shows the key and the note alone for a key that the record map does not hold", () => {
        const html = renderReportPage(twoOfEach, {}, { "pmid:26997480": { citation: "Hugo et al. 2016" } })._unsafeUnwrap().html;
        const card = load(html)("div.report-citation").first();

        expect(card.find("a.report-citation-source").length).toBe(0);
        expect(card.find("span.report-citation-key").text()).toBe("pmid:12345");
        expect(card.find("span.report-citation-note").text()).toBe("the first paper");
        // The appendix entry of a record-less key names the key alone.
        expect(load(html)("li#ref-3").text()).toContain("pmid:12345");
        expect(load(html)("li#ref-3 span.report-cite-source").length).toBe(0);
    });

    it("counts the artifact markers and the citation markers in one ladder", () => {
        const page = load(renderReportPage(twoOfEach, {})._unsafeUnwrap().html);

        // Every marker of the page counts in one sequence, in document order.
        expect(
            page("span.report-marker a")
                .toArray()
                .map((node) => page(node).text()),
        ).toEqual(["[1]", "[2]", "[3]", "[4]"]);
        // One list holds the four entries, thus each marker points into it.
        expect(page("ol.report-references li").length).toBe(4);
        expect(page("ol.report-citations").length).toBe(0);
        expect(
            page("ol.report-references li")
                .toArray()
                .map((node) => page(node).attr("id")),
        ).toEqual(["ref-1", "ref-2", "ref-3", "ref-4"]);
    });

    it("names PubMed as a navigation and never as a loaded resource", () => {
        const html = renderReportPage(twoOfEach, {}, { "pmid:26997480": { citation: "Hugo et al. 2016" } })._unsafeUnwrap().html;
        const link = "https://pubmed.ncbi.nlm.nih.gov/26997480/";

        // A navigation costs no request when the page opens, thus the page still stands alone.
        expect(referenceSites(html, link)).toEqual(["a[href]"]);
    });

    it("renders a stored pin that holds no record map as it did before", () => {
        const withNoRecords = renderReportPage(twoOfEach, {})._unsafeUnwrap().html;
        const withEmptyRecords = renderReportPage(twoOfEach, {}, {})._unsafeUnwrap().html;

        expect(withNoRecords).toBe(withEmptyRecords);
        expect(withNoRecords).not.toContain("pubmed.ncbi.nlm.nih.gov");
        expect(withNoRecords).toContain("pmid:12345");
    });
});

describe("the page identity", () => {
    const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap().html;

    it("closes the page with the Inflexa footer note", () => {
        expect(html).toContain("Powered by Inflexa");
    });

    it("links the navigation brand to the Inflexa site", () => {
        const brand = load(html)("a.report-nav-brand-name");
        expect(brand.length).toBe(1);
        expect(brand.attr("href")).toBe(BRAND_LINK);
    });

    it("names the engine on no surface", () => {
        // The page is the surface that a reader outside the team sees. The engine name is an internal term,
        // thus no heading, no badge, and no note carries it.
        expect(html).not.toContain("Cortex");
        expect(html).not.toContain("CORTEX");
    });
});

describe("the one content column", () => {
    /** A document that carries prose, a table, and a chart. The three kinds must read at one measure. */
    const columnDocument: ReportDocument = {
        title: "T",
        sections: [
            {
                kind: "section",
                id: "s",
                title: "S",
                blocks: [
                    { kind: "text", id: "t", content: { prose: "Prose." } },
                    { kind: "table", id: "tbl", binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:aaa" } },
                    {
                        kind: "chart",
                        id: "cht",
                        binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:aaa" },
                        chartType: "bar",
                        encoding: { x: "day", y: "count" },
                    },
                ],
            },
        ],
    };

    /** One table value for the table block and one for the chart block. */
    const columnValues: RenderValues = {
        tbl: { type: "table", rows: [{ day: "Mon", count: 1 }] },
        cht: { type: "table", rows: [{ day: "Mon", count: 1 }] },
    };

    it("holds the prose, the table, and the chart inside the one column", () => {
        const page = load(renderReportPage(columnDocument, columnValues)._unsafeUnwrap().html);
        expect(page(".report-content .report-prose").length).toBe(1);
        expect(page(".report-content .report-table").length).toBe(1);
        expect(page(".report-content .report-chart").length).toBe(1);
        // One column sits inside each container, thus one mechanism serves the hero, each band, and the
        // footer. A second mechanism would let one region drift away from the rest.
        expect(page(".report-content").length).toBe(page(".report-container").length);
    });

    it("caps no prose measure below the column width", () => {
        const proseRules = [...DESIGN_CSS.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.report-prose\s*\{([^}]*)\}/g)].map((match) => match[1]);
        expect(proseRules.length).toBeGreaterThan(0);
        // An inner measure on the prose alone leaves a half-empty band beside a full-width table.
        for (const body of proseRules) {
            expect(body).not.toContain("max-width");
        }
        // The width rides one token, thus each region reads the same value.
        expect(DESIGN_CSS).toMatch(/\.report-content\s*\{[^}]*max-width:\s*var\(--content-max\)/);
        expect(DESIGN_CSS).toMatch(/--content-max:\s*\d+px/);
    });
});

describe("the References appendix", () => {
    /** A document whose one claim binds an artifact, thus the ladder holds one artifact entry. */
    const artifactDocument: ReportDocument = {
        title: "T",
        sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "claim", id: "c1", content: { prose: "A claim." }, bindings: [scalarRef] }] }],
    };

    /** A document whose one claim binds a paper, thus the ladder holds one literature entry. */
    const citationDocument: ReportDocument = {
        title: "T",
        sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "claim", id: "c1", content: { prose: "A claim." }, bindings: [citation] }] }],
    };

    /** A document whose one claim binds an artifact and a paper, in that order. */
    const bothDocument: ReportDocument = {
        title: "T",
        sections: [
            {
                kind: "section",
                id: "s",
                title: "S",
                blocks: [{ kind: "claim", id: "c1", content: { prose: "A claim." }, bindings: [scalarRef, citation] }],
            },
        ],
    };

    /** The text of each appendix heading of a page, in document order. */
    function appendixTitles(html: string): string[] {
        const page = load(html);
        return page("h2.report-ref-title")
            .toArray()
            .map((node) => page(node).text());
    }

    it("titles the one appendix References on a page of artifacts alone", () => {
        const html = renderReportPage(artifactDocument, {})._unsafeUnwrap().html;

        expect(appendixTitles(html)).toEqual(["References"]);
        expect(load(html)("ol.report-references li").length).toBe(1);
    });

    it("titles the one appendix References on a page of papers alone", () => {
        const html = renderReportPage(citationDocument, {})._unsafeUnwrap().html;

        // One notation sends the reader to one list, thus a page of papers wears the same title as a page
        // of artifacts.
        expect(appendixTitles(html)).toEqual(["References"]);
        expect(load(html)("ol.report-references li").length).toBe(1);
    });

    it("holds both kinds in one list, in number order, each under its kind tag", () => {
        const html = renderReportPage(bothDocument, {})._unsafeUnwrap().html;
        const page = load(html);
        const items = page("ol.report-references li").toArray();

        expect(appendixTitles(html)).toEqual(["References"]);
        // The claim binds the artifact first, thus the artifact entry sits at the first anchor. The kind
        // tag of each entry states which shape it carries.
        expect(items.map((node) => page(node).attr("id"))).toEqual(["ref-1", "ref-2"]);
        expect(items.map((node) => page(node).find("span.report-ref-kind").first().text())).toEqual(["Artifact value", "Citation"]);
    });

    it("renders no appendix band for a page that binds nothing", () => {
        const bare: ReportDocument = {
            title: "T",
            sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "text", id: "t", content: { prose: "Prose." } }] }],
        };
        const html = renderReportPage(bare, {})._unsafeUnwrap().html;

        expect(appendixTitles(html)).toEqual([]);
        expect(html).not.toContain(">References<");
    });

    it("carries one bracket notation and neither retired heading on the fixture page", () => {
        const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap().html;
        const page = load(html);
        const markers = page("span.report-marker a")
            .toArray()
            .map((node) => page(node).text());

        // Every marker of a page that holds each block kind reads as a bracket number.
        expect(markers.length).toBeGreaterThan(0);
        for (const marker of markers) {
            expect(marker).toMatch(/^\[\d+\]$/);
        }
        // The superscript notation retires, thus no element of the page carries it.
        expect(html).not.toContain("<sup");
        // Neither retired title names a heading of the page, and the one appendix wears its own title.
        const headings = page("h1, h2, h3, h4")
            .toArray()
            .map((node) => page(node).text());
        expect(headings).not.toContain("Data provenance");
        expect(headings).not.toContain("Literature");
        expect(headings).toContain("References");
    });

    it("reads quieter than the body of the report", () => {
        const itemRules = [...DESIGN_CSS.matchAll(/\.report-ref-item\s*\{([^}]*)\}/g)].map((match) => match[1]);
        const sizes = itemRules.flatMap((body) => [...body.matchAll(/font-size:\s*(\d+)px/g)].map((match) => Number(match[1])));
        expect(sizes.length).toBeGreaterThan(0);
        // The body reads at 16px. A reader consults one entry of the appendix from a marker, thus the
        // appendix reads smaller than the text that sent the reader to it.
        expect(Math.max(...sizes)).toBeLessThan(16);
    });
});

describe("the evidentiary bindings in the appendix", () => {
    const PINNED = "runs/run-1/step-a/output/de.csv";
    const DERIVED = "report-sessions/t1/derived/merged.csv";
    const PINNED_HASH = `sha256:${"a".repeat(64)}`;
    const DERIVED_HASH = `sha256:${"d".repeat(64)}`;

    /** The chain of the derived path: two sources with their hashes, and the script that made the table. */
    const chain = {
        outputPath: DERIVED,
        sources: [
            { path: "runs/run-1/step-a/output/de.csv", hash: `sha256:${"a".repeat(64)}` },
            { path: "runs/run-1/step-b/output/counts.csv", hash: `sha256:${"b".repeat(64)}` },
        ],
        scriptHash: `sha256:${"c".repeat(64)}`,
    };

    /** One page whose section holds the given blocks. */
    function pageOf(blocks: Block[], values: RenderValues, derivations?: readonly (typeof chain)[]): string {
        const document: ReportDocument = { title: "T", sections: [{ kind: "section", id: "s", title: "S", blocks }] };
        return renderReportPage(document, values, undefined, derivations)._unsafeUnwrap().html;
    }

    /** One block of each evidentiary kind over the given artifact. Each one binds through its own kind. */
    function tableBlock(path: string, hash: string): Block {
        return { kind: "table", id: "tbl", binding: { kind: "artifact-table", path, hash } };
    }

    function chartBlock(path: string, hash: string): Block {
        return { kind: "chart", id: "cht", binding: { kind: "artifact-table", path, hash }, chartType: "bar", encoding: { x: "day", y: "count" } };
    }

    function metricBlock(path: string, hash: string): Block {
        return { kind: "metric", id: "mtr", label: "Genes tested", value: { kind: "artifact-value", path, hash, locator: { column: "count", row: 0 } } };
    }

    function figureBlock(path: string, hash: string): Block {
        return { kind: "figure", id: "fig", binding: { kind: "artifact-file", path, hash } };
    }

    const oneRow: RenderValues = {
        tbl: { type: "table", rows: [{ day: "Mon", count: 1 }] },
        cht: { type: "table", rows: [{ day: "Mon", count: 1 }] },
        mtr: { type: "scalar", value: 1 },
        fig: { type: "figure", src: "assets/plot.png" },
    };

    it("gives a bound table its marker and its appendix entry", () => {
        const html = pageOf([tableBlock(PINNED, PINNED_HASH)], oneRow);
        const page = load(html);

        // Every evidentiary block ledgers, thus the card carries a marker and the appendix names the path.
        expect(page(".report-table-title .report-marker a").attr("href")).toBe("#ref-1");
        expect(page("li#ref-1").text()).toContain(PINNED);
        expect(page("li#ref-1").text()).toContain("Artifact table");
    });

    it("gives a bound chart its marker and its appendix entry", () => {
        const html = pageOf([chartBlock(PINNED, PINNED_HASH)], oneRow);
        const page = load(html);

        expect(page(".report-chart-title .report-marker a").attr("href")).toBe("#ref-1");
        expect(page("li#ref-1").text()).toContain(PINNED);
    });

    it("gives one number to a table and a chart over one artifact", () => {
        const html = pageOf([tableBlock(PINNED, PINNED_HASH), chartBlock(PINNED, PINNED_HASH)], oneRow);
        const page = load(html);

        // The two blocks bind one reference. The ledger keeps one identity, thus the appendix holds one
        // entry and both markers point at it.
        expect(page("ol.report-references li").length).toBe(1);
        expect(page('.report-marker a[href="#ref-1"]').length).toBe(2);
    });

    it("gives a marker and a chain entry to each evidentiary kind over one derived path", () => {
        const blocks = [
            metricBlock(DERIVED, DERIVED_HASH),
            tableBlock(DERIVED, DERIVED_HASH),
            chartBlock(DERIVED, DERIVED_HASH),
            figureBlock(DERIVED, DERIVED_HASH),
        ];
        const page = load(pageOf(blocks, oneRow, [chain]));

        // Each of the four cards carries its marker, each on the line that names the card.
        expect(page(".stat-card-label .report-marker").length).toBe(1);
        expect(page(".report-table-title .report-marker").length).toBe(1);
        expect(page(".report-chart-title .report-marker").length).toBe(1);
        expect(page(".report-figure .report-caption .report-marker").length).toBe(1);

        // Each marker points at an entry that exists. The table and the chart bind one whole-table
        // reference, thus three entries serve the four cards.
        const targets = page(".report-marker a")
            .toArray()
            .map((node) => page(node).attr("href"));
        expect(targets.length).toBe(4);
        expect(targets.filter((target) => page(`li${target}`).length === 1).length).toBe(4);
        expect(page("ol.report-references li").length).toBe(3);
        // Every entry names the derived path, thus every entry states the chain of that path.
        expect(page("ol.report-references li .report-ref-chain").length).toBe(3);
    });

    it("states the chain of a derived chart in its appendix entry", () => {
        const html = pageOf([chartBlock(DERIVED, DERIVED_HASH)], oneRow, [chain]);
        const entry = load(html)("li#ref-1").text();

        // The entry carries each source with the head of its hash, and the head of the script hash.
        expect(entry).toContain("runs/run-1/step-a/output/de.csv");
        expect(entry).toContain("runs/run-1/step-b/output/counts.csv");
        expect(entry).toContain("a".repeat(12));
        expect(entry).toContain("b".repeat(12));
        expect(entry).toContain("c".repeat(12));
        // A whole hash never reaches the page.
        expect(html).not.toContain("a".repeat(13));
    });

    it("renders a document with no derived path byte-identically with the records and without them", () => {
        const blocks = [tableBlock(PINNED, PINNED_HASH), chartBlock(PINNED, PINNED_HASH)];

        // The chain names a path that no binding of this document holds. Thus the page is a pure function
        // of the document and the values, exactly as it was before the records rode the call.
        expect(pageOf(blocks, oneRow, [chain])).toBe(pageOf(blocks, oneRow));
        expect(load(pageOf(blocks, oneRow))(".report-ref-chain").length).toBe(0);
    });
});

describe("the section scrollspy", () => {
    /** The class that the spy writes. The design source holds the matching rule under the same name. */
    const ACTIVE_CLASS = "report-nav-link-active";

    /** The viewport height of the fake page. The observation box is the top band of this height. */
    const VIEWPORT_HEIGHT = 1000;

    /** One navigation link that records each class name that the script writes. */
    type FakeLink = { getAttribute: () => string; classList: { add: (name: string) => void; remove: (name: string) => void }; classes: Set<string> };

    /** One section that reports a movable top offset, as `getBoundingClientRect` does in a browser. */
    type FakeSection = { id: string; box: { top: number }; getBoundingClientRect: () => { top: number } };

    /**
     * The result of one spy run: the active links, the intersection driver, the section placement, and the
     * observed root margin.
     */
    type SpyRun = { active: () => string[]; intersect: (visible: boolean[]) => void; place: (tops: number[]) => void; rootMargin: string };

    function fakeSection(id: string, top: number): FakeSection {
        const box = { top };
        return { id, box, getBoundingClientRect: () => ({ top: box.top }) };
    }

    function fakeLink(href: string): FakeLink {
        const classes = new Set<string>();
        return {
            getAttribute: () => href,
            classList: {
                add: (name: string) => {
                    classes.add(name);
                },
                remove: (name: string) => {
                    classes.delete(name);
                },
            },
            classes,
        };
    }

    /**
     * Run the emitted spy over fake page globals. The script hands its callback to the fake observer, thus
     * the test drives the intersection directly and no real browser is necessary.
     *
     * The `tops` list places each section in the coordinates of the fake page. The default list puts the
     * first section at the top of the box and each other section one viewport lower.
     */
    function runSpy(ids: string[], hasObserver = true, tops?: number[]): SpyRun {
        const links = ids.map((id) => fakeLink(`#${id}`));
        const sections = ids.map((id, index) => fakeSection(id, tops?.[index] ?? index * VIEWPORT_HEIGHT));
        let callback: ((entries: { target: unknown; isIntersecting: boolean }[]) => void) | undefined;
        let rootMargin = "";
        const doc = {
            readyState: "complete",
            documentElement: { clientHeight: VIEWPORT_HEIGHT },
            querySelectorAll: () => links,
            getElementById: (id: string) => sections[ids.indexOf(id)] ?? null,
            addEventListener: () => undefined,
        };
        const observer = hasObserver
            ? function (cb: (entries: { target: unknown; isIntersecting: boolean }[]) => void, options: { rootMargin: string }) {
                  callback = cb;
                  rootMargin = options.rootMargin;
                  return { observe: () => undefined };
              }
            : undefined;
        new Function("document", "IntersectionObserver", SECTION_SPY)(doc, observer);
        return {
            active: () => links.filter((link) => link.classes.has(ACTIVE_CLASS)).map((link) => link.getAttribute()),
            intersect: (visible: boolean[]) => callback?.(sections.map((target, index) => ({ target, isIntersecting: visible[index] }))),
            place: (next: number[]) => {
                for (let index = 0; index < sections.length; index++) {
                    sections[index].box.top = next[index];
                }
            },
            rootMargin,
        };
    }

    it("marks the section nearest the top and marks no other", () => {
        const run = runSpy(["sec-1", "sec-2", "sec-3"]);
        run.intersect([false, true, true]);
        expect(run.active()).toEqual(["#sec-2"]);
    });

    it("moves the mark when a different section reaches the top", () => {
        const run = runSpy(["sec-1", "sec-2"]);
        run.intersect([false, true]);
        run.intersect([true, true]);
        expect(run.active()).toEqual(["#sec-1"]);
    });

    it("shrinks the observation box to the top band of the viewport", () => {
        const run = runSpy(["sec-1"]);
        run.intersect([true]);
        // The negative bottom margin is what keeps one section in the box at a time.
        expect(run.rootMargin).toMatch(/0px 0px -\d+% 0px/);
    });

    it("marks the first link when every section starts below the box", () => {
        // The page opens at scroll 0, and each section then sits under the box. A capture of that page must
        // still show the reader a position in the report.
        const run = runSpy(["sec-1", "sec-2", "sec-3"], true, [400, 1400, 2400]);
        run.intersect([false, false, false]);
        expect(run.active()).toEqual(["#sec-1"]);
    });

    it("marks the last section above the box when a short tail leaves the box empty", () => {
        // A tail that is shorter than the viewport never lifts the last section into the top band. Without
        // the fallback the link of that section can never take the mark.
        const run = runSpy(["sec-1", "sec-2", "sec-3"], true, [-1200, -800, -400]);
        run.intersect([false, false, false]);
        expect(run.active()).toEqual(["#sec-3"]);
    });

    it("prefers the observed section over the fallback", () => {
        // The fallback holds the mark on the first section here, thus the observed section is the one that
        // proves which reading wins.
        const run = runSpy(["sec-1", "sec-2"], true, [-900, 2000]);
        run.intersect([false, true]);
        expect(run.active()).toEqual(["#sec-2"]);
    });

    it("reads the section positions again on each paint", () => {
        const run = runSpy(["sec-1", "sec-2"], true, [400, 1400]);
        run.intersect([false, false]);
        expect(run.active()).toEqual(["#sec-1"]);

        // A scroll moves each section. A cached position would hold the mark on the first link for the
        // whole page.
        run.place([-1000, 100]);
        run.intersect([false, false]);
        expect(run.active()).toEqual(["#sec-2"]);
    });

    it("reads the end of the box from the margin that the observer takes", () => {
        const run = runSpy(["sec-1"]);
        run.intersect([true]);
        const margin = /-(\d+)% 0px/.exec(run.rootMargin);
        expect(margin).not.toBeNull();
        // The script is browser source text, thus the test reads it as text. The fallback measures the same
        // box that the observer takes, and one constant feeds both. Thus the two readings cannot drift.
        expect(SECTION_SPY).toContain(`(100 - ${margin?.[1]})`);
        expect(SECTION_SPY).toContain("clientHeight");
        expect(SECTION_SPY).toContain("getBoundingClientRect().top <= end");
        expect(SECTION_SPY).toContain("active = nearestAbove()");
    });

    it("keeps the plain links in a browser with no observer", () => {
        const run = runSpy(["sec-1", "sec-2"], false);
        run.intersect([true, false]);
        // The highlight is decoration, thus its absence costs the reader no navigation.
        expect(run.active()).toEqual([]);
    });

    it("rides the page beside the other scripts, with its rule in the design source", () => {
        const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap().html;
        expect(html).toContain(SECTION_SPY);
        expect(DESIGN_CSS).toContain(`.${ACTIVE_CLASS}`);
    });
});

describe("the table grid", () => {
    /** A page with one table of `count` rows and two columns. */
    function tablePage(count: number): { document: ReportDocument; values: RenderValues } {
        const rows = [];
        for (let index = 0; index < count; index += 1) {
            rows.push({ gene: `G${index}`, padj: 0.01 });
        }
        return {
            document: {
                title: "T",
                sections: [
                    {
                        kind: "section",
                        id: "s",
                        title: "S",
                        blocks: [{ kind: "table", id: "tbl", binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:aaa" } }],
                    },
                ],
            },
            values: { tbl: { type: "table", rows } },
        };
    }

    it("references the grid bundle as a classic script from the staged assets", () => {
        const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap().html;

        // A `file://` page refuses a module request, thus the runtime loads as a classic script. The
        // manifest carries the entry, thus the stage step of the caller writes the file that the tag names.
        expect(html).toContain(`<script src="${ASSETS_DIR}/${AG_GRID_ASSET.file}"></script>`);
        expect(PAGE_ASSETS).toContain(AG_GRID_ASSET);
    });

    it("skips the grid runtime and the boot on a page with no table", () => {
        const document: ReportDocument = {
            title: "T",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [
                        {
                            kind: "chart",
                            id: "cht",
                            binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:aaa" },
                            chartType: "bar",
                            encoding: { x: "label", y: "count" },
                        },
                    ],
                },
            ],
        };
        const html = renderReportPage(document, { cht: { type: "table", rows: [{ label: "a", count: 5 }] } })._unsafeUnwrap().html;

        // The bundle weighs about two megabytes, and this page builds no grid. Thus it names neither the
        // runtime nor the boot, and the chart runtime stays.
        expect(html).not.toContain(AG_GRID_ASSET.file);
        expect(html).not.toContain(GRID_BOOTSTRAP);
        expect(html).toContain(`${ASSETS_DIR}/${ECHARTS_ASSET.file}`);
    });

    it("boots after the decode and before the readiness signal", () => {
        const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap().html;

        // The boot reads the decoded rows, thus it runs after the decoder. It runs before the chart
        // bootstrap, which signals readiness, thus a capture of the page shows a page whose grids stand.
        expect(html.indexOf(TABLE_DATA_DECODER)).toBeLessThan(html.indexOf(GRID_BOOTSTRAP));
        expect(html.indexOf(GRID_BOOTSTRAP)).toBeLessThan(html.indexOf(CHART_BOOTSTRAP));
    });

    it("puts one mount and no row on a page of many rows", () => {
        const over = tablePage(14_201);
        const page = load(renderReportPage(over.document, over.values)._unsafeUnwrap().html);

        expect(page(`[${GRID_MOUNT_ATTRIBUTE}]`).length).toBe(1);
        expect(page("tr").length).toBe(0);
        // The card keeps its download, thus the reader takes the raw bytes whatever the script does.
        expect(page("a.report-table-download").length).toBe(1);
    });
});

describe("the grid boot", () => {
    /** One column definition, in the shape that the boot builds. */
    interface FakeColumn {
        colId: string;
        headerName: string;
        headerTooltip?: string;
        filter: string;
        valueGetter: (params: { data?: Record<string, string | number> }) => string | number | undefined;
        filterValueGetter?: (params: { data?: Record<string, string | number> }) => number | null;
        valueFormatter: (params: { value: unknown }) => string;
        tooltipValueGetter: (params: { value: unknown }) => string;
    }

    /** The grid options that the boot passes to `createGrid`. */
    interface FakeOptions {
        theme: unknown;
        columnDefs: FakeColumn[];
        rowData: Record<string, string | number>[];
        defaultColDef: Record<string, unknown>;
        rowModelType?: string;
        onFirstDataRendered?: () => void;
        onModelUpdated?: (params: { api: { getDisplayedRowCount: () => number } }) => void;
    }

    /** One element of the card that the boot writes into: the print note, and the row count of the status. */
    interface FakeText {
        textContent: string;
    }

    /**
     * One mount, in the shape that the boot reads: the block attribute, the inline style, the note beside it,
     * and the descendants that it measures for a scroll bar.
     */
    interface FakeMount {
        style: { height: string };
        getAttribute: (name: string) => string | null;
        querySelector: (selector: string) => FakeStrip | null;
        parentNode: { querySelector: (selector: string) => FakeText | null };
    }

    /** The strip that the grid lays its horizontal bar in, in the shape that the fit reads. */
    interface FakeStrip {
        offsetHeight: number;
    }

    /** One payload, in the shape that the decoder leaves under the block id. */
    function payloadOf(columns: string[], display: unknown[], rows: Record<string, string | number>[]) {
        return { columns, display, rows, dict: {} };
    }

    /**
     * Run the emitted boot over the given payloads, and give back what it built.
     *
     * The script is browser source text. Each global arrives as a parameter, thus these fakes are the whole
     * environment that it drives and no real browser and no real grid are necessary.
     */
    function boot(payloads: Record<string, unknown>, mountIds?: string[], breakOn?: string, strip?: FakeStrip) {
        const created: { id: string; options: FakeOptions }[] = [];
        const grids: { narrowTo: (count: number) => void }[] = [];
        const registered: unknown[][] = [];
        const applied: { option: string; value: unknown }[] = [];
        const listeners: Record<string, (() => void)[]> = {};
        const errors: string[] = [];
        const themeParams: unknown[] = [];
        const notes: FakeText[] = [];
        const counts: FakeText[] = [];
        const mounts: FakeMount[] = (mountIds ?? Object.keys(payloads)).map((id) => {
            const note: FakeText = { textContent: "" };
            const count: FakeText = { textContent: "" };
            notes.push(note);
            counts.push(count);
            const inCard: Record<string, FakeText> = { [`.${GRID_NOTE_CLASS}`]: note, [`.${GRID_COUNT_CLASS}`]: count };
            return {
                style: { height: "" },
                getAttribute: (name: string) => (name === GRID_MOUNT_ATTRIBUTE ? id : null),
                querySelector: (selector: string) => (selector === ".ag-body-horizontal-scroll" ? (strip ?? null) : null),
                parentNode: { querySelector: (selector: string) => inCard[selector] ?? null },
            };
        });
        const agGrid = {
            ModuleRegistry: {
                registerModules: (modules: unknown[]) => {
                    registered.push(modules);
                },
            },
            AllCommunityModule: { moduleName: "community" },
            themeQuartz: {
                withParams: (given: unknown) => {
                    themeParams.push(given);
                    return { params: given };
                },
            },
            createGrid: (mount: FakeMount, options: FakeOptions) => {
                const id = mount.getAttribute(GRID_MOUNT_ATTRIBUTE) ?? "";
                if (id === breakOn) {
                    throw new Error("the grid refused the payload");
                }
                created.push({ id, options });
                // The grid renders its rows after it builds, and it gives the model event with them. The fit
                // of the mount and the status of the card hang on the two calls, thus the fake makes both as
                // the grid does.
                let displayed = options.rowData.length;
                const api = { getDisplayedRowCount: () => displayed };
                options.onFirstDataRendered?.();
                options.onModelUpdated?.({ api });
                const handle = {
                    setGridOption: (option: string, value: unknown) => {
                        applied.push({ option, value });
                    },
                    // The fake stands in for a filter: it narrows the model, then it gives the event again.
                    narrowTo: (count: number) => {
                        displayed = count;
                        options.onModelUpdated?.({ api });
                    },
                };
                grids.push(handle);
                return handle;
            },
        };
        const registry = Object.create(null) as Record<string, unknown>;
        for (const [id, payload] of Object.entries(payloads)) {
            registry[id] = payload;
        }
        const window = {
            [TABLE_DATA_GLOBAL]: registry,
            addEventListener: (name: string, handler: () => void) => {
                listeners[name] = [...(listeners[name] ?? []), handler];
            },
        };
        const document = { querySelectorAll: () => mounts };
        const console = {
            error: (message: string) => {
                errors.push(message);
            },
        };
        new Function("window", "document", "agGrid", "console", GRID_BOOTSTRAP)(window, document, agGrid, console);
        return {
            created,
            grids,
            registered,
            applied,
            errors,
            mounts,
            notes,
            counts,
            themeParams,
            fire: (name: string) => {
                for (const handler of listeners[name] ?? []) {
                    handler();
                }
            },
        };
    }

    /** One table of two columns: a gene name and an adjusted p-value. */
    function genePayload(rowCount = 3) {
        const rows = [];
        for (let index = 0; index < rowCount; index += 1) {
            rows.push({ gene: `G${index}`, padj: 0.0001 });
        }
        return payloadOf(
            ["gene", "padj"],
            [
                { label: "gene", kind: "compact-scientific", filter: "text" },
                { label: "Adjusted p-value", kind: "scientific", filter: "number", bound: 0.0001 },
            ],
            rows,
        );
    }

    it("builds one grid for each mount, over the decoded rows of its block", () => {
        const run = boot({ one: genePayload(2), two: genePayload(5) });

        expect(run.created.map((grid) => grid.id)).toEqual(["one", "two"]);
        expect(run.created[1].options.rowData.length).toBe(5);
        // The client-side row model is the default, and it renders the visible slice alone. A page that
        // named another model would ask the page for rows that no page can give.
        expect(run.created[0].options.rowModelType).toBeUndefined();
    });

    it("registers the community modules before it builds a grid", () => {
        const run = boot({ one: genePayload() });

        expect(run.registered.length).toBe(1);
        expect(run.registered[0].length).toBe(1);
    });

    it("names each column from the display and reads the own key of the row", () => {
        const payload = payloadOf(["p.value"], [{ label: "p value", kind: "scientific", filter: "number" }], [{ "p.value": 0.5 }]);
        const column = boot({ one: payload }).created[0].options.columnDefs[0];

        expect(column.colId).toBe("p.value");
        expect(column.headerName).toBe("p value");
        // A field reads a point as a path into the row. The getter reads the key itself, thus a column
        // such as `p.value` reaches its own cells.
        expect(column.valueGetter({ data: { "p.value": 0.5 } })).toBe(0.5);
        expect(column.valueGetter({})).toBeUndefined();
    });

    it("puts the raw column name on the header hover where the label differs from it", () => {
        const columns = boot({ one: genePayload() }).created[0].options.columnDefs;

        expect(columns[1].headerTooltip).toBe("padj");
        // A hover that repeats the header text tells a reader nothing, thus a plain header carries none.
        expect(columns[0].headerTooltip).toBeUndefined();
    });

    it("formats each cell under the kind of its column, as the server does", () => {
        const columns = boot({ one: genePayload() }).created[0].options.columnDefs;

        expect(columns[1].valueFormatter({ value: 0.0000427777663038 })).toBe(formatTableCell(0.0000427777663038, "scientific"));
        expect(columns[1].valueFormatter({ value: 0.0000427777663038 })).toBe("4.3e-5");
        // The bound of the column rides the display, thus a stored zero reads as a bound and never as a result.
        expect(columns[1].valueFormatter({ value: 0 })).toBe("<1e-4");
        expect(columns[0].valueFormatter({ value: 14201 })).toBe("14,201");
        expect(columns[0].valueFormatter({ value: undefined })).toBe("");
    });

    it("puts the raw value on the tooltip of a cell that the format changed", () => {
        const columns = boot({ one: genePayload() }).created[0].options.columnDefs;

        expect(columns[1].tooltipValueGetter({ value: 0.0000427777663038 })).toBe("0.0000427777663038");
        expect(columns[1].tooltipValueGetter({ value: 0 })).toBe("0");
        // A cell whose shown text is its own raw text carries no tooltip.
        expect(columns[0].tooltipValueGetter({ value: "up" })).toBe("");
        expect(columns[0].tooltipValueGetter({ value: undefined })).toBe("");
    });

    it("trims a delimited name in the cell and keeps the whole name on the tooltip", () => {
        const name = "HALLMARK_HYPOXIA%MSigDB%M5891";
        const payload = payloadOf(["set"], [{ label: "set", kind: "compact-scientific", filter: "text" }], [{ set: name }]);
        const column = boot({ one: payload }).created[0].options.columnDefs[0];

        expect(column.valueFormatter({ value: name })).toBe("HALLMARK_HYPOXIA");
        expect(column.tooltipValueGetter({ value: name })).toBe(name);
    });

    it("takes the filter of each column from the display", () => {
        const columns = boot({ one: genePayload() }).created[0].options.columnDefs;

        // A gene column holds names. A reader filters it by name, thus the number filter would leave the
        // column unfilterable.
        expect(columns[0].filter).toBe("agTextColumnFilter");
        expect(columns[1].filter).toBe("agNumberColumnFilter");
    });

    it("parses the cell for a number filter, thus a column of numeric text compares as a number", () => {
        const payload = payloadOf(
            ["pmid", "gene"],
            [
                { label: "pmid", kind: "identifier", filter: "number" },
                { label: "gene", kind: "compact-scientific", filter: "text" },
            ],
            [{ pmid: "31978945", gene: "TP53" }],
        );
        const columns = boot({ one: payload }).created[0].options.columnDefs;

        expect(columns[0].filterValueGetter?.({ data: { pmid: "31978945" } })).toBe(31978945);
        // A cell that parses to no number matches no comparison of the filter.
        expect(columns[0].filterValueGetter?.({ data: { pmid: "NA" } })).toBeNull();
        expect(columns[0].filterValueGetter?.({})).toBeNull();
        // A text column filters on the value itself, thus it carries no parse.
        expect(columns[1].filterValueGetter).toBeUndefined();
    });

    it("sorts from the header and fits each column to the width of the grid", () => {
        const defaults = boot({ one: genePayload() }).created[0].options.defaultColDef;

        // The per-column filters and the header sort are the one filter surface of a table.
        expect(defaults.sortable).toBe(true);
        expect(defaults.flex).toBe(1);
        expect(defaults.minWidth).toBe(GRID_MIN_COLUMN_WIDTH_PX);
    });

    it("builds the theme from the design tokens", () => {
        const run = boot({ one: genePayload() });

        expect(run.themeParams).toEqual([GRID_THEME_PARAMS]);
        expect(run.created[0].options.theme).toEqual({ params: GRID_THEME_PARAMS });
    });

    it("sizes the mount from the row count, up to the visible bound", () => {
        const short = boot({ one: genePayload(3) });
        expect(short.mounts[0].style.height).toBe(`${GRID_HEADER_HEIGHT_PX + GRID_HEADER_BORDER_PX + 3 * GRID_ROW_HEIGHT_PX}px`);

        const long = boot({ one: genePayload(GRID_VISIBLE_ROWS + 40) });
        // A long table scrolls inside its own viewport, thus the card never grows with the row count.
        expect(long.mounts[0].style.height).toBe(`${GRID_HEADER_HEIGHT_PX + GRID_HEADER_BORDER_PX + GRID_VISIBLE_ROWS * GRID_ROW_HEIGHT_PX}px`);
    });

    it("adds the horizontal scroll bar of a wide table to the mount, thus the bar covers no row", () => {
        const rowSpace = GRID_HEADER_HEIGHT_PX + GRID_HEADER_BORDER_PX + 3 * GRID_ROW_HEIGHT_PX;

        // A wide table scrolls sideways, and the grid takes the height of that bar out of the row space.
        const wide = boot({ one: genePayload(3) }, undefined, undefined, { offsetHeight: 15 });
        expect(wide.mounts[0].style.height).toBe(`${rowSpace + 15}px`);

        // An overlay bar lies over the rows and leaves the strip at zero, thus the mount keeps its height.
        const overlay = boot({ one: genePayload(3) }, undefined, undefined, { offsetHeight: 0 });
        expect(overlay.mounts[0].style.height).toBe(`${rowSpace}px`);

        // A table that fits carries no strip at all.
        expect(boot({ one: genePayload(3) }).mounts[0].style.height).toBe(`${rowSpace}px`);
    });

    it("takes the print layout of the grid on a print and gives it back after one", () => {
        const run = boot({ one: genePayload(3) });
        const height = run.mounts[0].style.height;

        run.fire("beforeprint");
        // The print layout lays every row out at once and it holds no scroll viewport, thus each row of the
        // print form reaches the paper. A table under the print bound prints whole and carries no note.
        expect(run.applied).toEqual([{ option: "domLayout", value: "print" }]);
        expect(run.mounts[0].style.height).toBe("auto");
        expect(run.notes[0].textContent).toBe("");

        run.fire("afterprint");
        expect(run.applied[1]).toEqual({ option: "domLayout", value: "normal" });
        expect(run.mounts[0].style.height).toBe(height);
    });

    it("bounds the print form of a long table and states the truncation on the card", () => {
        const total = GRID_PRINT_ROW_CAP + 201;
        const run = boot({ one: genePayload(total) });

        run.fire("beforeprint");
        const printed = run.applied[0] as { option: string; value: Record<string, string | number>[] };
        // The print layout builds every row that it holds. An unbounded table would take hundreds of pages,
        // thus the print stops at the bound and the note names what the paper leaves out.
        expect(printed.option).toBe("rowData");
        expect(printed.value.length).toBe(GRID_PRINT_ROW_CAP);
        expect(run.applied[1]).toEqual({ option: "domLayout", value: "print" });
        expect(run.notes[0].textContent).toBe("The print shows the first 1,000 of 1,201 rows. The full table rides the download.");

        run.fire("afterprint");
        expect(run.applied[2]).toEqual({ option: "domLayout", value: "normal" });
        expect((run.applied[3] as { option: string; value: unknown[] }).value.length).toBe(total);
        // The screen shows no note, thus the line lives for the print alone.
        expect(run.notes[0].textContent).toBe("");
    });

    it("states the row count of the table on the card, and the shown count under a filter", () => {
        const run = boot({ one: genePayload(1201) });

        // The model event arrives with the rows, thus the card states the whole count before any filter.
        expect(run.counts[0].textContent).toBe("1,201 rows");

        run.grids[0].narrowTo(132);
        // A filter narrows the model. The status then reads what the grid shows against what it holds.
        expect(run.counts[0].textContent).toBe("132 of 1,201 rows");

        run.grids[0].narrowTo(1201);
        expect(run.counts[0].textContent).toBe("1,201 rows");
    });

    it("states the shown count against the pre-bound total of the artifact", () => {
        const bounded = { ...genePayload(10), total: 14201 };
        const run = boot({ one: bounded });

        // The rows of the card are the bound of the binding, and the total is the artifact. Thus the footer
        // never reads a cut table as the whole artifact.
        expect(run.counts[0].textContent).toBe("10 of 14,201 rows");

        run.grids[0].narrowTo(3);
        expect(run.counts[0].textContent).toBe("3 of 14,201 rows");
    });

    it("skips a mount whose block the registry does not hold, and it throws nothing", () => {
        const run = boot({ one: genePayload() }, ["one", "absent"]);

        expect(run.created.map((grid) => grid.id)).toEqual(["one"]);
        expect(run.errors).toEqual([]);
        // The mount of the absent block takes no height, thus its card shows its title and its download alone.
        expect(run.mounts[1].style.height).toBe("");
    });

    it("skips a payload that carries no display, and it throws nothing", () => {
        const run = boot({ one: { columns: ["gene"], rows: [{ gene: "TP53" }], dict: {} } });

        expect(run.created).toEqual([]);
        expect(run.errors).toEqual([]);
    });

    it("keeps a sibling grid when one grid refuses its payload", () => {
        const run = boot({ bad: genePayload(), good: genePayload() }, ["bad", "good"], "bad");

        // A malformed payload is the fault that a look must diagnose. It must never stop a sibling grid.
        expect(run.created.map((grid) => grid.id)).toEqual(["good"]);
        expect(run.errors.length).toBe(1);
        expect(run.errors[0]).toContain("bad");
    });
});

describe("the retired table enhancer", () => {
    it("carries no marker, no filter input, and no cap class on a rendered page", () => {
        const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap().html;

        // The grid owns the table presentation, thus the page holds one table mechanism and no second one.
        for (const retired of ["report-table-live", "report-table-filter", "report-table-controls", "report-table-toggle", "report-row-hidden"]) {
            expect(html).not.toContain(retired);
        }
    });

    it("holds no rule and no markup of the plain table", () => {
        const rendered = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap();
        const page = load(rendered.html);

        // The grid renders each cell, thus the page carries one mount for each table and no table markup.
        expect(page(`[${GRID_MOUNT_ATTRIBUTE}]`).length).toBeGreaterThan(0);
        expect(page("td").length).toBe(0);
        expect(page("table").length).toBe(0);
        for (const rule of [".report-table-live", ".report-table-filter", ".report-table-toggle", ".report-row", ".data-table-sort"]) {
            expect(DESIGN_CSS).not.toContain(rule);
        }
    });
});

describe("renderReportPage readiness signal", () => {
    it("carries the theme-ready dispatch and the sentinel in the page markup", () => {
        const html = renderReportPage(FIXTURE_DOCUMENT, FIXTURE_VALUES)._unsafeUnwrap().html;
        // The bootstrap signals readiness when it completes, thus a capture keys on a real event and returns
        // when the page is ready instead of at a timeout.
        expect(html).toContain("window.__inflexaThemeReady = true");
        expect(html).toContain('document.dispatchEvent(new Event("inflexa-theme-ready"))');
    });
});

describe("the chart bootstrap under a broken chart", () => {
    /** One chart container beside its option script, the pair that the bootstrap walks. */
    function fakeContainer(id: string): unknown {
        return {
            getAttribute: () => id,
            nextElementSibling: { getAttribute: () => "application/json", textContent: "{}" },
        };
    }

    /**
     * Run the emitted bootstrap over fake page globals. Each global arrives as a parameter, thus the script
     * reads the fakes and no real browser is necessary.
     */
    function runBootstrap(containers: unknown[], init: (container: unknown) => unknown): { ready: boolean; errors: string[] } {
        const errors: string[] = [];
        const win: Record<string, unknown> = { addEventListener: () => undefined };
        const doc = {
            querySelectorAll: () => containers,
            dispatchEvent: () => true,
            addEventListener: () => undefined,
        };
        const echarts = { init, getInstanceByDom: () => undefined };
        const pageConsole = { error: (line: string) => errors.push(line) };
        // The bootstrap is browser source text. Each global arrives as a parameter, thus the fake console
        // of the page is the one that the script writes to.
        new Function("window", "document", "echarts", "console", CHART_BOOTSTRAP)(win, doc, echarts, pageConsole);
        return { ready: win.__inflexaThemeReady === true, errors };
    }

    it("signals readiness and initializes the later chart when one chart throws", () => {
        const good: string[] = [];
        const { ready, errors } = runBootstrap([fakeContainer("bad"), fakeContainer("good")], (container) => {
            if ((container as { getAttribute: () => string }).getAttribute() === "bad") {
                throw new Error("bad option");
            }
            good.push("init");
            return { setOption: () => undefined };
        });

        // The readiness signal still fires, thus a capture returns on the event and not at its timeout.
        expect(ready).toBe(true);
        // The later chart still initializes, thus one broken chart costs one chart.
        expect(good).toEqual(["init"]);
        // The fault reaches the console, thus the capture reads it and the agent repairs that one chart.
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain("bad");
        expect(errors[0]).toContain("bad option");
    });
});

describe("renderReportPage number format", () => {
    /** A one-section page over one metric block and one table block. */
    function pageOf(blocks: Block[]): ReportDocument {
        return { title: "T", sections: [{ kind: "section", id: "s", title: "S", blocks }] };
    }

    it("shows a long metric value in the short form and the full digits on the title", () => {
        const document = pageOf([{ kind: "metric", id: "m1", label: "Effect size", value: scalarRef }]);
        const html = renderReportPage(document, { m1: { type: "scalar", value: -5.7618623255 } })._unsafeUnwrap().html;
        const value = load(html)(".stat-card-value");
        // The card signs the value with the typographic minus, and the raw text stays on the title.
        expect(value.text()).toBe("−5.76");
        expect(value.attr("title")).toBe("-5.7618623255");
    });

    it("gives a metric whose form hides no digit no title attribute", () => {
        const document = pageOf([{ kind: "metric", id: "m1", label: "Genes tested", value: scalarRef }]);
        const html = renderReportPage(document, { m1: { type: "scalar", value: 18432 } })._unsafeUnwrap().html;
        const value = load(html)(".stat-card-value");
        expect(value.text()).toBe("18,432");
        expect(value.attr("title")).toBeUndefined();
    });

    it("carries each raw table cell into the payload and formats none of them", () => {
        const document = pageOf([{ kind: "table", id: "tbl", binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:aaa" } }]);
        const values: RenderValues = {
            tbl: {
                type: "table",
                columns: ["gene", "log2FoldChange", "padj", "direction"],
                rows: [{ gene: "TP53", log2FoldChange: -3.089028528355109, padj: 0.0000427777663038, direction: "up" }],
            },
        };
        const rendered = renderReportPage(document, values)._unsafeUnwrap();
        const window: Record<string, unknown> = {};
        new Function("window", rendered.dataAssets[0].bytes)(window);
        const registry = window[TABLE_DATA_GLOBAL] as Record<string, { rows: unknown[] }>;

        // The number format is presentation, and the payload is data. A rounded value in the asset would
        // put a shown form where a magnitude belongs.
        expect(registry["tbl"].rows[0]).toEqual(["TP53", -3.089028528355109, 0.0000427777663038, "up"]);
        expect(load(rendered.html)(".data-table tbody td").length).toBe(0);
    });
});

describe("the stat card value style rule", () => {
    /** The declaration body of each `.stat-card-value` rule of a style sheet, with each comment removed. */
    function statValueRules(css: string): string[] {
        return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/\.stat-card-value\s*\{([^}]*)\}/g)].map((match) => match[1]);
    }

    it("guards the overflow of the value", () => {
        const rules = statValueRules(DESIGN_CSS);
        expect(rules.length).toBeGreaterThan(0);

        // A value that the number format cannot shorten, for example a long identifier, would paint past
        // the card edge without the guard.
        expect(rules.some((body) => /(?:^|;)\s*overflow-wrap\s*:\s*anywhere\b/.test(body))).toBe(true);
    });
});

describe("renderReportPage escaping", () => {
    it("keeps a script tag in the title as text in the title and the heading", () => {
        const document: ReportDocument = {
            title: "Report <script>alert(1)</script>",
            sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "text", id: "t", content: { prose: "x" } }] }],
        };
        const html = renderReportPage(document, {})._unsafeUnwrap().html;
        expect(html).toContain("<title>Report &lt;script&gt;alert(1)&lt;/script&gt;</title>");
        // The heading content holds the escaped form between its open and close tags.
        expect(html).toContain(">Report &lt;script&gt;alert(1)&lt;/script&gt;<");
        // The hostile tag never reaches the page as a live element.
        expect(html).not.toContain("<script>alert(1)");
    });
});

describe("the shared chart payload", () => {
    const CHART_PATH = "runs/run-1/step-a/output/de.csv";
    const CHART_HASH = `sha256:${"b".repeat(64)}`;
    const COLUMNS = ["gene", "log2fc", "padj", "arm"];

    /** The binding that every block of this suite pins. */
    const binding: TableBlock["binding"] = { kind: "artifact-table", path: CHART_PATH, hash: CHART_HASH };

    /** A differential-expression table of `count` rows: a name, an effect, a p-value, and one of two arms. */
    function denseRows(count: number): Record<string, string | number>[] {
        const rows = [];
        for (let index = 0; index < count; index += 1) {
            rows.push({ gene: `G${index}`, log2fc: (index % 400) / 100 - 2, padj: (index + 1) / (count * 10), arm: index % 3 === 0 ? "a" : "b" });
        }
        return rows;
    }

    /** The volcano block of the bound table, with a name on each point. */
    function volcanoBlock(id = "cht"): ChartBlock {
        return { kind: "chart", id, binding, chartType: "volcano", encoding: { x: "log2fc", y: "padj", label: "gene" } };
    }

    /** One page over the given blocks, with the same dense table under each block id. */
    function pageOf(blocks: Block[], count = 6000): { document: ReportDocument; values: RenderValues; rows: Record<string, string | number>[] } {
        const rows = denseRows(count);
        const values: RenderValues = {};
        for (const block of blocks) {
            values[block.id] = { type: "table", columns: COLUMNS, rows };
        }
        return { document: { title: "T", sections: [{ kind: "section", id: "s", title: "S", blocks }] }, values, rows };
    }

    /** The registry that the page holds after the assets and the decoder run. */
    function registryOf(assets: readonly { bytes: string }[]): Record<string, { rows: Record<string, string | number>[]; total: number }> {
        const window: Record<string, unknown> = {};
        for (const asset of assets) {
            new Function("window", asset.bytes)(window);
        }
        new Function("window", TABLE_DATA_DECODER)(window);
        return window[TABLE_DATA_GLOBAL] as Record<string, { rows: Record<string, string | number>[]; total: number }>;
    }

    it("holds one payload for one artifact, and a table and a chart both read it", () => {
        const table: TableBlock = { kind: "table", id: "tbl", binding };
        const page = pageOf([table, volcanoBlock()]);
        const rendered = renderReportPage(page.document, page.values)._unsafeUnwrap();

        expect(rendered.dataAssets.length).toBe(1);
        const registry = registryOf(rendered.dataAssets);
        // One asset registers the rows one time. The second id takes the same object, thus the page carries
        // one copy of the table and each block finds it under its own id.
        expect(Object.keys(registry).sort()).toEqual(["cht", "tbl"]);
        expect(registry["cht"]).toBe(registry["tbl"]);

        // The table encoded the payload, and the chart reads it under its own id. Thus the shared payload
        // plots the chart, and the grid of the table reads the same rows.
        const json = load(rendered.html)("script[type='application/json']").text();
        const built = bootChart(rendered.dataAssets, json);
        expect(built.map((series) => series.data.length).reduce((sum, count) => sum + count, 0)).toBe(page.rows.length);
    });

    it("builds the series of a dense chart on the page, exactly as the inline derivation does", () => {
        const page = pageOf([volcanoBlock()]);
        const rendered = renderReportPage(page.document, page.values)._unsafeUnwrap();
        const json = load(rendered.html)("script[type='application/json']").text();

        // The option holds no row, thus the whole chart costs the page one small element.
        expect(json.length).toBeLessThan(CHART_INLINE_OPTION_BOUND);
        expect(json).not.toContain("G4001");

        const built = bootChart(rendered.dataAssets, json);
        const inline = deriveChartOption(volcanoBlock(), page.rows, COLUMNS)._unsafeUnwrap();
        // The page reads the payload and rebuilds each series. The two forms are the same chart, thus the
        // data of the page and the data of the inline derivation match cell for cell.
        expect(JSON.stringify(built.map((series) => series.data))).toBe(JSON.stringify(asSeries(inline).map((series) => series.data)));
    });

    it("gives byte-identical assets and one page over two renders", () => {
        const page = pageOf([volcanoBlock()]);
        const first = renderReportPage(page.document, page.values)._unsafeUnwrap();
        const second = renderReportPage(page.document, page.values)._unsafeUnwrap();

        expect(second.dataAssets).toEqual(first.dataAssets);
        expect(second.html).toBe(first.html);
    });

    it("skips the grid runtime and the grid boot on a page whose payload feeds a chart alone", () => {
        const page = pageOf([volcanoBlock()]);
        const rendered = renderReportPage(page.document, page.values)._unsafeUnwrap();

        // The grid bundle weighs about two megabytes, and this page builds no grid. The decoder still rides,
        // because the chart reads the decoded rows.
        expect(rendered.dataAssets.length).toBe(1);
        expect(rendered.html).not.toContain(AG_GRID_ASSET.file);
        expect(rendered.html).not.toContain(GRID_BOOTSTRAP);
        expect(rendered.html).toContain(TABLE_DATA_DECODER);
    });

    it("leaves a chart under the bound with its own rows and registers no payload", () => {
        const page = pageOf([volcanoBlock()], 20);
        const rendered = renderReportPage(page.document, page.values)._unsafeUnwrap();

        expect(rendered.dataAssets).toEqual([]);
        const json = load(rendered.html)("script[type='application/json']").text();
        expect(json).toContain("G19");
        expect(json).not.toContain(CHART_SOURCE_MEMBER);
    });

    it("keeps two payloads for two bindings of one path, because they resolve different rows", () => {
        const bounded: TableBlock = { kind: "table", id: "tbl", binding: { ...binding, rowBound: { column: "padj", count: 20, order: "asc" } } };
        const page = pageOf([bounded, volcanoBlock()]);
        const rendered = renderReportPage(page.document, page.values)._unsafeUnwrap();

        // The bound is part of the binding. Two bindings that differ in it name two row sets, thus one
        // payload for both would ship the rows of one block under the id of the other.
        expect(rendered.dataAssets.length).toBe(2);
    });

    /** The series that the chart bootstrap sets, over the payloads of the page and one option JSON. */
    function bootChart(assets: readonly { bytes: string }[], json: string): { data: unknown[] }[] {
        const win: Record<string, unknown> = { addEventListener: () => undefined };
        for (const asset of assets) {
            new Function("window", asset.bytes)(win);
        }
        new Function("window", TABLE_DATA_DECODER)(win);

        const applied: Record<string, unknown>[] = [];
        const container = { getAttribute: () => "cht", nextElementSibling: { getAttribute: () => "application/json", textContent: json } };
        const doc = { querySelectorAll: () => [container], dispatchEvent: () => true, addEventListener: () => undefined };
        const echarts = {
            init: () => ({
                setOption: (given: Record<string, unknown>) => {
                    applied.push(given);
                },
            }),
            getInstanceByDom: () => undefined,
        };
        const errors: string[] = [];
        new Function("window", "document", "echarts", "console", CHART_BOOTSTRAP)(win, doc, echarts, { error: (line: string) => errors.push(line) });
        expect(errors).toEqual([]);
        expect(applied.length).toBe(1);
        // The member of the data source leaves the option before the chart runtime reads it.
        expect(applied[0][CHART_SOURCE_MEMBER]).toBeUndefined();
        return asSeries(applied[0]);
    }

    /** The series list of one option. */
    function asSeries(option: Record<string, unknown>): { data: unknown[] }[] {
        return (option.series ?? []) as { data: unknown[] }[];
    }
});

describe("the pre-bound total of a table", () => {
    const binding: TableBlock["binding"] = { kind: "artifact-table", path: "runs/r1/de.csv", hash: "sha256:aaa", rowBound: { column: "padj", count: 10 } };

    /** One page of one bounded table block over ten rows of a much larger artifact. */
    function boundedPage(): { document: ReportDocument; values: RenderValues } {
        const rows = [];
        for (let index = 0; index < 10; index += 1) {
            rows.push({ gene: `G${index}`, padj: index / 1000 });
        }
        return {
            document: { title: "T", sections: [{ kind: "section", id: "s", title: "S", blocks: [{ kind: "table", id: "tbl", binding }] }] },
            values: { tbl: { type: "table", columns: ["gene", "padj"], rows, total: 14201 } },
        };
    }

    it("states the shown count against the total in the card footer, with the bound beside it", () => {
        const page = boundedPage();
        const card = load(renderReportPage(page.document, page.values)._unsafeUnwrap().html);

        expect(card(`.${GRID_COUNT_CLASS}`).text()).toBe("10 of 14,201 rows");
        expect(card(".report-table-bound").text()).toBe("top 10 by padj");
    });

    it("carries the total on the payload, thus the page states it after a filter", () => {
        const page = boundedPage();
        const rendered = renderReportPage(page.document, page.values)._unsafeUnwrap();
        const window: Record<string, unknown> = {};
        new Function("window", rendered.dataAssets[0].bytes)(window);

        const registry = window[TABLE_DATA_GLOBAL] as Record<string, { total: number; rows: unknown[] }>;
        expect(registry["tbl"].total).toBe(14201);
        expect(registry["tbl"].rows.length).toBe(10);
    });

    it("takes the row count as the total for a table that no bound cut", () => {
        const document: ReportDocument = {
            title: "T",
            sections: [
                {
                    kind: "section",
                    id: "s",
                    title: "S",
                    blocks: [{ kind: "table", id: "tbl", binding: { kind: "artifact-table", path: "t.csv", hash: "sha256:aaa" } }],
                },
            ],
        };
        const values: RenderValues = { tbl: { type: "table", columns: ["gene"], rows: [{ gene: "TP53" }, { gene: "MYC" }] } };
        const rendered = renderReportPage(document, values)._unsafeUnwrap();
        const window: Record<string, unknown> = {};
        new Function("window", rendered.dataAssets[0].bytes)(window);

        // A whole table shows every row that it holds, thus the footer states the one count.
        expect(load(rendered.html)(`.${GRID_COUNT_CLASS}`).text()).toBe("2 rows");
        expect((window[TABLE_DATA_GLOBAL] as Record<string, { total: number }>)["tbl"].total).toBe(2);
    });
});
