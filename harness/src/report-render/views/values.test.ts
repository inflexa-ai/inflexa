import { describe, expect, it } from "bun:test";

import type { CitationBlock, FigureBlock, MetricBlock, TableBlock } from "../../contracts/report-blocks.js";
import type { ScalarReference } from "../../contracts/report-reference.js";
import { renderCitation, renderFigure, renderMetric, renderTable } from "./values.js";
import { ReferenceLedger } from "../references.js";

const scalarBinding: ScalarReference = { kind: "artifact-value", path: "runs/r1/de.csv", hash: "sha256:aaa", locator: { column: "padj", row: 0 } };
const tableBinding: TableBlock["binding"] = { kind: "artifact-table", path: "runs/r1/de.csv", hash: "sha256:aaa" };
const figureBinding: FigureBlock["binding"] = { kind: "artifact-file", path: "runs/r1/plot.png", hash: "sha256:aaa" };

describe("renderMetric", () => {
    it("shows the label and the scalar value", () => {
        const block: MetricBlock = { kind: "metric", id: "m1", label: "Adjusted p-value", value: scalarBinding };
        const html = renderMetric(block, { type: "scalar", value: 0.0123 });
        expect(html).toContain("Adjusted p-value");
        expect(html).toContain("0.0123");
    });
});

describe("renderTable", () => {
    const block: TableBlock = { kind: "table", id: "tb1", binding: tableBinding };

    it("renders one header cell for each column and one row for each resolved row", () => {
        const html = renderTable(block, {
            type: "table",
            rows: [
                { gene: "TP53", padj: 0.01 },
                { gene: "MYC", padj: 0.02 },
                { gene: "EGFR", padj: 0.03 },
            ],
        });
        expect(html.split("<th ").length - 1).toBe(2);
        expect(html.split(`<tr class="report-row`).length - 1).toBe(3);
        expect(html).toContain("TP53");
    });

    it("renders the header alone for a zero-row table with named columns", () => {
        const html = renderTable(block, { type: "table", rows: [], columns: ["gene", "padj"] });
        expect(html.split("<th ").length - 1).toBe(2);
        expect(html).not.toContain(`<tr class="report-row`);
    });

    it("renders an absent cell as an empty cell", () => {
        const html = renderTable(block, {
            type: "table",
            rows: [{ gene: "TP53", padj: 0.01 }, { gene: "MYC" }],
            columns: ["gene", "padj"],
        });
        expect(html).toContain(`<td class="px-4 py-2.5 text-slate-700"></td>`);
        expect(html).not.toContain("undefined");
    });
});

describe("renderFigure", () => {
    it("puts the source in the src attribute and the caption below", () => {
        const block: FigureBlock = { kind: "figure", id: "f1", binding: figureBinding, caption: "Volcano plot" };
        const html = renderFigure(block, { type: "figure", src: "data:image/png;base64,AAAA" });
        expect(html).toContain(`src="data:image/png;base64,AAAA"`);
        expect(html).toContain("Volcano plot");
    });

    it("keeps a quote in the caption as text and inside the alt attribute", () => {
        const block: FigureBlock = { kind: "figure", id: "f2", binding: figureBinding, caption: 'a "quoted" caption' };
        const html = renderFigure(block, { type: "figure", src: "plot.png" });
        // The runtime escapes each child, thus the figcaption content holds the escaped quote.
        expect(html).toContain("a &quot;quoted&quot; caption");
        // The alt attribute escapes the quote, thus the quote cannot break the attribute.
        expect(html).toContain(`alt="a &quot;quoted&quot; caption"`);
    });

    it("keeps a quote in the source inside the src attribute", () => {
        const block: FigureBlock = { kind: "figure", id: "f3", binding: figureBinding, caption: "c" };
        const html = renderFigure(block, { type: "figure", src: 'x" onerror="alert(1)' });
        expect(html).toContain(`src="x&quot; onerror=&quot;alert(1)"`);
        // The broken-out form with raw quotes is absent.
        expect(html).not.toContain(`onerror="alert(1)"`);
    });
});

describe("renderCitation", () => {
    it("renders the marker and the optional note", () => {
        const block: CitationBlock = {
            kind: "citation",
            id: "cit1",
            binding: { kind: "citation", idKind: "pmid", id: "12345", raw: "Doe 2020" },
            note: "see figure 2",
        };
        const html = renderCitation(block, new ReferenceLedger());
        expect(html).toContain(`href="#ref-1"`);
        expect(html).toContain("see figure 2");
    });
});
