#!/usr/bin/env Rscript
# tpl-deseq2-multigroup — DESeq2 likelihood ratio test for three or more groups,
# then one Wald contrast per level against the reference level.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: DESeq2 negative binomial GLM, likelihood ratio test of the full
# design against the reduced design, median-of-ratios size factors, and
# independent filtering at alpha (Love et al. 2014). Under the default designs
# the test removes the condition, thus it finds the genes that differ between
# any of the groups. Then one Wald test per non-reference level against the
# reference level, with ashr shrinkage of the reported log2 fold change
# (Stephens 2017). The any-difference table reports the largest shrunken
# contrast of each gene as its log2 fold change.

suppressPackageStartupMessages({
  library(DESeq2)
  library(ggplot2)
  library(pheatmap)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH         <- {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH       <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN    <- {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN    <- {{condition_column}}  # [adaptable: condition_column]
REFERENCE_LEVEL     <- {{reference_level}}  # [adaptable: reference_level]
FULL_DESIGN         <- {{full_design}}  # [adaptable: full_design]
REDUCED_DESIGN      <- {{reduced_design}}  # [adaptable: reduced_design]
MIN_COUNT           <- {{min_count}}  # [adaptable: min_count]
{{#if min_samples}}
MIN_SAMPLES         <- {{min_samples}}  # [adaptable: min_samples]
{{/if}}
{{#unless min_samples}}
MIN_SAMPLES         <- NA_integer_  # [adaptable: min_samples] NA: the smallest group size, computed below
{{/unless}}
ALPHA               <- {{alpha}}
LFC_SHRINK          <- {{lfc_shrink}}  # [adaptable: lfc_shrink]
N_TOP_GENES_PCA     <- {{n_top_genes_pca}}  # [adaptable: n_top_genes_pca]
N_TOP_GENES_HEATMAP <- {{n_top_genes_heatmap}}  # [adaptable: n_top_genes_heatmap]
OUTPUT_PREFIX       <- {{output_prefix}}  # [adaptable: output_prefix]

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))
file_safe <- function(text) gsub("[^A-Za-z0-9_.-]", "_", text)

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
for (column in c(SAMPLE_ID_COLUMN, CONDITION_COLUMN)) {
  if (!column %in% colnames(metadata)) stop("The sample table has no column ", column)
}
rownames(metadata) <- as.character(metadata[[SAMPLE_ID_COLUMN]])
missing <- setdiff(colnames(counts), rownames(metadata))
if (length(missing) > 0) stop("Samples in the counts but not in the sample table: ", paste(missing, collapse = ", "))
metadata <- metadata[colnames(counts), , drop = FALSE]

metadata$condition <- factor(metadata[[CONDITION_COLUMN]])
if (!REFERENCE_LEVEL %in% levels(metadata$condition)) {
  stop("The condition column holds ", paste(levels(metadata$condition), collapse = ", "), " but not ", REFERENCE_LEVEL)
}
if (nlevels(metadata$condition) < 3) {
  stop("The condition column holds ", nlevels(metadata$condition), " levels; this template is for three or more groups")
}
metadata$condition <- relevel(metadata$condition, ref = REFERENCE_LEVEL)
group_sizes <- table(metadata$condition)
if (any(group_sizes < 2)) {
  stop("Each group needs at least two replicates: ", paste(sprintf("%s=%d", names(group_sizes), group_sizes), collapse = ", "))
}

design_columns <- setdiff(union(all.vars(FULL_DESIGN), all.vars(REDUCED_DESIGN)), "condition")
for (column in design_columns) {
  if (!column %in% colnames(metadata)) stop("A design names ", column, " but the sample table has no such column")
  if (is.character(metadata[[column]])) metadata[[column]] <- factor(metadata[[column]])
}
if (!"condition" %in% all.vars(FULL_DESIGN)) stop("The full design must name condition")
if ("condition" %in% all.vars(REDUCED_DESIGN)) stop("The reduced design must not name condition; the test removes the condition")
full_terms <- attr(terms(FULL_DESIGN), "term.labels")
reduced_terms <- attr(terms(REDUCED_DESIGN), "term.labels")
extra_terms <- setdiff(reduced_terms, full_terms)
if (length(extra_terms) > 0) stop("The reduced design holds terms that the full design does not: ", paste(extra_terms, collapse = ", "))
removed_terms <- setdiff(full_terms, reduced_terms)
full_model_matrix <- model.matrix(FULL_DESIGN, data = metadata)
reduced_model_matrix <- model.matrix(REDUCED_DESIGN, data = metadata)
df_tested <- ncol(full_model_matrix) - ncol(reduced_model_matrix)
if (df_tested < 1) stop("The full design has no more coefficients than the reduced design")
if (qr(full_model_matrix)$rank < ncol(full_model_matrix)) stop("The full design is not of full rank; a term is confounded with another")

contrast_levels <- setdiff(levels(metadata$condition), REFERENCE_LEVEL)
message("Samples: ", ncol(counts), "; genes: ", nrow(counts))
message("Full design: ", deparse(FULL_DESIGN), "; reduced design: ", deparse(REDUCED_DESIGN))
message("Terms removed by the test: ", paste(removed_terms, collapse = ", "), " (", df_tested, " degrees of freedom)")
message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "), " (reference ", REFERENCE_LEVEL, ")")
message("Contrasts: ", paste(paste0(contrast_levels, " vs ", REFERENCE_LEVEL), collapse = ", "))

# ── Filter ────────────────────────────────────────────────────────────────────
if (is.na(MIN_SAMPLES)) MIN_SAMPLES <- as.integer(min(group_sizes))
keep <- rowSums(counts >= MIN_COUNT) >= MIN_SAMPLES
message("Low count filter: keep genes with >= ", MIN_COUNT, " counts in >= ", MIN_SAMPLES, " samples: ", sum(keep), " of ", nrow(counts), " kept")
counts <- counts[keep, , drop = FALSE]

# ── Model: the any-difference likelihood ratio test ───────────────────────────
dds <- DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = FULL_DESIGN)
dds <- DESeq(dds, test = "LRT", reduced = REDUCED_DESIGN, quiet = TRUE)
message("Size factors: ", paste(sprintf("%s=%.2f", colnames(dds), sizeFactors(dds)), collapse = ", "))

res_lrt <- results(dds, alpha = ALPHA)
n_tested_lrt <- sum(!is.na(res_lrt$padj))
n_significant_lrt <- sum(!is.na(res_lrt$padj) & res_lrt$padj < ALPHA)
message("Likelihood ratio test: ", n_tested_lrt, " genes tested after independent filtering; ", n_significant_lrt, " at padj < ", ALPHA)

# ── One Wald contrast per level against the reference ────────────────────────
# After the likelihood ratio test, results(test = "Wald") gives the Wald
# statistic and the Wald p-value of the contrast from the coefficients of the
# full model. The shrinkage takes the same contrast.
contrast_tables <- list()
contrast_records <- list()
shrunken_lfc <- matrix(NA_real_, nrow = nrow(dds), ncol = length(contrast_levels), dimnames = list(rownames(dds), contrast_levels))
for (level in contrast_levels) {
  contrast <- c("condition", level, REFERENCE_LEVEL)
  res_wald <- results(dds, contrast = contrast, test = "Wald", alpha = ALPHA)
  unshrunken_lfc <- res_wald$log2FoldChange
  if (LFC_SHRINK == "ashr") {
    message("Shrinking the log2 fold change of ", level, " vs ", REFERENCE_LEVEL, " with ashr")
    res_shrunk <- lfcShrink(dds, contrast = contrast, res = res_wald, type = "ashr", quiet = TRUE)
  } else {
    res_shrunk <- res_wald
  }
  shrunken_lfc[, level] <- res_shrunk$log2FoldChange
  contrast_table <- data.frame(
    gene = rownames(res_wald),
    base_mean = res_wald$baseMean,
    log2_fold_change = res_shrunk$log2FoldChange,
    log2_fold_change_unshrunken = unshrunken_lfc,
    lfc_se = res_shrunk$lfcSE,
    stat = res_wald$stat,
    pvalue = res_wald$pvalue,
    adjusted_pvalue = res_wald$padj,
    stringsAsFactors = FALSE
  )
  contrast_table <- contrast_table[order(contrast_table$pvalue, na.last = TRUE), ]
  contrast_file <- file.path("output", paste0(file_safe(level), "_vs_", file_safe(REFERENCE_LEVEL), "_results.csv"))
  write.csv(contrast_table, contrast_file, row.names = FALSE)
  n_tested <- sum(!is.na(res_wald$padj))
  n_significant <- sum(!is.na(res_wald$padj) & res_wald$padj < ALPHA)
  n_up <- sum(!is.na(res_wald$padj) & res_wald$padj < ALPHA & res_shrunk$log2FoldChange > 0)
  message("Wald contrast ", level, " vs ", REFERENCE_LEVEL, ": ", n_tested, " genes tested; ", n_significant, " at padj < ", ALPHA, " (", n_up, " up, ", n_significant - n_up, " down): ", contrast_file)
  contrast_tables[[level]] <- contrast_table
  contrast_records[[level]] <- list(
    level = level,
    reference = REFERENCE_LEVEL,
    n_genes_tested = n_tested,
    n_significant = n_significant,
    n_up = n_up,
    n_down = n_significant - n_up,
    results_file = contrast_file
  )
}

# ── The any-difference table ──────────────────────────────────────────────────
# The log2 fold change of a gene is its largest shrunken contrast by absolute
# value, with the sign kept, and largest_contrast names the level.
largest_index <- apply(shrunken_lfc, 1, function(row) if (all(is.na(row))) NA_integer_ else which.max(abs(row)))
largest_lfc <- ifelse(is.na(largest_index), NA_real_, shrunken_lfc[cbind(seq_len(nrow(shrunken_lfc)), largest_index)])
largest_level <- ifelse(is.na(largest_index), NA_character_, contrast_levels[largest_index])
any_difference <- data.frame(
  gene = rownames(res_lrt),
  base_mean = res_lrt$baseMean,
  log2_fold_change = largest_lfc,
  largest_contrast = largest_level,
  stat = res_lrt$stat,
  pvalue = res_lrt$pvalue,
  adjusted_pvalue = res_lrt$padj,
  stringsAsFactors = FALSE
)
any_difference <- any_difference[order(any_difference$pvalue, na.last = TRUE), ]
any_difference_file <- file.path("output", "any_difference_results.csv")
write.csv(any_difference, any_difference_file, row.names = FALSE)

normalized <- counts(dds, normalized = TRUE)
write.csv(data.frame(gene = rownames(normalized), normalized, check.names = FALSE), out("normalized_counts.csv"), row.names = FALSE)

vsd <- vst(dds, blind = TRUE)
write.csv(data.frame(gene = rownames(vsd), assay(vsd), check.names = FALSE), out("vst.csv"), row.names = FALSE)

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

top_genes <- head(any_difference$gene[!is.na(any_difference$pvalue)], N_TOP_GENES_HEATMAP)
if (length(top_genes) >= 2) {
  sample_order <- order(metadata$condition)
  heatmap_matrix <- assay(vsd)[top_genes, sample_order, drop = FALSE]
  heatmap_annotation <- annotation[sample_order, , drop = FALSE]
  heatmap_title <- paste0("Top ", length(top_genes), " any-difference genes, VST, scaled by row")
  draw_heatmap <- function() {
    pheatmap(heatmap_matrix, scale = "row", cluster_cols = FALSE, annotation_col = heatmap_annotation, fontsize_row = 6, main = heatmap_title)
  }
  png(fig("top_genes_heatmap.png"), width = 7, height = 8, units = "in", res = 300)
  draw_heatmap()
  dev.off()
  pdf(fig("top_genes_heatmap.pdf"), width = 7, height = 8)
  draw_heatmap()
  dev.off()
} else {
  message("Fewer than 2 genes have a p-value; no heatmap")
}

for (level in contrast_levels) {
  contrast_name <- paste0(file_safe(level), "_vs_", file_safe(REFERENCE_LEVEL))
  plot_df <- contrast_tables[[level]][!is.na(contrast_tables[[level]]$adjusted_pvalue), ]
  plot_df$significant <- plot_df$adjusted_pvalue < ALPHA
  ma_plot <- ggplot(plot_df, aes(x = base_mean, y = log2_fold_change, color = significant)) +
    geom_point(size = 0.6, alpha = 0.6) +
    scale_x_log10() +
    scale_color_manual(values = c(`FALSE` = "grey60", `TRUE` = "#440154"), name = paste0("padj < ", ALPHA)) +
    geom_hline(yintercept = 0, linetype = "dashed") +
    xlab("Mean of normalized counts") + ylab("Shrunken log2 fold change") +
    ggtitle(paste0("MA plot: ", level, " vs ", REFERENCE_LEVEL)) +
    theme_classic()
  save_figure(ma_plot, paste0("ma_", contrast_name))

  top_labels <- head(plot_df[order(plot_df$adjusted_pvalue), ], 15)
  volcano_plot <- ggplot(plot_df, aes(x = log2_fold_change, y = -log10(adjusted_pvalue), color = significant)) +
    geom_point(size = 0.6, alpha = 0.6) +
    geom_text(data = top_labels, aes(label = gene), size = 2.5, vjust = -0.6, show.legend = FALSE) +
    scale_color_manual(values = c(`FALSE` = "grey60", `TRUE` = "#21908C"), name = paste0("padj < ", ALPHA)) +
    geom_hline(yintercept = -log10(ALPHA), linetype = "dashed") +
    xlab("Shrunken log2 fold change") + ylab("-log10 adjusted p-value") +
    ggtitle(paste0("Volcano: ", level, " vs ", REFERENCE_LEVEL)) +
    theme_classic()
  save_figure(volcano_plot, paste0("volcano_", contrast_name))
}

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-deseq2-multigroup@1.0.0",
  method = "DESeq2 likelihood ratio test, then one Wald contrast per level against the reference",
  full_design = deparse(FULL_DESIGN),
  reduced_design = deparse(REDUCED_DESIGN),
  terms_removed = as.list(removed_terms),
  df_tested = df_tested,
  condition = list(column = CONDITION_COLUMN, levels = as.list(levels(metadata$condition)), reference = REFERENCE_LEVEL),
  n_samples = ncol(counts),
  n_groups = nlevels(metadata$condition),
  group_sizes = as.list(group_sizes),
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(counts),
  any_difference = list(
    n_genes_tested = n_tested_lrt,
    n_significant = n_significant_lrt,
    results_file = any_difference_file
  ),
  contrasts = unname(contrast_records),
  alpha = ALPHA,
  lfc_shrink = LFC_SHRINK,
  min_count = MIN_COUNT,
  min_samples = MIN_SAMPLES,
  n_top_genes_heatmap = N_TOP_GENES_HEATMAP,
  size_factors = as.list(setNames(round(sizeFactors(dds), 4), colnames(dds))),
  versions = list(
    R = R.version.string,
    DESeq2 = as.character(packageVersion("DESeq2")),
    ashr = if (requireNamespace("ashr", quietly = TRUE)) as.character(packageVersion("ashr")) else NA,
    ggplot2 = as.character(packageVersion("ggplot2")),
    pheatmap = as.character(packageVersion("pheatmap"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", any_difference_file)
