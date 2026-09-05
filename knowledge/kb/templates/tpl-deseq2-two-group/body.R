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

suppressPackageStartupMessages({
  library(DESeq2)
  library(ggplot2)
  library(pheatmap)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH      <- {{counts_path}}  # [adaptable: counts_path]
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
message("Reading counts from ", COUNTS_PATH)
counts_df <- read.csv(COUNTS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
gene_ids <- as.character(counts_df[[1]])
counts <- as.matrix(counts_df[, -1, drop = FALSE])
storage.mode(counts) <- "numeric"
rownames(counts) <- gene_ids
if (any(counts < 0, na.rm = TRUE) || any(abs(counts - round(counts)) > 1e-6, na.rm = TRUE)) {
  stop("The count matrix must hold non-negative integers. DESeq2 takes raw counts, not TPM or FPKM.")
}
counts <- round(counts)

message("Reading the sample table from ", METADATA_PATH)
metadata <- read.csv(METADATA_PATH, check.names = FALSE, stringsAsFactors = FALSE)
if (!SAMPLE_ID_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", SAMPLE_ID_COLUMN)
if (!CONDITION_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", CONDITION_COLUMN)
rownames(metadata) <- as.character(metadata[[SAMPLE_ID_COLUMN]])
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

# ── Model ─────────────────────────────────────────────────────────────────────
dds <- DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = DESIGN)
dds <- DESeq(dds, quiet = TRUE)
message("Size factors: ", paste(sprintf("%s=%.2f", colnames(dds), sizeFactors(dds)), collapse = ", "))

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
  template = "tpl-deseq2-two-group@1.0.0",
  method = "DESeq2 Wald test",
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
  size_factors = as.list(setNames(round(sizeFactors(dds), 4), colnames(dds))),
  versions = list(
    R = R.version.string,
    DESeq2 = as.character(packageVersion("DESeq2")),
    apeglm = if (requireNamespace("apeglm", quietly = TRUE)) as.character(packageVersion("apeglm")) else NA,
    ashr = if (requireNamespace("ashr", quietly = TRUE)) as.character(packageVersion("ashr")) else NA
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("results.csv"))
