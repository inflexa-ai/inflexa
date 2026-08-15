import { describe, expect, it } from "bun:test";

import type { CitationBlock, FigureBlock, MetricBlock, TableBlock } from "../../contracts/report-blocks.js";
import type { ScalarReference } from "../../contracts/report-reference.js";
import { renderCitation, renderFigure, renderMetric, renderTable, TABLE_ROW_CAP } from "./values.js";
import { ReferenceLedger } from "../references.js";

const scalarBinding: ScalarReference = { kind: "artifact-value", path: "runs/r1/de.csv", hash: "sha256:aaa", locator: { column: "padj", row: 0 } };
const tableBinding: TableBlock["binding"] = { kind: "artifact-table", path: "runs/r1/de.csv", hash: "sha256:aaa" };
const figureBinding: FigureBlock["binding"] = { kind: "artifact-file", path: "runs/r1/plot.png", hash: "sha256:aaa" };

describe("renderMetric", () => {
    /** One metric block with the given label. The label selects the number kind of the value. */
    function metric(label: string): MetricBlock {
        return { kind: "metric", id: "m1", label, value: scalarBinding };
    }

    it("shows the label and the scalar value", () => {
        const html = renderMetric(metric("Adjusted p-value"), { type: "scalar", value: 0.0123 });
        expect(html).toContain("Adjusted p-value");
        // A p-value from one hundredth up reads better as a plain decimal than as an exponent.
        expect(html).toContain(">0.0123<");
    });

    it("puts the full digits in the title attribute of the value", () => {
        const html = renderMetric(metric("Effect size"), { type: "scalar", value: -5.7618623255 });
        expect(html).toContain(`<div class="stat-card-value" title="-5.7618623255">-5.76</div>`);
    });

    it("shows a p-value label in the scientific form with the full digits on the title", () => {
        const html = renderMetric(metric("padj"), { type: "scalar", value: 0.0000427777663038 });
        expect(html).toContain(`title="0.0000427777663038"`);
        expect(html).toContain(">4.3e-5<");
    });

    it("groups a count and carries no title, because the grouping hides no digit", () => {
        const html = renderMetric(metric("Genes tested"), { type: "scalar", value: 18432 });
        expect(html).toContain(`<div class="stat-card-value">18,432</div>`);
        expect(html).not.toContain("title=");
    });

    it("passes a non-numeric value through with no title", () => {
        const html = renderMetric(metric("Sequencing depth"), { type: "scalar", value: "42.6M" });
        expect(html).toContain(`<div class="stat-card-value">42.6M</div>`);
        expect(html).not.toContain("title=");
    });
});

describe("renderTable", () => {
    const block: TableBlock = { kind: "table", id: "tb1", binding: tableBinding };

    /** One table value of `count` rows. The gene column numbers each row, thus a sorted order is readable. */
    function rowsOf(count: number) {
        const rows = [];
        for (let index = 0; index < count; index += 1) {
            rows.push({ gene: `G${index}`, padj: 0.01 });
        }
        return { type: "table", rows } as const;
    }

    it("renders one header cell for each column and one row for each resolved row", () => {
        const html = renderTable(block, {
            type: "table",
            rows: [
                { gene: "TP53", padj: 0.01 },
                { gene: "MYC", padj: 0.02 },
                { gene: "EGFR", padj: 0.03 },
            ],
        });
        expect(html.split(`<th class="data-table-sort"`).length - 1).toBe(2);
        expect(html.split(`<tr class="report-row`).length - 1).toBe(3);
        expect(html).toContain("TP53");
    });

    it("renders the header alone for a zero-row table with named columns", () => {
        const html = renderTable(block, { type: "table", rows: [], columns: ["gene", "padj"] });
        expect(html.split(`<th class="data-table-sort"`).length - 1).toBe(2);
        expect(html).not.toContain(`<tr class="report-row`);
    });

    it("renders an absent cell as an empty cell", () => {
        const html = renderTable(block, {
            type: "table",
            rows: [{ gene: "TP53", padj: 0.01 }, { gene: "MYC" }],
            columns: ["gene", "padj"],
        });
        expect(html).toContain(`<td data-value=""></td>`);
        expect(html).not.toContain("undefined");
    });

    it("shows a p-value column in the scientific form with the full digits on the title", () => {
        const html = renderTable(block, { type: "table", rows: [{ gene: "TP53", padj: 0.0000427777663038 }] });
        expect(html).toContain(`<td data-value="0.0000427777663038" title="0.0000427777663038">4.3e-5</td>`);
    });

    it("rounds a long float to three significant digits and keeps the full digits on the title", () => {
        const html = renderTable(block, { type: "table", rows: [{ gene: "TP53", log2FoldChange: -3.089028528355109 }] });
        expect(html).toContain(`<td data-value="-3.089028528355109" title="-3.089028528355109">-3.09</td>`);
    });

    it("groups a count and gives it no title, because the grouping hides no digit", () => {
        const html = renderTable(block, { type: "table", rows: [{ gene: "TP53", reads: 14201 }] });
        expect(html).toContain(`<td data-value="14201">14,201</td>`);
    });

    it("keeps an identifier column whole, with no grouping and no title", () => {
        const html = renderTable(block, { type: "table", rows: [{ gene: "TP53", pmid: "31978945" }] });
        expect(html).toContain(`<td data-value="31978945">31978945</td>`);
        expect(html).not.toContain("31,978,945");
        expect(html).not.toContain("title=");
    });

    it("gives a grouped whole number to a large float and keeps the full digits on the title", () => {
        const html = renderTable(block, { type: "table", rows: [{ gene: "TP53", baseMean: 15234.7 }] });
        expect(html).toContain(`<td data-value="15234.7" title="15234.7">15,235</td>`);
    });

    it("passes a non-numeric cell through unchanged and gives it no title", () => {
        const html = renderTable(block, { type: "table", rows: [{ gene: "TP53", direction: "up" }] });
        expect(html).toContain(`<td data-value="up">up</td>`);
        expect(html).not.toContain("title=");
    });

    it("carries the raw value of a shortened cell, thus the sort reads the full magnitude", () => {
        const html = renderTable(block, { type: "table", rows: [{ gene: "TP53", baseMean: 15234.7 }] });
        // The shown text is a rounded form. A sort over the shown text would order `15,235` as a string.
        expect(html).toContain(`data-value="15234.7"`);
    });

    it("hides each row past the cap and names the total on the toggle", () => {
        const total = TABLE_ROW_CAP + 5;
        const html = renderTable(block, rowsOf(total));
        expect(html.split(`<tr class="report-row`).length - 1).toBe(total);
        expect(html.split(`<tr class="report-row report-row-hidden">`).length - 1).toBe(5);
        expect(html).toContain(`<button type="button" class="report-table-toggle">Show all ${total}</button>`);
    });

    it("leaves a table at the cap with no hidden row and no toggle", () => {
        const html = renderTable(block, rowsOf(TABLE_ROW_CAP));
        expect(html.split(`<tr class="report-row">`).length - 1).toBe(TABLE_ROW_CAP);
        expect(html).not.toContain("report-row-hidden");
        expect(html).not.toContain("report-table-toggle");
    });

    it("carries one filter input for each table card", () => {
        const html = renderTable(block, rowsOf(3));
        expect(html.split(`class="report-table-filter"`).length - 1).toBe(1);
    });

    it("shows the first segment of a delimited name and keeps the whole name on the title", () => {
        const name = "HALLMARK_HYPOXIA%MSigDB%M5891";
        const html = renderTable(block, { type: "table", rows: [{ set: name, padj: 0.01 }] });
        expect(html).toContain(`<td data-value="${name}" title="${name}">HALLMARK_HYPOXIA</td>`);
    });

    it("keeps a text whose last segment is empty, thus a percentage stays whole", () => {
        const html = renderTable(block, { type: "table", rows: [{ gene: "TP53", coverage: "95%" }] });
        expect(html).toContain(`<td data-value="95%">95%</td>`);
    });

    it("keeps a hostile cell as text after the format passes it through", () => {
        const html = renderTable(block, { type: "table", rows: [{ gene: "<script>alert(1)</script>", padj: 0.01 }] });
        expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(html).not.toContain("<script>alert(1)");
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
