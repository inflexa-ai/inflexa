#!/usr/bin/env Rscript
# tpl-deseq2-two-group — DESeq2 two-group differential expression.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: DESeq2 negative binomial GLM, Wald test on the condition coefficient,
# median-of-ratios size factors, independent filtering at alpha, and shrinkage
# of the reported log2 fold change (Love et al. 2014; Zhu et al. 2019).
#
# Import: the branch on IMPORT_STATE. Transcript quantifications reach the model
# through tximport with the average transcript length per gene and sample as
# the offset (Soneson et al. 2015); count estimates with a length table take
# the same offset; corrected or integer counts take no offset; an unknown
# state stops and names the missing input.

suppressPackageStartupMessages({
  library(DESeq2)
  library(ggplot2)
  library(pheatmap)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
IMPORT_STATE     <- {{import_state}}  # [adaptable: import_state]
{{#if counts_path}}
COUNTS_PATH      <- {{counts_path}}  # [adaptable: counts_path]
{{/if}}
{{#unless counts_path}}
COUNTS_PATH      <- NULL  # [adaptable: counts_path] NULL: the quantifications state takes quant_dir
{{/unless}}
{{#if quant_dir}}
QUANT_DIR        <- {{quant_dir}}  # [adaptable: quant_dir]
{{/if}}
{{#unless quant_dir}}
QUANT_DIR        <- NULL  # [adaptable: quant_dir] NULL: the state is not quantifications
{{/unless}}
{{#if tx2gene_path}}
TX2GENE_PATH     <- {{tx2gene_path}}  # [adaptable: tx2gene_path]
{{/if}}
{{#unless tx2gene_path}}
TX2GENE_PATH     <- NULL  # [adaptable: tx2gene_path] NULL: the state is not quantifications
{{/unless}}
{{#if lengths_path}}
LENGTHS_PATH     <- {{lengths_path}}  # [adaptable: lengths_path]
{{/if}}
{{#unless lengths_path}}
LENGTHS_PATH     <- NULL  # [adaptable: lengths_path] NULL: the state is not estimated_counts_with_lengths
{{/unless}}
COUNTS_FROM_ABUNDANCE <- {{counts_from_abundance}}  # [adaptable: counts_from_abundance]
LENGTH_OFFSET    <- {{length_offset}}  # [adaptable: length_offset]
METADATA_PATH    <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN <- {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN <- {{condition_column}}  # [adaptable: condition_column]
REFERENCE_LEVEL  <- {{reference_level}}  # [adaptable: reference_level]
TEST_LEVEL       <- {{test_level}}  # [adaptable: test_level]
DESIGN           <- {{design}}  # [adaptable: design]
MIN_COUNT        <- {{min_count}}  # [adaptable: min_count]
{{#if min_samples}}
MIN_SAMPLES      <- {{min_samples}}  # [adaptable: min_samples]
{{/if}}
{{#unless min_samples}}
MIN_SAMPLES      <- NA_integer_  # [adaptable: min_samples] NA: the smallest group size, computed below
{{/unless}}
ALPHA            <- {{alpha}}
LFC_SHRINK       <- {{lfc_shrink}}  # [adaptable: lfc_shrink]
LFC_THRESHOLD    <- {{lfc_threshold}}  # [adaptable: lfc_threshold]
N_TOP_GENES_PCA  <- {{n_top_genes_pca}}  # [adaptable: n_top_genes_pca]
OUTPUT_PREFIX    <- {{output_prefix}}  # [adaptable: output_prefix]

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))

save_figure <- function(plot, name, width = 6, height = 5) {
  ggsave(fig(paste0(name, ".png")), plot, width = width, height = height, dpi = 300)
  ggsave(fig(paste0(name, ".pdf")), plot, width = width, height = height)
}

# ── Inputs ────────────────────────────────────────────────────────────────────
# The sample table comes first: the quantifications branch takes the sample
# identifiers from it to find the quant.sf files.
message("Reading the sample table from ", METADATA_PATH)
metadata <- read.csv(METADATA_PATH, check.names = FALSE, stringsAsFactors = FALSE)
if (!SAMPLE_ID_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", SAMPLE_ID_COLUMN)
if (!CONDITION_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", CONDITION_COLUMN)
rownames(metadata) <- as.character(metadata[[SAMPLE_ID_COLUMN]])

sha256 <- function(path) unname(tools::sha256sum(path))
require_input <- function(value, slot, what) {
  if (is.null(value)) stop("The import state ", IMPORT_STATE, " needs ", what, ": set the slot ", slot)
  if (!file.exists(value)) stop("The ", what, " is missing: ", value)
  value
}
read_matrix <- function(path, what) {
  message("Reading the ", what, " from ", path)
  table <- read.csv(path, check.names = FALSE, stringsAsFactors = FALSE)
  matrix <- as.matrix(table[, -1, drop = FALSE])
  storage.mode(matrix) <- "numeric"
  rownames(matrix) <- as.character(table[[1]])
  if (any(is.na(matrix))) stop("The ", what, " holds a missing or a non-numeric value: ", path)
  matrix
}
# The import record of the summary: the state, the mode the model took, the map, and the files with their hashes.
import_record <- list(state = IMPORT_STATE, mode = NA, counts_from_abundance = COUNTS_FROM_ABUNDANCE, length_offset = FALSE, tx2gene = NA, files = list())
lengths <- NULL

if (IMPORT_STATE == "quantifications") {
  suppressPackageStartupMessages(library(tximport))
  require_input(QUANT_DIR, "quant_dir", "the quantification directory")
  require_input(TX2GENE_PATH, "tx2gene_path", "the transcript-to-gene map")
  if (!is.null(COUNTS_PATH)) message("counts_path is not read: the quantifications state imports the quant.sf files")
  samples <- rownames(metadata)
  files <- setNames(file.path(QUANT_DIR, samples, "quant.sf"), samples)
  absent <- samples[!file.exists(files)]
  if (length(absent) > 0) {
    stop("No quant.sf for ", length(absent), " of ", length(samples), " samples of the sample table: ", paste(absent, collapse = ", "), ". The script looks for <quant_dir>/<sample>/quant.sf under ", QUANT_DIR)
  }
  tx2gene <- read.csv(TX2GENE_PATH, check.names = FALSE, stringsAsFactors = FALSE)
  if (!all(c("transcript", "gene") %in% colnames(tx2gene))) stop("The transcript-to-gene map needs the columns transcript and gene: ", TX2GENE_PATH)
  tx2gene <- tx2gene[, c("transcript", "gene")]
  quantified <- read.delim(files[[1]], stringsAsFactors = FALSE)$Name
  n_unmapped <- sum(!quantified %in% tx2gene$transcript)
  message("tximport: ", length(files), " quant.sf files, ", length(quantified), " transcripts, ", n_unmapped, " absent from the map, countsFromAbundance = ", COUNTS_FROM_ABUNDANCE)
  txi <- tximport(files, type = "salmon", tx2gene = tx2gene, countsFromAbundance = COUNTS_FROM_ABUNDANCE)
  counts <- txi$counts
  if (LENGTH_OFFSET && COUNTS_FROM_ABUNDANCE == "no") {
    lengths <- txi$length
    import_record$mode <- "tximport_avg_tx_length_offset"
  } else if (COUNTS_FROM_ABUNDANCE != "no") {
    if (LENGTH_OFFSET) message("countsFromAbundance = ", COUNTS_FROM_ABUNDANCE, " carries the length correction inside the counts: the model takes no offset")
    import_record$mode <- paste0("tximport_", COUNTS_FROM_ABUNDANCE, "_no_offset")
  } else {
    message("length_offset is FALSE: the model takes the summed estimates with no length offset, and a change in isoform use can show as differential expression")
    import_record$mode <- "tximport_no_offset"
  }
  hashes <- sha256(files)
  import_record$tx2gene <- list(path = TX2GENE_PATH, sha256 = sha256(TX2GENE_PATH), n_transcripts = length(quantified), n_genes = nrow(counts), n_unmapped = n_unmapped)
  import_record$files <- lapply(seq_along(samples), function(i) list(sample = samples[i], path = unname(files[i]), sha256 = hashes[i]))
} else if (IMPORT_STATE == "estimated_counts_with_lengths") {
  require_input(COUNTS_PATH, "counts_path", "the count estimate table")
  require_input(LENGTHS_PATH, "lengths_path", "the average transcript length table")
  counts <- read_matrix(COUNTS_PATH, "count estimates")
  if (any(counts < 0)) stop("The count estimate table must hold non-negative values: ", COUNTS_PATH)
  lengths <- read_matrix(LENGTHS_PATH, "average transcript lengths")
  absent_genes <- setdiff(rownames(counts), rownames(lengths))
  absent_samples <- setdiff(colnames(counts), colnames(lengths))
  if (length(absent_genes) > 0) stop(length(absent_genes), " genes of the counts have no row in the length table, for example ", paste(head(absent_genes, 5), collapse = ", "))
  if (length(absent_samples) > 0) stop("Samples of the counts with no column in the length table: ", paste(absent_samples, collapse = ", "))
  lengths <- lengths[rownames(counts), colnames(counts), drop = FALSE]
  if (any(lengths <= 0)) stop("The average transcript length table must hold positive lengths: ", LENGTHS_PATH)
  if (LENGTH_OFFSET) {
    import_record$mode <- "estimated_counts_with_avg_tx_length_offset"
  } else {
    message("length_offset is FALSE: the model takes the rounded estimates with no length offset, and a change in isoform use can show as differential expression")
    lengths <- NULL
    import_record$mode <- "estimated_counts_no_offset"
  }
  import_record$files <- list(list(sample = NA, path = COUNTS_PATH, sha256 = sha256(COUNTS_PATH)), list(sample = NA, path = LENGTHS_PATH, sha256 = sha256(LENGTHS_PATH)))
} else if (IMPORT_STATE %in% c("corrected_counts", "integer_counts")) {
  require_input(COUNTS_PATH, "counts_path", "the count matrix")
  counts <- read_matrix(COUNTS_PATH, "counts")
  if (any(counts < 0)) stop("The count matrix must hold non-negative values: ", COUNTS_PATH)
  fractional <- any(abs(counts - round(counts)) > 1e-6)
  if (IMPORT_STATE == "integer_counts" && fractional) {
    stop("The count matrix holds non-integer values but the import state is integer_counts: name the import state of the table, estimated_counts_with_lengths with its length table or corrected_counts with its countsFromAbundance mode. DESeq2 takes counts, not TPM or FPKM.")
  }
  if (IMPORT_STATE == "corrected_counts" && COUNTS_FROM_ABUNDANCE == "no") {
    stop("The import state corrected_counts needs the correction mode of the table: set counts_from_abundance to lengthScaledTPM or scaledTPM")
  }
  if (fractional) message("The counts from abundance hold fractional values: the model takes them rounded, as DESeqDataSetFromTximport does")
  if (LENGTH_OFFSET) message("The import state ", IMPORT_STATE, " carries no lengths: the model takes no length offset")
  import_record$mode <- if (IMPORT_STATE == "corrected_counts") "length_corrected_counts_no_offset" else "gene_counts_without_length_offset"
  import_record$files <- list(list(sample = NA, path = COUNTS_PATH, sha256 = sha256(COUNTS_PATH)))
} else {
  stop("The import state is unknown: the length correction of the counts is not established. Give the quantification directory and the transcript-to-gene map (quant_dir, tx2gene_path, import_state quantifications), or the count estimates with the average transcript length table (counts_path, lengths_path, import_state estimated_counts_with_lengths), or name the state corrected_counts or integer_counts.")
}
import_record$length_offset <- !is.null(lengths)
message("Import: ", IMPORT_STATE, " -> ", import_record$mode)

# The estimates as imported, before the rounding and the filter, for the record.
write.csv(data.frame(gene = rownames(counts), round(counts, 3), check.names = FALSE), out("import_counts.csv"), row.names = FALSE)
if (!is.null(lengths)) write.csv(data.frame(gene = rownames(lengths), round(lengths, 3), check.names = FALSE), out("import_lengths.csv"), row.names = FALSE)

gene_ids <- rownames(counts)
counts <- round(counts)
missing <- setdiff(colnames(counts), rownames(metadata))
if (length(missing) > 0) stop("Samples in the counts but not in the sample table: ", paste(missing, collapse = ", "))
metadata <- metadata[colnames(counts), , drop = FALSE]
metadata$condition <- factor(metadata[[CONDITION_COLUMN]])
if (!all(c(REFERENCE_LEVEL, TEST_LEVEL) %in% levels(metadata$condition))) {
  stop("The condition column holds ", paste(levels(metadata$condition), collapse = ", "), " but not both ", REFERENCE_LEVEL, " and ", TEST_LEVEL)
}
metadata$condition <- relevel(metadata$condition, ref = REFERENCE_LEVEL)
for (column in setdiff(all.vars(DESIGN), "condition")) {
  if (!column %in% colnames(metadata)) stop("The design names ", column, " but the sample table has no such column")
  if (is.character(metadata[[column]])) metadata[[column]] <- factor(metadata[[column]])
}
message("Samples: ", ncol(counts), "; genes: ", nrow(counts), "; design: ", deparse(DESIGN))
message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "), " (reference ", REFERENCE_LEVEL, ")")

# ── Filter ────────────────────────────────────────────────────────────────────
group_sizes <- table(metadata$condition)
if (is.na(MIN_SAMPLES)) MIN_SAMPLES <- as.integer(min(group_sizes))
keep <- rowSums(counts >= MIN_COUNT) >= MIN_SAMPLES
message("Low count filter: keep genes with >= ", MIN_COUNT, " counts in >= ", MIN_SAMPLES, " samples: ", sum(keep), " of ", nrow(counts), " kept")
counts <- counts[keep, , drop = FALSE]
if (!is.null(lengths)) lengths <- lengths[keep, , drop = FALSE]

# ── Model ─────────────────────────────────────────────────────────────────────
if (IMPORT_STATE == "quantifications" && !is.null(lengths)) {
  # DESeqDataSetFromTximport rounds the estimates and attaches the average transcript length as avgTxLength.
  kept <- list(abundance = txi$abundance[keep, , drop = FALSE], counts = txi$counts[keep, , drop = FALSE], length = lengths, countsFromAbundance = txi$countsFromAbundance)
  dds <- DESeqDataSetFromTximport(kept, colData = metadata, design = DESIGN)
} else {
  dds <- DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = DESIGN)
  if (!is.null(lengths)) assays(dds)[["avgTxLength"]] <- lengths
}
dds <- DESeq(dds, quiet = TRUE)
# With avgTxLength DESeq2 fits a normalization factor per gene and sample instead of a size factor per sample;
# the per-sample geometric mean of the factors is the depth scale of the record.
size_factors <- sizeFactors(dds)
if (is.null(size_factors)) size_factors <- exp(colMeans(log(normalizationFactors(dds))))
message(if (is.null(sizeFactors(dds))) "Normalization factors with the length offset, per-sample geometric mean: " else "Size factors: ", paste(sprintf("%s=%.2f", colnames(dds), size_factors), collapse = ", "))

coefficient <- paste0("condition_", make.names(TEST_LEVEL), "_vs_", make.names(REFERENCE_LEVEL))
if (!coefficient %in% resultsNames(dds)) {
  stop("The coefficient ", coefficient, " is not in resultsNames: ", paste(resultsNames(dds), collapse = ", "))
}
res <- results(dds, name = coefficient, alpha = ALPHA, lfcThreshold = LFC_THRESHOLD)
unshrunken_lfc <- res$log2FoldChange

if (LFC_SHRINK == "apeglm") {
  message("Shrinking the log2 fold change with apeglm on ", coefficient)
  res_shrunk <- lfcShrink(dds, coef = coefficient, res = res, type = "apeglm", quiet = TRUE)
} else if (LFC_SHRINK == "ashr") {
  message("Shrinking the log2 fold change with ashr on the contrast")
  res_shrunk <- lfcShrink(dds, contrast = c("condition", TEST_LEVEL, REFERENCE_LEVEL), res = res, type = "ashr", quiet = TRUE)
} else {
  res_shrunk <- res
}

# ── Results table ─────────────────────────────────────────────────────────────
results_table <- data.frame(
  gene = rownames(res),
  base_mean = res$baseMean,
  log2_fold_change = res_shrunk$log2FoldChange,
  log2_fold_change_unshrunken = unshrunken_lfc,
  lfc_se = res_shrunk$lfcSE,
  stat = res$stat,
  pvalue = res$pvalue,
  adjusted_pvalue = res$padj,
  stringsAsFactors = FALSE
)
results_table <- results_table[order(results_table$pvalue, na.last = TRUE), ]
write.csv(results_table, out("results.csv"), row.names = FALSE)

normalized <- counts(dds, normalized = TRUE)
write.csv(data.frame(gene = rownames(normalized), normalized, check.names = FALSE), out("normalized_counts.csv"), row.names = FALSE)

vsd <- vst(dds, blind = TRUE)
write.csv(data.frame(gene = rownames(vsd), assay(vsd), check.names = FALSE), out("vst.csv"), row.names = FALSE)

n_significant <- sum(!is.na(res$padj) & res$padj < ALPHA)
n_up <- sum(!is.na(res$padj) & res$padj < ALPHA & res_shrunk$log2FoldChange > 0)
n_down <- n_significant - n_up
message("Tested ", sum(!is.na(res$padj)), " genes after independent filtering; ", n_significant, " at padj < ", ALPHA, " (", n_up, " up, ", n_down, " down)")

# ── Figures ───────────────────────────────────────────────────────────────────
pca <- plotPCA(vsd, intgroup = "condition", ntop = min(N_TOP_GENES_PCA, nrow(vsd)), returnData = TRUE)
percent_var <- round(100 * attr(pca, "percentVar"))
pca_plot <- ggplot(pca, aes(PC1, PC2, color = condition, label = name)) +
  geom_point(size = 3) +
  geom_text(vjust = -0.8, size = 2.5, show.legend = FALSE) +
  xlab(paste0("PC1: ", percent_var[1], "% variance")) +
  ylab(paste0("PC2: ", percent_var[2], "% variance")) +
  scale_color_viridis_d(end = 0.8) +
  ggtitle("PCA of the samples, VST, top variable genes") +
  theme_classic()
save_figure(pca_plot, "pca")

distances <- dist(t(assay(vsd)))
distance_matrix <- as.matrix(distances)
annotation <- data.frame(condition = metadata$condition, row.names = colnames(vsd))
png(fig("sample_distances.png"), width = 6, height = 5, units = "in", res = 300)
pheatmap(distance_matrix, clustering_distance_rows = distances, clustering_distance_cols = distances, annotation_col = annotation, main = "Euclidean sample distances (VST)")
dev.off()
pdf(fig("sample_distances.pdf"), width = 6, height = 5)
pheatmap(distance_matrix, clustering_distance_rows = distances, clustering_distance_cols = distances, annotation_col = annotation, main = "Euclidean sample distances (VST)")
dev.off()

plot_df <- results_table[!is.na(results_table$adjusted_pvalue), ]
plot_df$significant <- plot_df$adjusted_pvalue < ALPHA
ma_plot <- ggplot(plot_df, aes(x = base_mean, y = log2_fold_change, color = significant)) +
  geom_point(size = 0.6, alpha = 0.6) +
  scale_x_log10() +
  scale_color_manual(values = c(`FALSE` = "grey60", `TRUE` = "#440154"), name = paste0("padj < ", ALPHA)) +
  geom_hline(yintercept = 0, linetype = "dashed") +
  xlab("Mean of normalized counts") + ylab("Shrunken log2 fold change") +
  ggtitle(paste0("MA plot: ", TEST_LEVEL, " vs ", REFERENCE_LEVEL)) +
  theme_classic()
save_figure(ma_plot, "ma")

top_labels <- head(plot_df[order(plot_df$adjusted_pvalue), ], 15)
volcano_plot <- ggplot(plot_df, aes(x = log2_fold_change, y = -log10(adjusted_pvalue), color = significant)) +
  geom_point(size = 0.6, alpha = 0.6) +
  geom_text(data = top_labels, aes(label = gene), size = 2.5, vjust = -0.6, show.legend = FALSE) +
  scale_color_manual(values = c(`FALSE` = "grey60", `TRUE` = "#21908C"), name = paste0("padj < ", ALPHA)) +
  geom_hline(yintercept = -log10(ALPHA), linetype = "dashed") +
  xlab("Shrunken log2 fold change") + ylab("-log10 adjusted p-value") +
  ggtitle(paste0("Volcano: ", TEST_LEVEL, " vs ", REFERENCE_LEVEL)) +
  theme_classic()
save_figure(volcano_plot, "volcano")

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-deseq2-two-group@1.1.0",
  method = "DESeq2 Wald test",
  import = import_record,
  contrast = list(factor = "condition", test = TEST_LEVEL, reference = REFERENCE_LEVEL),
  design = deparse(DESIGN),
  n_samples = ncol(counts),
  group_sizes = as.list(group_sizes),
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(counts),
  n_genes_tested = sum(!is.na(res$padj)),
  n_significant = n_significant,
  n_up = n_up,
  n_down = n_down,
  alpha = ALPHA,
  lfc_threshold = LFC_THRESHOLD,
  lfc_shrink = LFC_SHRINK,
  min_count = MIN_COUNT,
  min_samples = MIN_SAMPLES,
  size_factors = as.list(setNames(round(size_factors, 4), colnames(dds))),
  versions = list(
    R = R.version.string,
    DESeq2 = as.character(packageVersion("DESeq2")),
    tximport = if (IMPORT_STATE == "quantifications") as.character(packageVersion("tximport")) else NA,
    apeglm = if (requireNamespace("apeglm", quietly = TRUE)) as.character(packageVersion("apeglm")) else NA,
    ashr = if (requireNamespace("ashr", quietly = TRUE)) as.character(packageVersion("ashr")) else NA
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("results.csv"))
