/**
 * The design fixture: one report document that covers every block kind, with its value map.
 *
 * A person edits `design.ts` and the views, then examines this page. Thus the fixture holds each of the
 * eight kinds, a run of metric siblings, a lone metric between two text blocks, a text block with a list,
 * a titled table, a titled chart, a figure, a citation, and a section tree of three depths. Three
 * top-level sections show the band alternation, and the reference band holds an artifact reference beside
 * a citation that two claims share.
 *
 * The fixture also carries a provenance export. Thus the fixture page stamps each grounded block and shows
 * the lineage control, and a person examines that control beside the markers.
 *
 * Each value is a literal, and the figure source is an inline data URI. Thus the page is a pure function of
 * this module, and the fixture reads no file.
 *
 * Only the tests and `scripts/render-fixture.ts` read this module, thus `tsconfig.json` excludes it the same
 * way that it excludes a test file and the build emits no `dist/report-render/fixture.js`. The lint program
 * (`tsconfig.eslint.json`) still holds it.
 */

import type { CitationReference, ArtifactTableReference, ArtifactValueReference } from "../contracts/report-reference.js";
import type { ReportDocument } from "../contracts/report-blocks.js";
import type { ProvenanceExport } from "./provenance-data.js";
import type { RenderValues } from "./types.js";

/** The artifact that carries the per-sample coverage. One claim cites the median depth cell of it. */
const COVERAGE_PATH = "runs/run-2f1c/qc/coverage.csv";

/** The artifact that carries the one-row cohort summary. Three metrics address one cell of it each. */
const SUMMARY_PATH = "runs/run-2f1c/qc/cohort-summary.csv";

/** The artifact that carries the DESeq2 result table. The table block and one claim both name it. */
const RESULTS_PATH = "runs/run-2f1c/de/deseq2-results.csv";

/** One cell of the cohort summary. Each metric of the run binds a different column of the same row. */
function summaryCell(column: string): ArtifactValueReference {
    return { kind: "artifact-value", run: "run-2f1c", path: SUMMARY_PATH, hash: "sha256:1c8e5a0b6f42", locator: { column, row: 0 } };
}

/** The coverage cell that the depth metric and the power claim both bind. */
const depthReference: ArtifactValueReference = {
    kind: "artifact-value",
    run: "run-2f1c",
    path: COVERAGE_PATH,
    hash: "sha256:9b1d4c7af0e2",
    locator: { column: "median_depth", row: 0 },
};

/** The result table as a whole-file reference. The pathway claim binds it as its evidence. */
const resultsReference: ArtifactTableReference = {
    kind: "artifact-table",
    run: "run-2f1c",
    path: RESULTS_PATH,
    hash: "sha256:4e7c02b8d135",
};

/**
 * The hypoxia source. Two claims in two different sections bind it, thus the ledger gives it one number
 * and the reference band lists it one time.
 */
const hypoxiaCitation: CitationReference = {
    kind: "citation",
    idKind: "pmid",
    id: "31423041",
    raw: "Bhandari V, et al. Molecular landmarks of tumor hypoxia across cancer types. Nat Genet. 2019.",
};

/** The atlas source of the final section. */
const atlasCitation: CitationReference = {
    kind: "citation",
    idKind: "doi",
    id: "10.1038/s41586-020-2922-4",
    raw: "Chen H, et al. A pan-cancer single-cell transcriptional atlas. Nature. 2020.",
};

/**
 * The volcano figure as inline SVG source.
 *
 * The point coordinates are literals, thus the image is deterministic. The teal points pass the false
 * discovery threshold, the rose points fall below it, and the slate points stay under the cut.
 */
const VOLCANO_SVG = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360">`,
    `<rect width="640" height="360" fill="#ffffff"/>`,
    `<line x1="70" y1="300" x2="610" y2="300" stroke="#cbd5e1" stroke-width="1"/>`,
    `<line x1="70" y1="30" x2="70" y2="300" stroke="#cbd5e1" stroke-width="1"/>`,
    `<line x1="70" y1="150" x2="610" y2="150" stroke="#94a3b8" stroke-width="1" stroke-dasharray="5 5"/>`,
    `<line x1="290" y1="30" x2="290" y2="300" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="5 5"/>`,
    `<line x1="390" y1="30" x2="390" y2="300" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="5 5"/>`,
    `<circle cx="118" cy="64" r="5" fill="#e11d48"/>`,
    `<circle cx="152" cy="92" r="5" fill="#e11d48"/>`,
    `<circle cx="186" cy="118" r="5" fill="#e11d48"/>`,
    `<circle cx="214" cy="136" r="4" fill="#e11d48"/>`,
    `<circle cx="556" cy="52" r="5" fill="#0d9488"/>`,
    `<circle cx="520" cy="80" r="5" fill="#0d9488"/>`,
    `<circle cx="486" cy="104" r="5" fill="#0d9488"/>`,
    `<circle cx="452" cy="128" r="4" fill="#0d9488"/>`,
    `<circle cx="424" cy="142" r="4" fill="#0d9488"/>`,
    `<circle cx="252" cy="196" r="4" fill="#cbd5e1"/>`,
    `<circle cx="284" cy="228" r="4" fill="#cbd5e1"/>`,
    `<circle cx="316" cy="254" r="4" fill="#cbd5e1"/>`,
    `<circle cx="340" cy="272" r="4" fill="#cbd5e1"/>`,
    `<circle cx="364" cy="248" r="4" fill="#cbd5e1"/>`,
    `<circle cx="396" cy="222" r="4" fill="#cbd5e1"/>`,
    `<circle cx="428" cy="264" r="4" fill="#cbd5e1"/>`,
    `<circle cx="222" cy="240" r="4" fill="#cbd5e1"/>`,
    `<circle cx="192" cy="268" r="4" fill="#cbd5e1"/>`,
    `<circle cx="466" cy="282" r="4" fill="#cbd5e1"/>`,
    `<text x="340" y="336" fill="#475569" font-family="monospace" font-size="13" text-anchor="middle">log2 fold change</text>`,
    `<text x="28" y="165" fill="#475569" font-family="monospace" font-size="13" text-anchor="middle" transform="rotate(-90 28 165)">-log10 p</text>`,
    `</svg>`,
].join("");

/**
 * The figure source as a data URI. The encoding leaves no quote and no angle bracket in the value, thus the
 * source rides one HTML attribute and the page still stands alone.
 */
const VOLCANO_SOURCE = `data:image/svg+xml,${encodeURIComponent(VOLCANO_SVG)}`;

/** The fixture document. Each block id is stable, thus two renders give the same bytes. */
export const FIXTURE_DOCUMENT: ReportDocument = {
    title: "Hypoxia Response in TP53-Mutant Lung Adenocarcinoma",
    sections: [
        {
            kind: "section",
            id: "cohort",
            title: "Cohort and Coverage",
            blocks: [
                {
                    kind: "text",
                    id: "cohort-intro",
                    content: {
                        prose:
                            "The cohort holds 48 primary lung adenocarcinoma biopsies. Each biopsy carries a confirmed TP53 " +
                            "missense variant. The run aligned every library against GRCh38 and counted the reads per gene with " +
                            "featureCounts.\n\n" +
                            "The analysis compares the 26 hypoxic biopsies against the 22 normoxic biopsies. The hypoxia label " +
                            "comes from the Buffa signature score, at the median of the cohort.",
                    },
                },
                { kind: "metric", id: "metric-samples", label: "Samples sequenced", value: summaryCell("n_samples") },
                { kind: "metric", id: "metric-genes", label: "Genes tested", value: summaryCell("n_genes_tested") },
                { kind: "metric", id: "metric-hits", label: "Genes past FDR 0.05", value: summaryCell("n_significant") },
                {
                    kind: "claim",
                    id: "claim-power",
                    content: {
                        prose:
                            "The median depth gives 80 percent power to detect a two-fold change at a false discovery rate of " +
                            "0.05. The hypoxia signature separates the two groups at the same depth in the reference cohort.",
                    },
                    bindings: [depthReference, hypoxiaCitation],
                },
                {
                    kind: "text",
                    id: "cohort-batches",
                    content: {
                        prose:
                            "Three sequencing batches produced the libraries. The design matrix carries the batch as a covariate, " +
                            "thus a batch effect does not enter the fold-change estimate.",
                    },
                },
                { kind: "metric", id: "metric-depth", label: "Median read depth", value: depthReference },
                {
                    kind: "text",
                    id: "cohort-quality",
                    content: {
                        prose: "Every library passed the quality gate on three measures.",
                        list: {
                            ordered: false,
                            items: [
                                "The duplicate rate stayed under 18 percent.",
                                "The ribosomal fraction stayed under 4 percent.",
                                "No biopsy dropped out of the comparison.",
                            ],
                        },
                    },
                },
            ],
        },
        {
            kind: "section",
            id: "expression",
            title: "Differential Expression",
            blocks: [
                {
                    kind: "text",
                    id: "expression-intro",
                    content: {
                        prose:
                            "DESeq2 fitted a negative binomial model over the raw counts. The shrinkage estimator damped the fold " +
                            "change of each low-count gene. The table below lists the six genes with the smallest adjusted p-value.",
                    },
                },
                {
                    kind: "table",
                    id: "table-top-genes",
                    title: "Top differentially expressed genes",
                    binding: resultsReference,
                    caption: "The hypoxic group against the normoxic group. A positive fold change means a higher level under hypoxia.",
                },
                {
                    kind: "chart",
                    id: "chart-pathways",
                    title: "Pathway enrichment by normalized enrichment score",
                    binding: resultsReference,
                    chartType: "bar",
                    encoding: { x: "pathway", y: "nes" },
                    caption: "Gene set enrichment over the MSigDB hallmark collection. A positive score marks a set that hypoxia raises.",
                },
                {
                    kind: "section",
                    id: "pathways",
                    title: "Pathway Enrichment",
                    blocks: [
                        {
                            kind: "claim",
                            id: "claim-hypoxia",
                            content: {
                                prose:
                                    "The hypoxia hallmark set and the glycolysis hallmark set both rise under hypoxia. The p53 pathway " +
                                    "set falls, which agrees with the loss of the wild-type allele across the cohort.",
                            },
                            bindings: [hypoxiaCitation, resultsReference],
                        },
                        {
                            kind: "figure",
                            id: "figure-volcano",
                            binding: { kind: "artifact-file", run: "run-2f1c", path: "runs/run-2f1c/de/volcano.svg", hash: "sha256:a70f3b19cc84" },
                            caption: "Volcano plot of the 18432 tested genes. A teal point rises under hypoxia, and a rose point falls.",
                        },
                        {
                            kind: "section",
                            id: "hypoxia-detail",
                            title: "Hypoxia Signature Detail",
                            blocks: [
                                {
                                    kind: "text",
                                    id: "hypoxia-detail-note",
                                    content: {
                                        prose:
                                            "CA9 and SLC2A1 carry the largest rise. Both genes sit downstream of HIF1A, thus the signature " +
                                            "reads as a direct transcriptional response and not as a proliferation artifact.",
                                    },
                                },
                            ],
                        },
                    ],
                },
            ],
        },
        {
            kind: "section",
            id: "sources",
            title: "Evidence and Sources",
            blocks: [
                {
                    kind: "text",
                    id: "sources-intro",
                    content: {
                        prose: "Each claim above binds the artifact or the publication that supports it. The reference band lists every binding of the page.",
                    },
                },
                {
                    kind: "citation",
                    id: "citation-atlas",
                    binding: atlasCitation,
                    note: "The atlas supplies the cell-type fractions that the deconvolution step consumed.",
                },
            ],
        },
    ],
};

/**
 * The value map of the fixture, keyed by block id.
 *
 * Each entry is the value that a resolver gives back for the binding of its block. A metric needs a scalar,
 * a table and a chart need a table, and a figure needs a source string.
 */
export const FIXTURE_VALUES: RenderValues = {
    "metric-samples": { type: "scalar", value: 48 },
    "metric-genes": { type: "scalar", value: 18432 },
    "metric-hits": { type: "scalar", value: 312 },
    "metric-depth": { type: "scalar", value: "42.6M" },
    "table-top-genes": {
        type: "table",
        columns: ["gene", "log2FoldChange", "pvalue", "padj"],
        rows: [
            { gene: "CA9", log2FoldChange: 2.94, pvalue: 2.7e-10, padj: 2.6e-8 },
            { gene: "TP53", log2FoldChange: -2.41, pvalue: 1.2e-14, padj: 4.8e-11 },
            { gene: "VEGFA", log2FoldChange: 2.15, pvalue: 5.3e-9, padj: 4.1e-7 },
            { gene: "CDKN1A", log2FoldChange: -1.87, pvalue: 3.4e-12, padj: 6.9e-10 },
            { gene: "SLC2A1", log2FoldChange: 1.78, pvalue: 9.6e-8, padj: 5.2e-6 },
            { gene: "MDM2", log2FoldChange: 1.62, pvalue: 8.1e-11, padj: 1.1e-8 },
        ],
    },
    "chart-pathways": {
        type: "table",
        columns: ["pathway", "nes"],
        rows: [
            { pathway: "Hypoxia", nes: 2.41 },
            { pathway: "Glycolysis", nes: 2.18 },
            { pathway: "Angiogenesis", nes: 1.63 },
            { pathway: "p53 pathway", nes: -1.96 },
            { pathway: "G2M checkpoint", nes: -1.74 },
            { pathway: "Apoptosis", nes: -1.42 },
        ],
    },
    "figure-volcano": { type: "figure", src: VOLCANO_SOURCE },
};

/** The raw input of the fixture chain. The command reads these bytes, and no block of the report pins them. */
const COUNTS_PATH = "data/inputs/counts.csv";

/**
 * The provenance of the fixture: one document, and the attestation over it.
 *
 * The renderer moves the two texts into script assets and it parses no byte of them. The page-side library
 * parses the document, thus the fixture holds one real chain: the raw counts, the command that read them,
 * and the result table that the table block, the chart block, and one claim all pin.
 *
 * The chain is the smallest one that a walk can show. A pin of the report that this document holds no
 * entity for opens the same panel under the absence note, thus one fixture page shows both forms.
 *
 * The attestation is opaque. Nothing on the page parses it, thus one literal serves.
 */
export const FIXTURE_PROVENANCE: ProvenanceExport = {
    document: JSON.stringify({
        prefix: { inflexa: "https://inflexa.ai/prov#" },
        entity: {
            "inflexa:file-counts": { "inflexa:path": COUNTS_PATH, "inflexa:hash": "sha256:6d2a83f5c419", "inflexa:source": "data" },
            "inflexa:file-results": {
                "prov:type": "inflexa:File",
                "inflexa:path": RESULTS_PATH,
                "inflexa:hash": "sha256:4e7c02b8d135",
                "inflexa:producer": "command",
            },
        },
        activity: { "inflexa:cmd-run-2f1c-de": { "prov:type": "inflexa:Command", "inflexa:command": "Rscript deseq2.R" } },
        wasGeneratedBy: { "inflexa:gen-results": { "prov:entity": "inflexa:file-results", "prov:activity": "inflexa:cmd-run-2f1c-de" } },
        used: { "inflexa:used-cmd-counts": { "prov:activity": "inflexa:cmd-run-2f1c-de", "prov:entity": "inflexa:file-counts" } },
    }),
    attestation: JSON.stringify({ alg: "ed25519", signature: "Zml4dHVyZS1zaWduYXR1cmU" }),
};
