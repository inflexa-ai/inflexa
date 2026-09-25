/**
 * The figure gallery: one report document that draws each figure preset from a table of public data, and the
 * loader that resolves its references into the render values.
 *
 * The tables sit under `data/<field>/`, and the repository does not carry them. `bun run gallery:data`
 * (`scripts/gallery-data.sh`) downloads the public sources, runs the scripts of `derive/`, and writes the tables.
 * `manifest.json` names the dataset, the citation, the license, the source, the derivation, the thinning, and
 * the SHA-256 of each table. No build and no test runs the scripts.
 *
 * Each block uses the report grammar alone, as the Report Builder agent writes it: a binding with its pinned
 * hash, the column declarations, the quick path of one chart type, and each statistic, track, and tree as a
 * reference. The loader reads each pinned table, parses it as the production resolver parses a CSV (each cell
 * is text), and runs the resolution pass of the preview over an in-memory snapshot. Thus a hash that no
 * longer matches its file, a column that a table does not hold, and a statistic cell that does not resolve
 * each fail the load.
 *
 * Only the tests and `scripts/render-gallery.ts` read this module, thus `tsconfig.json` excludes the gallery
 * directory the same way that it excludes the design fixture, and the build emits none of it.
 */

import { err, ok, type Result } from "neverthrow";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ArtifactTableReference, ArtifactValueReference, ColumnMeaning } from "../../contracts/report-reference.js";
import type { ChartBlock, ChartTree, ReportDocument, TextBlock } from "../../contracts/report-blocks.js";
import { describeFsError, tryFs } from "../../lib/fs-result.js";
import { computeSha256 } from "../../lib/fs-helpers.js";
import { referencedPaths, walkBlocks } from "../../report-model/block-walk.js";
import { createFixtureResolver } from "../../report-model/fixture-resolver.js";
import { parseDelimited } from "../../report-model/production-resolver.js";
import type { ReportSnapshot } from "../../report-model/reference-resolver.js";
import { resolveDocumentReferences, type ResolutionFailure } from "../../report-model/validate.js";
import type { RenderValues } from "../types.js";
import { bridgeValues, collectResolutions, type BridgeMismatch } from "../value-bridge.js";

/** The directory of the gallery: the data tables and the manifest sit under it. */
export const GALLERY_DIR = fileURLToPath(new URL(".", import.meta.url));

/** The message for an absent data directory: the tables are not in the repository, and a script rebuilds them. */
export const GALLERY_DATA_HINT = "The gallery tables are missing. Run `bun run gallery:data` to download the sources and rebuild them.";

/** Whether the data directory of the gallery exists. The repository does not carry it. */
export function hasGalleryData(dir: string = GALLERY_DIR): boolean {
    return existsSync(join(dir, "data"));
}

/** The declarations of one binding: the display name and the meaning of each column that the page shows. */
interface Declarations {
    readonly labels?: Record<string, string>;
    readonly meanings?: Record<string, ColumnMeaning>;
}

/**
 * The pinned tables of the gallery, keyed by the path under the gallery directory. The hash is the SHA-256 of
 * the bytes of the table, the same value as its manifest entry, thus a changed table fails the load until its pin
 * moves with it.
 */
const PINS = {
    "data/bulk_rnaseq/de_results.csv": "sha256:d38557788fc083093a648572f89fafceb4aba4f34b78464b994aa7f783f22ea2",
    "data/bulk_rnaseq/heatmap_top_genes.csv": "sha256:8566d9d03f1c906e4d4fb51b135e0f4bbd72e53fc37fdcc361b5d97cd97d72de",
    "data/bulk_rnaseq/pca_samples.csv": "sha256:81c8dae8e3a1c03fb36d008129bdda233656751fcc44bf4ecd6c55e3560ae3db",
    "data/bulk_rnaseq/sample_distances.csv": "sha256:32f705e994d3763d86a1191a9f3ff4a55f306d9c267d57f30cf22cc74c870ae9",
    "data/bulk_rnaseq/top_gene_counts.csv": "sha256:b7bdb5252546f8d02eb9182476868944ac1a50a949133b1ea01b31f0dd7db8d6",
    "data/bulk_rnaseq/tree_samples.csv": "sha256:597d66e8d246debc159d975413659d35eb4eaf18e900aefe17ab9df2436bdf90",
    "data/bulk_rnaseq/tree_top_genes_cols.csv": "sha256:5557f29433ec595b8dd0fb3c7a7c705845407b155ff279a7bb3f58621e3644c5",
    "data/bulk_rnaseq/tree_top_genes_rows.csv": "sha256:00442be06720a0c2053ec958c3a3201db17aed6237bd1b756e7e6de4c5fc9898",
    "data/cancer_mut/domains_DNMT3A.csv": "sha256:4c4e5c135fe62246ffc64a5fbb34ea6ef588605a2d0c2f777fde08ad28f1f460",
    "data/cancer_mut/domains_FLT3.csv": "sha256:7b95261a8f15a068dea096cd6ad08acc5bbd42f7f23450d581bca68e4aec4dd6",
    "data/cancer_mut/lollipop_DNMT3A.csv": "sha256:2aba5d19d15edd53aeec4debbf7c26f820f6736a75df829f17608e12f6aa84db",
    "data/cancer_mut/lollipop_FLT3.csv": "sha256:3f307ba4d663e79a23b35471562adfbf5ba24e3ef970bbf45da2d1d217bd0272",
    "data/cancer_mut/mutation_burden.csv": "sha256:893f4feab876331a6d23ef9ac0a4fcdffc96b9db37f6fbcf50a5cee0e5c37502",
    "data/cancer_mut/oncoprint.csv": "sha256:c733319c357281e3bf0e5bee1809855dced7e9fe971d0628836e30bc578f7cd5",
    "data/cancer_mut/sankey_flows.csv": "sha256:5e687a61fe333c19914cec9d268e6a41e2967d47135baea80d7c2a8d34c20412",
    "data/cancer_mut/upset_membership.csv": "sha256:71e96e7cef54a132f52db62279a4e921aad3981e4a6fcc5d56a9204ad7d2d1c4",
    "data/enrichment/gsea_results.csv": "sha256:ca842f4622c865ea4cac38bf4036b03696c130dbc9d3f8454942456d3f0d91d0",
    "data/enrichment/gsea_running_score.csv": "sha256:d4d3f1a08664bccaa74feac3061b1226ffb27efa2c5d6990fbd9d80cd7428eda",
    "data/enrichment/ora_results.csv": "sha256:309d8110fd02d150bc4ddb4de1e8fa9faa5a66c910d8df4c07757de4e4e09f17",
    "data/gwas/locus_fto.csv": "sha256:07a7f3bfea733ca0cd342275d8dd84f31881d4841f622f60b905072f99f74859",
    "data/gwas/locus_fto_genes.csv": "sha256:a63774a403e5154c373d637cb86b1909c2656a83a3ff4c9501e75a3e49f788f7",
    "data/gwas/manhattan.csv": "sha256:bd0cb9d64d071a87d4e0adc18e3940fac57c4553a69d4a5200f98e470d329c48",
    "data/gwas/qq.csv": "sha256:1054cc76490d3b061b5ce80106542c57f4bc7cddcb4ee2bc20d951ce5f9d464b",
    "data/gwas/qq_summary.csv": "sha256:b34865f87de5946965b7bcc9bc392d7b8a7690199e3b489b741547ffc6fd2628",
    "data/singlecell/cells.csv": "sha256:c26f13189d5b95f512227a2063701231e27041dc501265b0515f64cbeff105e2",
    "data/singlecell/cells_by_condition_umap.csv": "sha256:c3434d4425ac92306c67da966847db0014193b1973c46b54bb2bc12625cb8a90",
    "data/singlecell/composition.csv": "sha256:2f0c8a36d2240d16964b20436e90e86fa6ae5453a553b806320c285f2479617d",
    "data/singlecell/marker_dotplot.csv": "sha256:34959c80f988b1bd7ef19416f1f34febfaf39509aa96b51ebced33331a560345",
    "data/survival/cox_forest.csv": "sha256:ed02ea350b6384a7083b37a8c8a5b8fec7f219c202a6c7790e24526918b85946",
    "data/survival/km_curve.csv": "sha256:e907cec595367a913503c3daac21ffd3c4fa2032f11ec1bffb93f889c9daf203",
    "data/survival/km_risk_table.csv": "sha256:3e9889f31c9f48d433374eaeffd2d88e80611420918657f89c9e3e9681a745f0",
    "data/survival/km_summary.csv": "sha256:28a5fb766bad49fefaf87d526afa7debd9c801c3c93b1e72d9670e8539d2d160",
    "data/survival/logrank.csv": "sha256:e2a180342c97aa188cb953d533f0d375e61dda15e9899d5dd66703ef33849529",
    "data/survival/roc.csv": "sha256:34f1d88624f8f19bfbf7efcef18cd3894e48f5d42179ca16f19f483597d9b74b",
    "data/survival/roc_auc.csv": "sha256:18786d8c99a9d05b42cd3332e76eaccdbeb396669f3a6bb5948de936d234a467",
} as const;

/** The path of one pinned table. */
type PinnedPath = keyof typeof PINS;

/** One whole-table binding of a pinned table, with its declarations and an optional row bound. */
function table(path: PinnedPath, declarations: Declarations = {}, rowBound?: ArtifactTableReference["rowBound"]): ArtifactTableReference {
    return {
        kind: "artifact-table",
        path,
        hash: PINS[path],
        ...(rowBound !== undefined ? { rowBound } : {}),
        ...(declarations.labels !== undefined ? { columnLabels: declarations.labels } : {}),
        ...(declarations.meanings !== undefined ? { columnMeanings: declarations.meanings } : {}),
    };
}

/** One cell of a pinned table: the column, and the row where another column equals a value. */
function cell(path: PinnedPath, column: string, where: { column: string; value: string } | number): ArtifactValueReference {
    const locator = typeof where === "number" ? { column, row: where } : { column, rowFilter: { column: where.column, op: "eq" as const, value: where.value } };
    return { kind: "artifact-value", path, hash: PINS[path], locator };
}

/** The tree of one heatmap axis: an edge table of the clustering, with the parent, the child, and the merge height of each edge. */
function tree(path: PinnedPath): ChartTree {
    return { binding: table(path), parent: "parent", child: "child", height: "height" };
}

/** One text block that tells the reader what the next chart shows. */
function note(id: string, prose: string): TextBlock {
    return { kind: "text", id, content: { prose } };
}

/** The attribution of each dataset, as the caption of each chart that reads it states it. */
const PASILLA = "Data: pasilla RNA-seq (Brooks et al., Genome Research, 2011), from the Bioconductor pasilla package, LGPL.";
const PASILLA_GO =
    "Data: pasilla RNA-seq (Brooks et al., Genome Research, 2011, LGPL) against the Gene Ontology biological process sets for the fly (Gene Ontology Consortium, CC BY 4.0).";
const PBMC =
    "Data: 3k PBMCs from a healthy donor (10x Genomics, 2016, CC BY 4.0), as the scanpy clustering tutorial processed them (Wolf et al., Genome Biology, 2018).";
const KANG = "Data: IFN-β stimulated and control PBMCs (Kang et al., Nature Biotechnology, 2018; GEO GSE96583, public domain), from pertpy.";
const LUNG = "Data: NCCTG lung cancer data (Loprinzi et al., Journal of Clinical Oncology, 1994), from the R survival package, LGPL (>= 2).";
const BMI =
    "Data: body mass index GWAS of the GIANT consortium (Locke et al., Nature, 2015), GWAS Catalog GCST002783, harmonised summary statistics under the EBI Terms of Use.";
const LAML = "Data: TCGA acute myeloid leukemia somatic mutations (Ley et al., NEJM, 2013), from the maftools example MAF, MIT.";
const LAML_CLINICAL =
    "Data: TCGA acute myeloid leukemia somatic mutations and clinical annotation (Ley et al., NEJM, 2013), from the maftools example MAF and its annotation, MIT.";
const FTO_LOCUS =
    "Data: body mass index GWAS of the GIANT consortium (Locke et al., Nature, 2015), GWAS Catalog GCST002783, EBI Terms of Use. " +
    "r² with rs1421085 from the 1000 Genomes EUR haplotypes (open reuse), recombination rate from the HapMap GRCh38 map of Beagle (GPL), genes from NCBI RefSeq through the UCSC Genome Browser (public domain).";
const UNIPROT = "Protein domains: UniProtKB (UniProt Consortium, Nucleic Acids Research, 2025), CC BY 4.0.";

/** The declarations of the differential expression table, shared by the volcano and the MA plot. */
const DE_DECLARATIONS: Declarations = {
    labels: { log2FoldChange: "log2 fold change", padj: "Adjusted p-value", baseMean: "Mean of normalized counts", gene_symbol: "Gene" },
    meanings: { log2FoldChange: "effect", padj: "p-value", pvalue: "p-value", gene_id: "identifier" },
};

/** The declarations of the PBMC 3k cell table, shared by each chart of the cells. */
const CELL_DECLARATIONS: Declarations = {
    labels: {
        UMAP_1: "UMAP 1",
        UMAP_2: "UMAP 2",
        cluster: "Cell type",
        LYZ: "LYZ expression (log1p)",
        n_genes: "Genes detected per cell",
        total_counts: "UMI counts per cell",
        pct_counts_mt: "Mitochondrial counts (%)",
    },
    meanings: { cluster: "category", n_genes: "count", total_counts: "count", cell_id: "identifier" },
};

/** The declarations of the marker table, shared by the dot plot and the radar. */
const MARKER_DECLARATIONS: Declarations = {
    labels: {
        cluster: "Cell type",
        gene: "Marker gene",
        fraction_expressing: "Fraction of cells expressing",
        mean_expression_scaled: "Mean expression (scaled)",
    },
    meanings: { cluster: "category", gene: "category" },
};

/** The declarations of the Kang composition table, shared by the two stacked forms. */
const COMPOSITION_DECLARATIONS: Declarations = {
    labels: { sample: "Donor", condition: "Condition", cell_type: "Cell type", n_cells: "Cells" },
    meanings: { sample: "identifier", n_cells: "count" },
};

/** The declarations of the Kaplan-Meier table. */
const KM_DECLARATIONS: Declarations = {
    labels: { time: "Days", surv: "Survival probability", strata: "Sex", n_risk: "Number at risk" },
    meanings: { n_risk: "count", n_event: "count", n_censor: "count", strata: "category" },
};

/** One lollipop of the LAML mutations, with the UniProt domains of its gene as the track. */
function lollipop(id: string, gene: "DNMT3A" | "FLT3", title: string, caption: string): ChartBlock {
    return {
        kind: "chart",
        id,
        title,
        binding: table(`data/cancer_mut/lollipop_${gene}.csv`, {
            labels: { aa_position: "Amino-acid position", count: "Mutations", variant_classification: "Mutation class", protein_change: "Protein change" },
            meanings: { count: "count", aa_position: "count" },
        }),
        chartType: "lollipop",
        encoding: { x: "aa_position", y: "count", group: "variant_classification", label: "protein_change" },
        track: {
            binding: table(`data/cancer_mut/domains_${gene}.csv`, {
                labels: { name: "Domain" },
                meanings: { start: "count", end: "count", protein_length: "count" },
            }),
            start: "start",
            end: "end",
            label: "name",
            length: "protein_length",
        },
        caption,
    };
}

const BULK_SECTION: ReportDocument["sections"][number] = {
    kind: "section",
    id: "bulk",
    title: "Bulk RNA-seq",
    blocks: [
        note(
            "bulk-intro",
            "The pasilla experiment knocks down the splicing factor pasilla in Drosophila S2 cells by RNAi and compares the treated cells with untreated cells. DESeq2 tested each gene that passed the low-count filter.",
        ),
        note(
            "bulk-volcano-note",
            "The volcano plot puts the fold change of each gene against its adjusted p-value. The genes past both cuts carry the color of their side, and the most significant ones carry their names.",
        ),
        {
            kind: "chart",
            id: "bulk-volcano",
            title: "Knock-down of pasilla against untreated cells",
            binding: table("data/bulk_rnaseq/de_results.csv", DE_DECLARATIONS),
            chartType: "volcano",
            encoding: { x: "log2FoldChange", y: "padj", label: "gene_symbol" },
            thresholds: { significance: 0.05, effect: 1 },
            caption: PASILLA,
        },
        note(
            "bulk-ma-note",
            "The MA plot puts the fold change of each gene against its mean count. A gene under the significance cut draws in blue, and the mean axis is logarithmic.",
        ),
        {
            kind: "chart",
            id: "bulk-ma",
            title: "Fold change against mean count",
            binding: table("data/bulk_rnaseq/de_results.csv", DE_DECLARATIONS),
            chartType: "ma",
            encoding: { x: "baseMean", y: "log2FoldChange", p: "padj" },
            thresholds: { significance: 0.05 },
            caption: PASILLA,
        },
        note(
            "bulk-pca-note",
            "The PCA plot places each sample on the first two principal components of the most variable genes. The condition sets the color, and the library type sets the symbol.",
        ),
        {
            kind: "chart",
            id: "bulk-pca",
            title: "Samples on the first two principal components",
            binding: table("data/bulk_rnaseq/pca_samples.csv", {
                labels: { PC1: "PC1: 57% of variance", PC2: "PC2: 30% of variance", condition: "Condition", type: "Library type", sample: "Sample" },
                meanings: { condition: "category", type: "category", sample: "identifier" },
            }),
            chartType: "pca",
            encoding: { x: "PC1", y: "PC2", group: "condition", shape: "type", label: "sample" },
            caption: PASILLA,
        },
        note(
            "bulk-distance-note",
            "The sample-distance heatmap shows the Euclidean distance between each pair of samples. One dendrogram of a hierarchical clustering orders both axes, and the treated samples group together.",
        ),
        {
            kind: "chart",
            id: "bulk-distances",
            title: "Distances between the samples",
            binding: table("data/bulk_rnaseq/sample_distances.csv", {
                labels: { sample_a: "Sample", sample_b: "Sample", distance: "Euclidean distance" },
                meanings: { sample_a: "category", sample_b: "category" },
            }),
            chartType: "heatmap",
            encoding: { x: "sample_b", y: "sample_a", value: "distance" },
            trees: { x: tree("data/bulk_rnaseq/tree_samples.csv"), y: tree("data/bulk_rnaseq/tree_samples.csv") },
            caption: PASILLA,
        },
        note(
            "bulk-heatmap-note",
            "The heatmap shows the row z-score of the most significant genes in each sample. The dendrograms of a hierarchical clustering order the genes and the samples, and the strips over the matrix name the condition and the library type of each sample.",
        ),
        {
            kind: "chart",
            id: "bulk-top-genes",
            title: "Top differentially expressed genes",
            binding: table("data/bulk_rnaseq/heatmap_top_genes.csv", {
                labels: { gene_symbol: "Gene", sample: "Sample", zscore: "Row z-score", condition: "Condition", type: "Library type" },
                meanings: { gene_symbol: "category", sample: "category", condition: "category", type: "category" },
            }),
            chartType: "heatmap",
            encoding: { x: "sample", y: "gene_symbol", value: "zscore", tracks: ["condition", "type"] },
            trees: { x: tree("data/bulk_rnaseq/tree_top_genes_cols.csv"), y: tree("data/bulk_rnaseq/tree_top_genes_rows.csv") },
            caption: PASILLA,
        },
        note(
            "bulk-counts-note",
            "The box plot shows the normalized count of the most significant genes in each condition, on a logarithmic scale. Each gene differs between the two conditions.",
        ),
        {
            kind: "chart",
            id: "bulk-counts",
            title: "Normalized counts of the top genes",
            binding: table("data/bulk_rnaseq/top_gene_counts.csv", {
                labels: { gene_symbol: "Gene", normalized_count: "Normalized count", condition: "Condition" },
                meanings: { gene_symbol: "category", condition: "category" },
            }),
            chartType: "box",
            encoding: { x: "gene_symbol", y: { column: "normalized_count", transform: "log10" }, group: "condition" },
            caption: PASILLA,
        },
    ],
};

const ENRICHMENT_SECTION: ReportDocument["sections"][number] = {
    kind: "section",
    id: "enrichment",
    title: "Gene Set Enrichment",
    blocks: [
        note(
            "enrichment-intro",
            "The enrichment tests read the same differential expression result against the Gene Ontology biological process sets of the fly. The over-representation test reads the significant genes, and GSEA reads the whole ranked list.",
        ),
        note(
            "enrichment-ora-note",
            "The dot plot shows the most significant sets of the over-representation test. The position gives the gene ratio, the size gives the overlap, and the color gives the adjusted p-value.",
        ),
        {
            kind: "chart",
            id: "enrichment-ora",
            title: "Over-represented biological processes",
            binding: table(
                "data/enrichment/ora_results.csv",
                {
                    labels: { term: "GO biological process", gene_ratio: "Gene ratio", overlap: "Genes in the set", padj: "Adjusted p-value" },
                    meanings: { padj: "p-value", pvalue: "p-value", overlap: "count", set_size: "count", term: "category" },
                },
                { column: "padj", count: 15, order: "asc" },
            ),
            chartType: "dotplot",
            encoding: { y: { column: "term", orderBy: "gene_ratio", order: "desc" }, x: "gene_ratio", size: "overlap", color: "padj" },
            caption: PASILLA_GO,
        },
        note(
            "enrichment-nes-note",
            "The bar chart shows the normalized enrichment score of the sets with the smallest FDR. A positive score marks a set at the top of the ranked list, and a negative score marks a set at the bottom.",
        ),
        {
            kind: "chart",
            id: "enrichment-nes",
            title: "Normalized enrichment scores",
            binding: table(
                "data/enrichment/gsea_results.csv",
                {
                    labels: { term: "GO biological process", NES: "Normalized enrichment score", fdr: "FDR" },
                    meanings: { NES: "effect", ES: "effect", fdr: "p-value", pvalue: "p-value", term: "category" },
                },
                { column: "fdr", count: 25, order: "asc" },
            ),
            chartType: "bar",
            orientation: "horizontal",
            encoding: { x: { column: "term", orderBy: "NES", order: "desc" }, y: "NES", color: "NES" },
            caption: PASILLA_GO,
        },
        note(
            "enrichment-gsea-note",
            "The GSEA plot shows the running enrichment score of the three strongest sets along the ranked list, a tick at each member of each set, and the ranking statistic under them. The other two sets reach the floor of the permutation FDR.",
        ),
        {
            kind: "chart",
            id: "enrichment-gsea",
            title: "Running enrichment score of the top sets",
            binding: table("data/enrichment/gsea_running_score.csv", {
                labels: { rank: "Rank in the ordered gene list", running_es: "Running enrichment score", ranked_metric: "Wald statistic", term: "Gene set" },
                meanings: { term: "category", rank: "count" },
            }),
            chartType: "gsea",
            encoding: { x: "rank", y: "running_es", group: "term", hit: "hit", metric: "ranked_metric" },
            statistics: [
                {
                    label: "NES, cell-cell junction assembly",
                    value: cell("data/enrichment/gsea_results.csv", "NES", { column: "term", value: "cell-cell junction assembly (GO:0007043)" }),
                },
                {
                    label: "NES, septate junction assembly",
                    value: cell("data/enrichment/gsea_results.csv", "NES", { column: "term", value: "septate junction assembly (GO:0019991)" }),
                },
                {
                    label: "NES, apical junction assembly",
                    value: cell("data/enrichment/gsea_results.csv", "NES", { column: "term", value: "apical junction assembly (GO:0043297)" }),
                },
                {
                    label: "FDR, apical junction assembly",
                    value: cell("data/enrichment/gsea_results.csv", "fdr", { column: "term", value: "apical junction assembly (GO:0043297)" }),
                },
            ],
            caption: PASILLA_GO,
        },
    ],
};

const SINGLE_CELL_SECTION: ReportDocument["sections"][number] = {
    kind: "section",
    id: "single-cell",
    title: "Single Cell",
    blocks: [
        note(
            "single-cell-intro",
            "The PBMC data of the scanpy tutorial are the blood cells of one healthy donor. The Kang data compare the blood cells of lupus patients before and after a stimulation with interferon beta.",
        ),
        note(
            "single-cell-clusters-note",
            "The UMAP embedding places each cell by its expression profile. Each cell type carries its name at the middle of its cells.",
        ),
        {
            kind: "chart",
            id: "single-cell-clusters",
            title: "Cell types of the PBMC 3k data",
            binding: table("data/singlecell/cells.csv", CELL_DECLARATIONS),
            chartType: "embedding",
            encoding: { x: "UMAP_1", y: "UMAP_2", group: "cluster" },
            caption: PBMC,
        },
        note(
            "single-cell-lyz-note",
            "The same embedding colors each cell by its LYZ expression. The monocytes and the dendritic cells express LYZ, and a cell with no expression draws in light gray.",
        ),
        {
            kind: "chart",
            id: "single-cell-lyz",
            title: "LYZ expression over the embedding",
            binding: table("data/singlecell/cells.csv", CELL_DECLARATIONS),
            chartType: "embedding",
            encoding: { x: "UMAP_1", y: "UMAP_2", color: "LYZ" },
            caption: PBMC,
        },
        note(
            "single-cell-markers-note",
            "The dot plot shows the canonical marker genes in each cell type. The size gives the fraction of cells that express the gene, and the color gives the scaled mean expression.",
        ),
        {
            kind: "chart",
            id: "single-cell-markers",
            title: "Marker genes by cell type",
            binding: table("data/singlecell/marker_dotplot.csv", MARKER_DECLARATIONS),
            chartType: "dotplot",
            encoding: { y: "cluster", x: "gene", size: "fraction_expressing", color: "mean_expression_scaled" },
            caption: PBMC,
        },
        note(
            "single-cell-profile-note",
            "The radar chart shows the scaled marker profile of each cell type. The CD14 monocytes and the B cells carry the focus color.",
        ),
        {
            kind: "chart",
            id: "single-cell-profile",
            title: "Marker profile by cell type",
            binding: table("data/singlecell/marker_dotplot.csv", MARKER_DECLARATIONS),
            chartType: "radar",
            encoding: { x: "gene", y: "mean_expression_scaled", group: "cluster" },
            focus: ["CD14 Monocytes", "B"],
            caption: PBMC,
        },
        note(
            "single-cell-qc-note",
            "The quality control of the cells reads three measures in each cell type: the genes detected, the UMI counts, and the share of mitochondrial counts.",
        ),
        {
            kind: "chart",
            id: "single-cell-qc-genes",
            title: "Genes detected per cell",
            binding: table("data/singlecell/cells.csv", CELL_DECLARATIONS),
            chartType: "violin",
            encoding: { x: "cluster", y: "n_genes" },
            caption: PBMC,
        },
        {
            kind: "chart",
            id: "single-cell-qc-counts",
            title: "UMI counts per cell",
            binding: table("data/singlecell/cells.csv", CELL_DECLARATIONS),
            chartType: "violin",
            encoding: { x: "cluster", y: "total_counts" },
            caption: PBMC,
        },
        {
            kind: "chart",
            id: "single-cell-qc-mito",
            title: "Mitochondrial counts per cell",
            binding: table("data/singlecell/cells.csv", CELL_DECLARATIONS),
            chartType: "violin",
            encoding: { x: "cluster", y: "pct_counts_mt" },
            caption: PBMC,
        },
        note(
            "single-cell-qc-scatter-note",
            "The scatter plot puts the genes detected against the UMI counts of each cell, with the share of mitochondrial counts as the color.",
        ),
        {
            kind: "chart",
            id: "single-cell-qc-scatter",
            title: "Genes detected against UMI counts",
            binding: table("data/singlecell/cells.csv", CELL_DECLARATIONS),
            chartType: "scatter",
            encoding: { x: "total_counts", y: "n_genes", color: "pct_counts_mt" },
            caption: PBMC,
        },
        note(
            "single-cell-composition-note",
            "The normalized bars show the share of each cell type in each donor, with one panel for each condition. The stacked bars show the same cells as counts.",
        ),
        {
            kind: "chart",
            id: "single-cell-composition",
            title: "Cell-type composition by donor",
            binding: table("data/singlecell/composition.csv", {
                labels: { ...COMPOSITION_DECLARATIONS.labels, n_cells: "Share of cells" },
                meanings: COMPOSITION_DECLARATIONS.meanings,
            }),
            chartType: "normalized-bar",
            encoding: { x: "sample", y: "n_cells", group: "cell_type", facet: "condition" },
            caption: KANG,
        },
        {
            kind: "chart",
            id: "single-cell-counts",
            title: "Cells by donor",
            binding: table("data/singlecell/composition.csv", COMPOSITION_DECLARATIONS),
            chartType: "stacked-bar",
            encoding: { x: "sample", y: "n_cells", group: "cell_type", facet: "condition" },
            caption: KANG,
        },
        note(
            "single-cell-isg15-note",
            "The embedding of the Kang cells colors each cell by its ISG15 expression, with one panel for each condition. The interferon response raises ISG15 in each cell type.",
        ),
        {
            kind: "chart",
            id: "single-cell-isg15",
            title: "ISG15 expression by condition",
            binding: table("data/singlecell/cells_by_condition_umap.csv", {
                labels: { UMAP_1: "UMAP 1", UMAP_2: "UMAP 2", ISG15: "ISG15 expression (log1p)", condition: "Condition" },
                meanings: { condition: "category", cell_type: "category", cell_id: "identifier" },
            }),
            chartType: "embedding",
            encoding: { x: "UMAP_1", y: "UMAP_2", color: "ISG15", facet: "condition" },
            caption: KANG,
        },
    ],
};

const CLINICAL_SECTION: ReportDocument["sections"][number] = {
    kind: "section",
    id: "clinical",
    title: "Clinical Outcomes",
    blocks: [
        note(
            "clinical-intro",
            "The NCCTG lung cancer data follow patients with advanced lung cancer until death or the end of the follow-up. The charts compare the two sexes and model the risk of death.",
        ),
        note(
            "clinical-km-note",
            "The Kaplan-Meier plot shows the survival of each sex, with the confidence band, a tick at each censored patient, the median survival, and the number at risk under the plot.",
        ),
        {
            kind: "chart",
            id: "clinical-km",
            title: "Overall survival by sex",
            binding: table("data/survival/km_curve.csv", KM_DECLARATIONS),
            chartType: "km",
            encoding: { x: "time", y: "surv", group: "strata", low: "lower", high: "upper", censor: "n_censor", risk: "n_risk" },
            statistics: [{ label: "Log-rank p", value: cell("data/survival/logrank.csv", "pvalue", 0) }],
            caption: LUNG,
        },
        note("clinical-risk-note", "The line chart shows the number of patients at risk of each sex at each hundred days of follow-up."),
        {
            kind: "chart",
            id: "clinical-risk",
            title: "Patients at risk over the follow-up",
            binding: table("data/survival/km_risk_table.csv", KM_DECLARATIONS),
            chartType: "line",
            encoding: { x: "time", y: "n_risk", group: "strata" },
            caption: LUNG,
        },
        note("clinical-sex-note", "The pie chart shows the share of each sex in the cohort."),
        {
            kind: "chart",
            id: "clinical-sex",
            title: "Patients by sex",
            binding: table("data/survival/km_summary.csv", { labels: { strata: "Sex", n: "Patients" }, meanings: { n: "count", events: "count" } }),
            chartType: "pie",
            encoding: { group: "strata", value: "n" },
            caption: LUNG,
        },
        note(
            "clinical-forest-note",
            "The forest plot shows the hazard ratio of each covariate of a Cox model, with its confidence interval and its p-value. A ratio under one lowers the risk of death.",
        ),
        {
            kind: "chart",
            id: "clinical-forest",
            title: "Hazard ratios of the Cox model",
            binding: table("data/survival/cox_forest.csv", {
                labels: { term: "Covariate", hr: "Hazard ratio", pvalue: "p" },
                meanings: { hr: "effect", pvalue: "p-value", term: "category", n: "count" },
            }),
            chartType: "forest",
            encoding: { y: "term", x: "hr", low: "lower", high: "upper", p: "pvalue" },
            caption: LUNG,
        },
        note(
            "clinical-roc-note",
            "The ROC plot shows how well two logistic models predict death within a year. The full model adds the Karnofsky score and the age to the ECOG score.",
        ),
        {
            kind: "chart",
            id: "clinical-roc",
            title: "Prediction of death within a year",
            binding: table("data/survival/roc.csv", {
                labels: { fpr: "False positive rate", tpr: "True positive rate", model: "Model" },
                meanings: { model: "category" },
            }),
            chartType: "roc",
            encoding: { x: "fpr", y: "tpr", group: "model" },
            statistics: [
                { label: "AUC, ECOG + Karnofsky + age", value: cell("data/survival/roc_auc.csv", "auc", { column: "model", value: "ECOG + Karnofsky + age" }) },
                { label: "AUC, ECOG alone", value: cell("data/survival/roc_auc.csv", "auc", { column: "model", value: "ECOG alone" }) },
            ],
            caption: LUNG,
        },
    ],
};

const GWAS_SECTION: ReportDocument["sections"][number] = {
    kind: "section",
    id: "gwas",
    title: "Genome-Wide Association",
    blocks: [
        note("gwas-intro", "The GIANT consortium tested the association of each common variant with the body mass index."),
        note(
            "gwas-manhattan-note",
            "The Manhattan plot shows the p-value of each variant along the genome. The two lines mark the genome-wide and the suggestive cut, and the lead variants carry their names.",
        ),
        {
            kind: "chart",
            id: "gwas-manhattan",
            title: "Association with the body mass index",
            binding: table("data/gwas/manhattan.csv", {
                labels: { cum_pos: "Chromosome", pvalue: "p-value", chrom: "Chromosome", snp: "Variant" },
                meanings: { pvalue: "p-value", chrom: "category", snp: "identifier", pos: "identifier", cum_pos: "identifier" },
            }),
            chartType: "manhattan",
            encoding: { x: "cum_pos", y: "pvalue", group: "chrom", label: "snp" },
            caption: BMI,
        },
        note(
            "gwas-qq-note",
            "The QQ plot puts the observed p-values against the p-values that the null expects, with the confidence band of the null. The genomic inflation factor prints in the corner.",
        ),
        {
            kind: "chart",
            id: "gwas-qq",
            title: "Observed against expected p-values",
            binding: table("data/gwas/qq.csv", {
                labels: { expected_neg_log10_p: "Expected -log10 p", observed_neg_log10_p: "Observed -log10 p" },
            }),
            chartType: "qq",
            encoding: { x: "expected_neg_log10_p", y: "observed_neg_log10_p", low: "ci_lower", high: "ci_upper" },
            statistics: [{ label: "λ", value: cell("data/gwas/qq_summary.csv", "lambda_gc", 0) }],
            caption: BMI,
        },
        note(
            "gwas-locuszoom-note",
            "The regional association plot zooms into the FTO locus, the strongest signal of the study. The color of each variant gives its linkage disequilibrium with the lead variant, the blue line gives the recombination rate, and the genes of the region sit under the plot.",
        ),
        {
            kind: "chart",
            id: "gwas-locuszoom",
            title: "Association at the FTO locus",
            binding: table("data/gwas/locus_fto.csv", {
                labels: {
                    position: "Position on chr16 (bp)",
                    pvalue: "p-value",
                    r2: "r² with rs1421085",
                    recomb_rate: "Recombination rate (cM/Mb)",
                    variant: "Variant",
                },
                meanings: { pvalue: "p-value", variant: "identifier", position: "identifier" },
            }),
            chartType: "locuszoom",
            encoding: { x: "position", y: "pvalue", color: "r2", label: "variant", metric: "recomb_rate" },
            track: {
                binding: table("data/gwas/locus_fto_genes.csv", { labels: { gene: "Gene" }, meanings: { start: "identifier", end: "identifier" } }),
                start: "start",
                end: "end",
                label: "gene",
            },
            caption: FTO_LOCUS,
        },
    ],
};

const MUTATION_SECTION: ReportDocument["sections"][number] = {
    kind: "section",
    id: "mutations",
    title: "Somatic Mutations",
    blocks: [
        note(
            "mutations-intro",
            "The TCGA acute myeloid leukemia cohort gives the somatic mutations of each tumor. The charts show the most mutated genes, their co-mutation, the path of the patients from the subtype to the outcome, the mutation burden, and the hotspots of two genes.",
        ),
        note(
            "mutations-oncoprint-note",
            "The oncoprint shows the mutation class of each frequent gene in each sample. The bar over the matrix counts the mutations of each sample, and the bar at the right gives the share of samples with a mutation in each gene.",
        ),
        {
            kind: "chart",
            id: "mutations-oncoprint",
            title: "Frequently mutated genes",
            binding: table("data/cancer_mut/oncoprint.csv", {
                labels: { gene: "Gene", sample: "Sample", variant_classification: "Mutation class" },
                meanings: { gene: "category", sample: "identifier", variant_classification: "category" },
            }),
            chartType: "oncoprint",
            encoding: { x: { column: "sample", orderBy: "sample_rank" }, y: { column: "gene", orderBy: "gene_rank" }, value: "variant_classification" },
            caption: LAML,
        },
        note(
            "mutations-upset-note",
            "The UpSet plot counts the tumors of each exact combination of the most mutated genes. The bars over the matrix give the size of each combination, and the bars at the left give the tumors of each gene.",
        ),
        {
            kind: "chart",
            id: "mutations-upset",
            title: "Co-mutation of the most mutated genes",
            binding: table("data/cancer_mut/upset_membership.csv", {
                labels: { sample: "Tumor", gene: "Gene" },
                meanings: { sample: "identifier", gene: "category" },
            }),
            chartType: "upset",
            encoding: { x: "sample", group: "gene" },
            caption: LAML,
        },
        note(
            "mutations-sankey-note",
            "The Sankey diagram follows each patient from the FAB subtype of the leukemia to the FLT3 status of the tumor, and then to the vital status at the last follow-up.",
        ),
        {
            kind: "chart",
            id: "mutations-sankey",
            title: "Patients by FAB subtype, FLT3 status, and vital status",
            binding: table("data/cancer_mut/sankey_flows.csv", {
                labels: { source: "From", target: "To", value: "Patients" },
                meanings: { source: "category", target: "category", value: "count" },
            }),
            chartType: "sankey",
            encoding: { x: "source", y: "target", value: "value" },
            caption: LAML_CLINICAL,
        },
        note("mutations-burden-note", "The histogram shows the count of somatic mutations in each tumor. Most tumors carry few mutations."),
        {
            kind: "chart",
            id: "mutations-burden",
            title: "Mutation burden",
            binding: table("data/cancer_mut/mutation_burden.csv", {
                labels: { n_mutations: "Somatic mutations per tumor" },
                meanings: { n_mutations: "count", sample: "identifier" },
            }),
            chartType: "histogram",
            encoding: { x: "n_mutations" },
            caption: LAML,
        },
        note(
            "mutations-dnmt3a-note",
            "The lollipop plot shows each mutation of DNMT3A at its position on the protein, over the domains of the protein. The R882 hotspot lies in the methyltransferase domain.",
        ),
        lollipop("mutations-dnmt3a", "DNMT3A", "Mutations of DNMT3A", `${LAML} ${UNIPROT}`),
        note(
            "mutations-flt3-note",
            "The FLT3 plot shows the internal tandem duplications near the juxtamembrane region and the D835 hotspot of the kinase domain.",
        ),
        lollipop("mutations-flt3", "FLT3", "Mutations of FLT3", `${LAML} ${UNIPROT}`),
    ],
};

/** The gallery document. Each block id is stable, thus two renders give the same bytes. */
export const GALLERY_DOCUMENT: ReportDocument = {
    title: "Canonical Figures on Public Data",
    sections: [BULK_SECTION, ENRICHMENT_SECTION, SINGLE_CELL_SECTION, CLINICAL_SECTION, GWAS_SECTION, MUTATION_SECTION],
};

/** One fault of the load: a table that did not read or parse, a reference that did not resolve, or a value of the wrong type. */
export type GalleryFault =
    { kind: "unreadable"; path: string; detail: string } | { kind: "unresolved"; failure: ResolutionFailure } | { kind: "mismatch"; mismatch: BridgeMismatch };

/** The pinned evidence of the gallery and the render values that it resolves to. */
export interface GalleryLoad {
    readonly snapshot: ReportSnapshot;
    readonly values: RenderValues;
}

/**
 * Read each table that the document binds, and build the snapshot that the resolver reads.
 *
 * The hash is the hash of the bytes on disk, and not the pin of the document. Thus the resolver compares the
 * pin against the file exactly as the production resolver does.
 */
async function readSnapshot(dir: string): Promise<Result<ReportSnapshot, GalleryFault[]>> {
    const faults: GalleryFault[] = [];
    const artifacts: ReportSnapshot["artifacts"] = {};
    const paths = [...referencedPaths(walkBlocks(GALLERY_DOCUMENT.sections).references)].sort();
    for (const path of paths) {
        const bytes = await tryFs("gallery.readTable", () => readFile(join(dir, path)), { path });
        if (bytes.isErr()) {
            faults.push({ kind: "unreadable", path, detail: describeFsError(bytes.error) });
            continue;
        }
        const rows = parseDelimited(bytes.value.toString("utf8"), ",");
        if (rows === undefined) {
            faults.push({ kind: "unreadable", path, detail: "the CSV parser found a structural fault" });
            continue;
        }
        artifacts[path] = { hash: computeSha256(bytes.value), fileType: "output", rows };
    }
    return faults.length > 0 ? err(faults) : ok({ artifacts });
}

/**
 * Load the gallery: read each pinned table, resolve each reference of the document, and bridge the resolved
 * values into the render values of `renderReportPage`.
 *
 * The pass is the resolution pass of the preview with the in-memory resolver, thus each statistic, each
 * track, and each tree resolves as it resolves in a session. The document binds no figure, thus the figure policy never
 * runs.
 */
export async function loadGallery(dir: string = GALLERY_DIR): Promise<Result<GalleryLoad, GalleryFault[]>> {
    const snapshot = await readSnapshot(dir);
    if (snapshot.isErr()) {
        return err(snapshot.error);
    }
    const { resolvedByBlock, resolvedBySlot, failures } = await resolveDocumentReferences(GALLERY_DOCUMENT.sections, snapshot.value, createFixtureResolver());
    if (failures.length > 0) {
        return err(failures.map((failure): GalleryFault => ({ kind: "unresolved", failure })));
    }
    const values = bridgeValues(collectResolutions(GALLERY_DOCUMENT.sections, resolvedByBlock, resolvedBySlot), (file) => file.path);
    if (values.isErr()) {
        return err(values.error.map((mismatch): GalleryFault => ({ kind: "mismatch", mismatch })));
    }
    return ok({ snapshot: snapshot.value, values: values.value });
}
