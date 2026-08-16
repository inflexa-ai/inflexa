import { describe, expect, it } from "bun:test";

import type { CitationBlock, FigureBlock, MetricBlock, TableBlock } from "../../contracts/report-blocks.js";
import type { ScalarReference } from "../../contracts/report-reference.js";
import { tableSidecarName } from "../assets.js";
import {
    GRID_COUNT_CLASS,
    GRID_MOUNT_ATTRIBUTE,
    GRID_NOTE_CLASS,
    GRID_ROWS_WORD,
    renderCitation,
    renderFigure,
    renderMetric,
    renderTable,
    tableDisplay,
} from "./values.js";
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

describe("tableDisplay", () => {
    const block: TableBlock = { kind: "table", id: "tb1", binding: tableBinding };

    /** One table block whose binding carries the declarations that a test states. */
    function declared(declaration: Pick<TableBlock["binding"], "columnMeanings" | "columnLabels">): TableBlock {
        return { kind: "table", id: "tb1", binding: { ...tableBinding, ...declaration } };
    }

    /** The display of the named columns over the given rows, in the column order. */
    function displayOf(table: TableBlock, columns: string[], rows: Record<string, string | number>[]) {
        return tableDisplay(table, { type: "table", rows }, columns);
    }

    it("gives one entry for each column, in the column order", () => {
        const display = displayOf(block, ["gene", "padj"], [{ gene: "TP53", padj: 0.01 }]);

        expect(display.length).toBe(2);
        expect(display[0].label).toBe("gene");
        expect(display[1].label).toBe("padj");
    });

    it("shows the declared label of a column", () => {
        const display = displayOf(declared({ columnLabels: { padj: "Adjusted p-value" } }), ["padj"], [{ padj: 0.01 }]);
        expect(display[0].label).toBe("Adjusted p-value");
    });

    it("prettifies the label of an undeclared column", () => {
        const display = displayOf(block, ["gene_symbol"], [{ gene_symbol: "TP53" }]);
        expect(display[0].label).toBe("gene symbol");
    });

    it("takes the filter of a column from its cells and not from its kind", () => {
        const display = displayOf(block, ["gene", "padj"], [{ gene: "TP53", padj: 0.01 }]);

        // A gene column holds names, thus a reader filters it by name. A p-value column holds magnitudes.
        expect(display[0].filter).toBe("text");
        expect(display[1].filter).toBe("number");
    });

    it("keeps the number filter of a column that holds a sentinel beside its numbers", () => {
        const rows = [{ reads: "NA" }, { reads: 14201 }];
        expect(displayOf(block, ["reads"], rows)[0].filter).toBe("number");
        // A column where no cell parses holds names, thus it filters as text.
        expect(displayOf(block, ["direction"], [{ direction: "up" }, { direction: "down" }])[0].filter).toBe("text");
    });

    it("gives the number filter to an identifier column that holds numeric text", () => {
        // The kind keeps the source text of the identifier, and the filter reads what the cells hold.
        const display = displayOf(block, ["pmid"], [{ pmid: "31978945" }]);
        expect(display[0].kind).toBe("identifier");
        expect(display[0].filter).toBe("number");
    });

    it("reads a p-value column as the scientific kind and every other column as the rounded kind", () => {
        const display = displayOf(block, ["gene", "padj", "reads"], [{ gene: "TP53", padj: 0.01, reads: 14201 }]);

        expect(display[0].kind).toBe("compact-scientific");
        expect(display[1].kind).toBe("scientific");
        expect(display[2].kind).toBe("compact-scientific");
    });

    it("reads a declared p-value column as the scientific kind, although its name matches no token", () => {
        const table = declared({ columnMeanings: { significance: "p-value" } });
        expect(displayOf(table, ["significance"], [{ significance: 0.004 }])[0].kind).toBe("scientific");
        // The same column with no declaration matches no token, thus it keeps the rounded kind.
        expect(displayOf(block, ["significance"], [{ significance: 0.004 }])[0].kind).toBe("compact-scientific");
    });

    it("reads an identifier column and a declared category column as the identifier kind", () => {
        expect(displayOf(block, ["pmid"], [{ pmid: "31978945" }])[0].kind).toBe("identifier");
        const table = declared({ columnMeanings: { cluster: "category" } });
        expect(displayOf(table, ["cluster"], [{ cluster: "01" }])[0].kind).toBe("identifier");
    });

    it("bounds a p-value column by the smallest positive value of its own rows", () => {
        const rows = [
            { fdr: 0, pvalue: 0.0002 },
            { fdr: 0.00036, pvalue: 0 },
            { fdr: 0.02, pvalue: 0.5 },
        ];
        const display = displayOf(block, ["fdr", "pvalue"], rows);

        // Each column reads on its own, thus the neighbor of one column bounds no other.
        expect(display[0].bound).toBe(0.00036);
        expect(display[1].bound).toBe(0.0002);
    });

    it("gives no bound to a p-value column that holds no positive value", () => {
        const display = displayOf(block, ["padj"], [{ padj: 0 }, { padj: 0 }]);
        expect(display[0].bound).toBeUndefined();
    });

    it("gives no bound to a column of another nature, because no zero of it reads as a bound", () => {
        const display = displayOf(block, ["reads"], [{ reads: 0 }, { reads: 14201 }]);
        expect(display[0].bound).toBeUndefined();
    });

    it("ignores a declaration that names no column of the table", () => {
        const stray = declared({ columnMeanings: { absent: "identifier" }, columnLabels: { absent: "Absent column" } });
        const rows = [{ gene: "TP53", padj: 0.004 }];
        expect(displayOf(stray, ["gene", "padj"], rows)).toEqual(displayOf(block, ["gene", "padj"], rows));
    });
});

describe("renderTable", () => {
    /** The block that every card test renders. Its binding names the pinned artifact of the download. */
    const block: TableBlock = { kind: "table", id: "tb1", binding: tableBinding };

    it("renders one empty grid mount that names its block, and no row", () => {
        const html = renderTable(block, 3);

        expect(html).toContain(`<div class="report-grid" ${GRID_MOUNT_ATTRIBUTE}="tb1"></div>`);
        // The rows and the header ride the data asset, thus the markup carries no copy of either.
        expect(html).not.toContain("<table");
        expect(html).not.toContain("<th");
        expect(html).not.toContain("<td");
    });

    it("renders the title of the card and the caption under it", () => {
        const html = renderTable({ ...block, title: "Top genes", caption: "The hypoxic group." }, 3);

        expect(html).toContain(`<div class="report-table-title">Top genes</div>`);
        expect(html).toContain(`<p class="report-caption">The hypoxic group.</p>`);
    });

    it("states the row count of the table in the status line, grouped", () => {
        const html = renderTable(block, 14201);

        // The count reads as the number format of the page reads a count, thus the card and a cell agree.
        expect(html).toContain(`<span class="${GRID_COUNT_CLASS}">14,201 ${GRID_ROWS_WORD}</span>`);
    });

    it("names the row bound of the binding beside the count, and nothing where the binding carries none", () => {
        const bounded: TableBlock = { kind: "table", id: "tb1", binding: { ...tableBinding, rowBound: { column: "padj", count: 20, order: "asc" } } };
        // An ascending bound keeps the smallest values, thus the status names that end of the ranked order.
        expect(renderTable(bounded, 20)).toContain(`<span class="report-table-bound">lowest 20 by padj</span>`);

        const top: TableBlock = { kind: "table", id: "tb1", binding: { ...tableBinding, rowBound: { column: "nes", count: 20 } } };
        expect(renderTable(top, 20)).toContain(`<span class="report-table-bound">top 20 by nes</span>`);

        // The declared label of the column names the bound, the same as it names the header.
        const labeled: TableBlock = {
            kind: "table",
            id: "tb1",
            binding: { ...tableBinding, rowBound: { column: "padj", count: 6 }, columnLabels: { padj: "Adjusted p-value" } },
        };
        expect(renderTable(labeled, 6)).toContain("top 6 by Adjusted p-value");

        // A large bound groups its digits, the same as the count beside it.
        const wide: TableBlock = { kind: "table", id: "tb1", binding: { ...tableBinding, rowBound: { column: "nes", count: 5000 } } };
        expect(renderTable(wide, 5000)).toContain("top 5,000 by nes");
        expect(renderTable(block, 6)).not.toContain("report-table-bound");
    });

    it("renders the download as a button of the card footer, named for the format of the file", () => {
        const html = renderTable(block, 2);
        const name = tableSidecarName(tableBinding.hash, tableBinding.path);

        // The link is relative, thus the page fetches no host when it opens. The attribute makes the
        // browser save the file instead of navigating to it.
        expect(html).toContain(`<a class="report-table-download" href="assets/${name}" download="${name}">Download CSV</a>`);
        expect(name.endsWith("de.csv")).toBe(true);
        // The status and the button sit in one row of the footer, and the print note sits under them.
        expect(html).toContain(`<div class="report-table-footer"><div class="report-table-footer-row">`);
        expect(html).toContain(`<div class="${GRID_NOTE_CLASS}"></div></div>`);
    });

    it("names the format of another file, and it names none where the path carries no extension", () => {
        const parquet: TableBlock = { kind: "table", id: "tb1", binding: { ...tableBinding, path: "runs/r1/de.parquet" } };
        expect(renderTable(parquet, 2)).toContain(">Download PARQUET</a>");

        const bare: TableBlock = { kind: "table", id: "tb1", binding: { ...tableBinding, path: "runs/r1/table" } };
        expect(renderTable(bare, 2)).toContain(">Download</a>");
    });

    it("carries no filter, no toggle, and no capped row, because the grid owns the table", () => {
        const html = renderTable(block, 25);

        for (const retired of ["report-table-filter", "report-table-toggle", "report-row", "data-table"]) {
            expect(html).not.toContain(retired);
        }
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
