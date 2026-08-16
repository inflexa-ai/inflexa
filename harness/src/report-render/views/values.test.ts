import { describe, expect, it } from "bun:test";

import type { CitationBlock, FigureBlock, MetricBlock, TableBlock } from "../../contracts/report-blocks.js";
import type { ScalarReference } from "../../contracts/report-reference.js";
import { tableSidecarName } from "../assets.js";
import { renderCitation, renderFigure, renderMetric, renderTable, renderTableRows, TABLE_ROW_CAP } from "./values.js";
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

    it("shows the near-zero form for a zero p-value, because a metric has no column to bound it", () => {
        const html = renderMetric(metric("padj"), { type: "scalar", value: 0 });
        expect(html).toContain(`<div class="stat-card-value" title="0">≈0</div>`);
    });

    it("keeps a zero that names no p-value", () => {
        const html = renderMetric(metric("Genes tested"), { type: "scalar", value: 0 });
        expect(html).toContain(`<div class="stat-card-value">0</div>`);
    });
});

describe("renderTableRows", () => {
    const block: TableBlock = { kind: "table", id: "tb1", binding: tableBinding };

    /** One table value of `count` rows. The gene column numbers each row, thus a sorted order is readable. */
    function rowsOf(count: number) {
        const rows = [];
        for (let index = 0; index < count; index += 1) {
            rows.push({ gene: `G${index}`, padj: 0.01 });
        }
        return { type: "table", rows } as const;
    }

    it("renders one row for each resolved row", () => {
        const html = renderTableRows(block, {
            type: "table",
            rows: [
                { gene: "TP53", padj: 0.01 },
                { gene: "MYC", padj: 0.02 },
                { gene: "EGFR", padj: 0.03 },
            ],
        });
        expect(html.split(`<tr class="report-row`).length - 1).toBe(3);
        expect(html).toContain("TP53");
    });

    it("renders nothing for a zero-row table", () => {
        expect(renderTableRows(block, { type: "table", rows: [], columns: ["gene", "padj"] })).toBe("");
    });

    it("renders an absent cell as an empty cell", () => {
        const html = renderTableRows(block, {
            type: "table",
            rows: [{ gene: "TP53", padj: 0.01 }, { gene: "MYC" }],
            columns: ["gene", "padj"],
        });
        expect(html).toContain(`<td data-value=""></td>`);
        expect(html).not.toContain("undefined");
    });

    it("shows a p-value column in the scientific form with the full digits on the title", () => {
        const html = renderTableRows(block, { type: "table", rows: [{ gene: "TP53", padj: 0.0000427777663038 }] });
        expect(html).toContain(`<td data-value="0.0000427777663038" title="0.0000427777663038">4.3e-5</td>`);
    });

    it("rounds a long float to three significant digits and keeps the full digits on the title", () => {
        const html = renderTableRows(block, { type: "table", rows: [{ gene: "TP53", log2FoldChange: -3.089028528355109 }] });
        expect(html).toContain(`<td data-value="-3.089028528355109" title="-3.089028528355109">-3.09</td>`);
    });

    it("groups a count and gives it no title, because the grouping hides no digit", () => {
        const html = renderTableRows(block, { type: "table", rows: [{ gene: "TP53", reads: 14201 }] });
        expect(html).toContain(`<td data-value="14201">14,201</td>`);
    });

    it("keeps an identifier column whole, with no grouping and no title", () => {
        const html = renderTableRows(block, { type: "table", rows: [{ gene: "TP53", pmid: "31978945" }] });
        expect(html).toContain(`<td data-value="31978945">31978945</td>`);
        expect(html).not.toContain("31,978,945");
        expect(html).not.toContain("title=");
    });

    it("gives a grouped whole number to a large float and keeps the full digits on the title", () => {
        const html = renderTableRows(block, { type: "table", rows: [{ gene: "TP53", baseMean: 15234.7 }] });
        expect(html).toContain(`<td data-value="15234.7" title="15234.7">15,235</td>`);
    });

    it("passes a non-numeric cell through unchanged and gives it no title", () => {
        const html = renderTableRows(block, { type: "table", rows: [{ gene: "TP53", direction: "up" }] });
        expect(html).toContain(`<td data-value="up">up</td>`);
        expect(html).not.toContain("title=");
    });

    it("carries the raw value of a shortened cell, thus the sort reads the full magnitude", () => {
        const html = renderTableRows(block, { type: "table", rows: [{ gene: "TP53", baseMean: 15234.7 }] });
        // The shown text is a rounded form. A sort over the shown text would order `15,235` as a string.
        expect(html).toContain(`data-value="15234.7"`);
    });

    it("marks each row past the cap as hidden", () => {
        const total = TABLE_ROW_CAP + 5;
        const html = renderTableRows(block, rowsOf(total));
        expect(html.split(`<tr class="report-row`).length - 1).toBe(total);
        expect(html.split(`<tr class="report-row report-row-hidden">`).length - 1).toBe(5);
    });

    it("marks no row of a table at the cap as hidden", () => {
        const html = renderTableRows(block, rowsOf(TABLE_ROW_CAP));
        expect(html.split(`<tr class="report-row">`).length - 1).toBe(TABLE_ROW_CAP);
        expect(html).not.toContain("report-row-hidden");
    });

    it("shows the first segment of a delimited name and keeps the whole name on the title", () => {
        const name = "HALLMARK_HYPOXIA%MSigDB%M5891";
        const html = renderTableRows(block, { type: "table", rows: [{ set: name, padj: 0.01 }] });
        expect(html).toContain(`<td data-value="${name}" title="${name}">HALLMARK_HYPOXIA</td>`);
    });

    it("keeps a text whose last segment is empty, thus a percentage stays whole", () => {
        const html = renderTableRows(block, { type: "table", rows: [{ gene: "TP53", coverage: "95%" }] });
        expect(html).toContain(`<td data-value="95%">95%</td>`);
    });

    it("keeps a text of two segments whole, because an encoded name holds three", () => {
        const html = renderTableRows(block, { type: "table", rows: [{ gene: "TP53", note: "KEGG%hsa04110" }] });
        expect(html).toContain(`<td data-value="KEGG%hsa04110">KEGG%hsa04110</td>`);
    });

    it("keeps a sentence with a percentage whole, because a segment of an encoded name holds no space", () => {
        const html = renderTableRows(block, { type: "table", rows: [{ gene: "TP53", change: "up 20% vs control%cohort" }] });
        expect(html).toContain(`<td data-value="up 20% vs control%cohort">up 20% vs control%cohort</td>`);
    });

    /** One table block whose binding carries the declarations that a test states. */
    function declared(declaration: Pick<TableBlock["binding"], "columnMeanings" | "columnLabels">): TableBlock {
        return { kind: "table", id: "tb1", binding: { ...tableBinding, ...declaration } };
    }

    it("reads a declared p-value column in the scientific form, although its name matches no token", () => {
        const rows = { type: "table", rows: [{ gene: "TP53", significance: 0.00427777663038 }] } as const;
        const html = renderTableRows(declared({ columnMeanings: { significance: "p-value" } }), rows);
        expect(html).toContain(`<td data-value="0.00427777663038" title="0.00427777663038">4.3e-3</td>`);
        // The same cell with no declaration keeps the guess, thus the declaration is what moved the kind.
        expect(renderTableRows(block, rows)).toContain(`>0.00428</td>`);
    });

    it("keeps a declared p-value from one hundredth up as a plain decimal with no full form", () => {
        const rows = { type: "table", rows: [{ gene: "TP53", significance: 0.536 }] } as const;
        const html = renderTableRows(declared({ columnMeanings: { significance: "p-value" } }), rows);
        expect(html).toContain(`<td data-value="0.536">0.536</td>`);
        expect(html).not.toContain("5.4e-1");
    });

    it("bounds a zero FDR by the smallest positive value of its own column", () => {
        const html = renderTableRows(block, {
            type: "table",
            rows: [
                { gene: "TP53", fdr: 0 },
                { gene: "MYC", fdr: 0.00036 },
                { gene: "EGFR", fdr: 0.02 },
            ],
        });
        // The runtime escapes the `<` of the bound, thus the comparison reaches the page as text.
        expect(html).toContain(`<td data-value="0" title="0">&lt;4e-4</td>`);
        expect(html).not.toContain(`>0</td>`);
    });

    it("bounds a zero of a declared p-value column, the same as a token-matched one", () => {
        const rows = {
            type: "table",
            rows: [
                { gene: "TP53", significance: 0 },
                { gene: "MYC", significance: 0.00036 },
            ],
        } as const;
        const html = renderTableRows(declared({ columnMeanings: { significance: "p-value" } }), rows);
        expect(html).toContain(`<td data-value="0" title="0">&lt;4e-4</td>`);
        // With no declaration the name matches no token, thus the zero stays a count-like zero.
        expect(renderTableRows(block, rows)).toContain(`<td data-value="0">0</td>`);
    });

    it("shows the near-zero form for a p-value column that holds no positive value", () => {
        const html = renderTableRows(block, {
            type: "table",
            rows: [
                { gene: "TP53", padj: 0 },
                { gene: "MYC", padj: 0 },
            ],
        });
        expect(html).toContain(`<td data-value="0" title="0">≈0</td>`);
    });

    it("reads each p-value column on its own, thus a neighbor of one column bounds no other", () => {
        const html = renderTableRows(block, {
            type: "table",
            rows: [
                { pvalue: 0, padj: 0.00036 },
                { pvalue: 0.0002, padj: 0 },
            ],
        });
        expect(html).toContain(`>&lt;2e-4</td>`);
        expect(html).toContain(`>&lt;4e-4</td>`);
    });

    it("keeps the zero of a declared count column", () => {
        const html = renderTableRows(declared({ columnMeanings: { hits: "count" } }), { type: "table", rows: [{ gene: "TP53", hits: 0 }] });
        expect(html).toContain(`<td data-value="0">0</td>`);
        expect(html).not.toContain("≈0");
    });

    it("keeps the zero of an undeclared column of a different nature", () => {
        const html = renderTableRows(block, { type: "table", rows: [{ gene: "TP53", log2FoldChange: 0, reads: 0 }] });
        expect(html.split(`<td data-value="0">0</td>`).length - 1).toBe(2);
    });

    it("ignores a declaration that names no column of the table", () => {
        const rows = { type: "table", rows: [{ gene: "TP53", padj: 0.00427777663038 }] } as const;
        const stray = declared({ columnMeanings: { absent: "identifier" }, columnLabels: { absent: "Absent column" } });
        expect(renderTableRows(stray, rows)).toBe(renderTableRows(block, rows));
    });

    it("keeps a hostile cell as text after the format passes it through", () => {
        const html = renderTableRows(block, { type: "table", rows: [{ gene: "<script>alert(1)</script>", padj: 0.01 }] });
        expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(html).not.toContain("<script>alert(1)");
    });
});

describe("renderTable", () => {
    /** The block that every card test renders. Its binding names the pinned artifact of the download. */
    const block: TableBlock = { kind: "table", id: "tb1", binding: tableBinding };

    /** One table block whose binding carries the declarations that a test states. */
    function declared(declaration: Pick<TableBlock["binding"], "columnMeanings" | "columnLabels">): TableBlock {
        return { kind: "table", id: "tb1", binding: { ...tableBinding, ...declaration } };
    }

    /** One table value of `count` rows. The card renders none of them, thus the count states the input alone. */
    function rowsOf(count: number) {
        const rows = [];
        for (let index = 0; index < count; index += 1) {
            rows.push({ gene: `G${index}`, padj: 0.01 });
        }
        return { type: "table", rows } as const;
    }

    it("renders one header cell for each column and no data row", () => {
        const html = renderTable(block, rowsOf(3));

        expect(html.split(`<th class="data-table-sort"`).length - 1).toBe(2);
        // The rows ride the data asset, thus the markup carries no copy of them.
        expect(html).toContain("<tbody></tbody>");
        expect(html).not.toContain("<td");
        expect(html).not.toContain("G0");
    });

    it("renders the header of a zero-row table with named columns", () => {
        const html = renderTable(block, { type: "table", rows: [], columns: ["gene", "padj"] });
        expect(html.split(`<th class="data-table-sort"`).length - 1).toBe(2);
    });

    it("keeps the body empty however many rows resolve", () => {
        expect(renderTable(block, rowsOf(TABLE_ROW_CAP + 5))).toContain("<tbody></tbody>");
        expect(renderTable(block, rowsOf(TABLE_ROW_CAP + 5))).not.toContain("report-row");
    });

    it("gives each sortable header the tab order, thus the keyboard reaches the sort", () => {
        const html = renderTable(block, { type: "table", rows: [{ gene: "TP53", padj: 0.01 }] });
        expect(html.split(`<th class="data-table-sort" data-sort-index="`).length - 1).toBe(2);
        expect(html.split(`tabindex="0"`).length - 1).toBe(2);
    });

    it("shows the declared label of a column and keeps the raw name on hover", () => {
        const html = renderTable(declared({ columnLabels: { padj: "Adjusted p-value" } }), { type: "table", rows: [{ gene: "TP53", padj: 0.01 }] });
        expect(html).toContain(`tabindex="0" title="padj">Adjusted p-value</th>`);
    });

    it("prettifies an undeclared header and keeps the raw name on hover", () => {
        const html = renderTable(block, { type: "table", rows: [{ gene_symbol: "TP53" }] });
        expect(html).toContain(`tabindex="0" title="gene_symbol">gene symbol</th>`);
    });

    it("gives no title to a header whose shown text is its raw name", () => {
        const html = renderTable(declared({ columnLabels: { gene: "gene" } }), { type: "table", rows: [{ gene: "TP53" }] });
        expect(html).toContain(`tabindex="0">gene</th>`);
    });

    it("links the staged raw bytes of the pinned artifact as the download", () => {
        const html = renderTable(block, rowsOf(2));
        const name = tableSidecarName(tableBinding.hash, tableBinding.path);

        // The link is relative, thus the page fetches no host when it opens. The attribute makes the
        // browser save the file instead of navigating to it.
        expect(html).toContain(`href="assets/${name}"`);
        expect(html).toContain(`download="${name}"`);
        expect(name.endsWith("de.csv")).toBe(true);
    });

    it("carries no filter and no toggle, because the enhancer drives neither over an empty body", () => {
        const html = renderTable(block, rowsOf(TABLE_ROW_CAP + 5));
        expect(html).not.toContain("report-table-filter");
        expect(html).not.toContain("report-table-toggle");
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
    /** One citation block over the given key, with a note. */
    function citationBlock(idKind: "pmid" | "doi", id: string): CitationBlock {
        return { kind: "citation", id: "cit1", binding: { kind: "citation", idKind, id, raw: "Doe 2020" }, note: "see figure 2" };
    }

    it("renders the bracket marker, the key, and the optional note", () => {
        const html = renderCitation(citationBlock("pmid", "12345"), new ReferenceLedger());
        expect(html).toContain(`href="#cite-1"`);
        expect(html).toContain("[1]");
        expect(html).toContain("pmid:12345");
        expect(html).toContain("see figure 2");
    });

    it("renders the short citation of a pmid record as a PubMed link", () => {
        const html = renderCitation(citationBlock("pmid", "26997480"), new ReferenceLedger(), {
            citation: "Hugo et al. 2016",
            description: "The resistance paper.",
        });

        expect(html).toContain("Hugo et al. 2016");
        expect(html).toContain(`href="https://pubmed.ncbi.nlm.nih.gov/26997480/"`);
        // The card is the bibliography entry, thus it names the key beside the paper.
        expect(html).toContain("pmid:26997480");
        expect(html).toContain("see figure 2");
    });

    it("renders a record of another identifier space with no link", () => {
        const html = renderCitation(citationBlock("doi", "10.1000/xyz"), new ReferenceLedger(), { citation: "Roe et al. 2021" });

        expect(html).toContain("Roe et al. 2021");
        expect(html).toContain("doi:10.1000/xyz");
        expect(html).not.toContain("pubmed.ncbi.nlm.nih.gov");
    });

    it("renders a key that the record map does not hold with no citation and no link", () => {
        const html = renderCitation(citationBlock("pmid", "12345"), new ReferenceLedger());

        expect(html).not.toContain("report-citation-source");
        expect(html).not.toContain("pubmed.ncbi.nlm.nih.gov");
        expect(html).toContain("pmid:12345");
    });

    it("keeps a hostile id inside the link and inside the key", () => {
        const html = renderCitation(citationBlock("pmid", '1" onclick="alert(1)'), new ReferenceLedger(), { citation: "Doe 2020" });

        // The escape of the attribute holds the quote, and the encode of the id holds the space.
        expect(html).not.toContain(`onclick="alert(1)"`);
        expect(html).toContain("https://pubmed.ncbi.nlm.nih.gov/1%22%20onclick%3D%22alert(1)/");
    });
});
