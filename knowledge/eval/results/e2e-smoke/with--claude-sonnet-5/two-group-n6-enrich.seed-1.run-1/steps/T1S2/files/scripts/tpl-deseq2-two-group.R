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
COUNTS_PATH      <- "/eval-e2e-smoke-with-two-group-n6-enrich-s1-1/data/inputs/local/counts.csv"  # [adaptable: counts_path]
METADATA_PATH    <- "/eval-e2e-smoke-with-two-group-n6-enrich-s1-1/data/inputs/local/metadata.csv"  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN <- "sample"  # [adaptable: sample_id_column]
CONDITION_COLUMN <- "condition"  # [adaptable: condition_column]
REFERENCE_LEVEL  <- "control"  # [adaptable: reference_level]
TEST_LEVEL       <- "treated"  # [adaptable: test_level]
DESIGN           <- ~ condition  # [adaptable: design]
MIN_COUNT        <- 10  # [adaptable: min_count]


MIN_SAMPLES      <- NA_integer_  # [adaptable: min_samples] NA: the smallest group size, computed below

ALPHA            <- 0.05
LFC_SHRINK       <- "apeglm"  # [adaptable: lfc_shrink]
LFC_THRESHOLD    <- 0  # [adaptable: lfc_threshold]
N_TOP_GENES_PCA  <- 500  # [adaptable: n_top_genes_pca]
OUTPUT_PREFIX    <- "deseq2"  # [adaptable: output_prefix]

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
MIN_REPLICATES_FOR_REPLACE <- 7L  # DESeq2 default: minimum per-cell replicates for automatic Cook's-outlier count replacement
dds <- DESeq(dds, quiet = TRUE, minReplicatesForReplace = MIN_REPLICATES_FOR_REPLACE)
message("Size factors: ", paste(sprintf("%s=%.2f", colnames(dds), sizeFactors(dds)), collapse = ", "))
message(sprintf(
  "Smallest condition group has %d replicates (< minReplicatesForReplace = %d): automatic Cook's-outlier count replacement inside DESeq() is OFF for this cell. results()'s own Cook's-distance NA flag (cooksCutoff, default on) still applies independently and is not affected by minReplicatesForReplace.",
  MIN_SAMPLES, MIN_REPLICATES_FOR_REPLACE
))

# ── Dispersion plot (fit diagnostic) ────────────────────────────────────────────
png(fig("dispersion.png"), width = 6, height = 5, units = "in", res = 300)
plotDispEsts(dds, main = "Dispersion estimates")
dev.off()
pdf(fig("dispersion.pdf"), width = 6, height = 5)
plotDispEsts(dds, main = "Dispersion estimates")
dev.off()

coefficient <- paste0("condition_", make.names(TEST_LEVEL), "_vs_", make.names(REFERENCE_LEVEL))
if (!coefficient %in% resultsNames(dds)) {
  stop("The coefficient ", coefficient, " is not in resultsNames: ", paste(resultsNames(dds), collapse = ", "))
}
res <- results(dds, name = coefficient, alpha = ALPHA, lfcThreshold = LFC_THRESHOLD)
unshrunken_lfc <- res$log2FoldChange

# ── NA policy: count-outlier NA (Cook's, pvalue itself NA) vs independent-filtering NA
# (padj NA but pvalue present, from the low-mean-count filter) ──────────────────
count_outlier_na <- sum(is.na(res$pvalue))
independent_filtering_na <- sum(!is.na(res$pvalue) & is.na(res$padj))
n_genes_tested_padj <- sum(!is.na(res$padj))
# results()'s default cooksCutoff is the .99 quantile of F(p, m-p): p = number of
# fitted model coefficients, m = number of samples (see ?results, cooksCutoff).
p_coef <- length(resultsNames(dds))
m_samples <- ncol(dds)
cooks_cutoff_theoretical <- qf(0.99, p_coef, m_samples - p_coef)
filter_threshold <- if (!is.null(metadata(res)$filterThreshold)) unname(metadata(res)$filterThreshold) else NA_real_
message(sprintf(
  "NA policy: %d genes NA for count outliers (Cook's distance > the default cutoff, theoretical qf(.99, %d, %d) = %.3f), %d genes NA from independent filtering (baseMean below the optimized threshold %.3f), %d genes retain a padj value.",
  count_outlier_na, p_coef, m_samples - p_coef, cooks_cutoff_theoretical,
  independent_filtering_na, filter_threshold,
  n_genes_tested_padj
))

# ── P-value histogram, BEFORE trusting the BH adjustment ────────────────────────
pval_hist_df <- data.frame(pvalue = res$pvalue[!is.na(res$pvalue)])
pval_hist_plot <- ggplot(pval_hist_df, aes(x = pvalue)) +
  geom_histogram(breaks = seq(0, 1, by = 0.02), fill = "#414487", color = "white", linewidth = 0.1) +
  xlab("Raw p-value (Wald test)") + ylab("Number of genes") +
  ggtitle("P-value distribution before BH adjustment") +
  theme_classic()
save_figure(pval_hist_plot, "pvalue_histogram")

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
na_reason <- ifelse(
  is.na(res$pvalue), "count_outlier_cooks_distance",
  ifelse(is.na(res$padj), "independent_filtering", "tested")
)
results_table <- data.frame(
  gene = rownames(res),
  base_mean = res$baseMean,
  log2_fold_change = res_shrunk$log2FoldChange,
  log2_fold_change_unshrunken = unshrunken_lfc,
  lfc_se = res_shrunk$lfcSE,
  stat = res$stat,
  pvalue = res$pvalue,
  adjusted_pvalue = res$padj,
  na_reason = na_reason,
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

# ── P-value histogram shape diagnostic ──────────────────────────────────────────
n_pvals_tested <- nrow(pval_hist_df)
frac_below_05 <- mean(pval_hist_df$pvalue < 0.05)
bin_counts <- table(cut(pval_hist_df$pvalue, breaks = seq(0, 1, by = 0.05), include.lowest = TRUE))
low_bin_count <- as.numeric(bin_counts[1])                      # [0, 0.05)
high_bin_count <- as.numeric(bin_counts[length(bin_counts)])    # [0.95, 1]
mid_bins <- as.numeric(bin_counts[2:(length(bin_counts) - 1)])
uniform_expected_per_bin <- n_pvals_tested / length(bin_counts)
pvalue_histogram_shape <- if (n_pvals_tested == 0) {
  "no_genes_tested"
} else if (low_bin_count > 2 * uniform_expected_per_bin && high_bin_count <= 1.5 * uniform_expected_per_bin) {
  "anti-conservative: enriched near 0, roughly flat elsewhere -- consistent with real signal atop a uniform null"
} else if (high_bin_count > 2 * uniform_expected_per_bin && low_bin_count <= 1.5 * uniform_expected_per_bin) {
  "hump near 1: possible model misspecification or dependence among tests"
} else if (low_bin_count <= 1.5 * uniform_expected_per_bin && high_bin_count <= 1.5 * uniform_expected_per_bin) {
  "approximately uniform: little to no detectable signal at this alpha"
} else {
  "irregular: does not match a clean uniform, anti-conservative, or hump-near-1 pattern -- inspect the figure directly"
}
message(sprintf(
  "P-value histogram: %d genes tested, %.1f%% with p < 0.05, low-bin[0,0.05) count = %.0f vs uniform-expected %.1f per bin. Shape: %s",
  n_pvals_tested, 100 * frac_below_05, low_bin_count, uniform_expected_per_bin, pvalue_histogram_shape
))

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-deseq2-two-group@1.0.0",
  method = "DESeq2 Wald test",
  design_formula = deparse(DESIGN),
  reference_level = REFERENCE_LEVEL,
  contrast = list(
    factor = "condition", test = TEST_LEVEL, reference = REFERENCE_LEVEL,
    name = "condition: treated vs control", coefficient = coefficient
  ),
  n_samples = ncol(counts),
  group_sizes = as.list(group_sizes),
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(counts),
  n_genes_tested = n_genes_tested_padj,
  n_significant = n_significant,
  n_up = n_up,
  n_down = n_down,
  alpha = ALPHA,
  lfc_threshold = LFC_THRESHOLD,
  lfc_shrink = LFC_SHRINK,
  min_count = MIN_COUNT,
  min_samples = MIN_SAMPLES,
  na_policy = list(
    min_replicates_for_replace = MIN_REPLICATES_FOR_REPLACE,
    smallest_group_size = MIN_SAMPLES,
    automatic_cooks_outlier_replacement_in_DESeq = MIN_SAMPLES >= MIN_REPLICATES_FOR_REPLACE,
    cooks_distance_cutoff_theoretical_qf99 = cooks_cutoff_theoretical,
    n_count_outlier_na = count_outlier_na,
    n_independent_filtering_na = independent_filtering_na,
    independent_filtering_threshold_baseMean = filter_threshold
  ),
  pvalue_histogram = list(
    n_tested = n_pvals_tested,
    fraction_below_0.05 = round(frac_below_05, 4),
    low_bin_0_to_0.05_count = low_bin_count,
    high_bin_0.95_to_1_count = high_bin_count,
    uniform_expected_count_per_bin = round(uniform_expected_per_bin, 2),
    shape = pvalue_histogram_shape
  ),
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
