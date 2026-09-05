#!/usr/bin/env Rscript
# tpl-deseq2-lrt-timecourse — DESeq2 likelihood ratio test for a time course.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: DESeq2 negative binomial GLM, likelihood ratio test of the full
# design against the reduced design, median-of-ratios size factors, and
# independent filtering at alpha (Love et al. 2014). Under the default designs
# the test removes the condition:time terms, thus it finds the genes whose
# condition effect differs between time points. The per-timepoint log2 fold
# changes come from the coefficients of the full model.

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
TIME_COLUMN         <- {{time_column}}  # [adaptable: time_column]
{{#if time_order}}
TIME_ORDER          <- {{time_order}}  # [adaptable: time_order]
{{/if}}
{{#unless time_order}}
TIME_ORDER          <- NULL  # [adaptable: time_order] NULL: the order of first appearance in the sample table
{{/unless}}
FULL_DESIGN         <- {{full_design}}  # [adaptable: full_design]
REDUCED_DESIGN      <- {{reduced_design}}  # [adaptable: reduced_design]
MIN_COUNT           <- {{min_count}}  # [adaptable: min_count]
{{#if min_samples}}
MIN_SAMPLES         <- {{min_samples}}  # [adaptable: min_samples]
{{/if}}
{{#unless min_samples}}
MIN_SAMPLES         <- NA_integer_  # [adaptable: min_samples] NA: the smallest condition-by-time cell, computed below
{{/unless}}
ALPHA               <- {{alpha}}
N_TOP_GENES_PCA     <- {{n_top_genes_pca}}  # [adaptable: n_top_genes_pca]
N_TOP_GENES_HEATMAP <- {{n_top_genes_heatmap}}  # [adaptable: n_top_genes_heatmap]
OUTPUT_PREFIX       <- {{output_prefix}}  # [adaptable: output_prefix]

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
for (column in c(SAMPLE_ID_COLUMN, CONDITION_COLUMN, TIME_COLUMN)) {
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
if (nlevels(metadata$condition) < 2) stop("The condition column holds one level only; the test needs at least two")
metadata$condition <- relevel(metadata$condition, ref = REFERENCE_LEVEL)

time_values <- as.character(metadata[[TIME_COLUMN]])
if (is.null(TIME_ORDER)) {
  time_levels <- unique(time_values)
} else {
  if (!setequal(TIME_ORDER, unique(time_values)) || anyDuplicated(TIME_ORDER) > 0) {
    stop("time_order must list each time level once: the sample table holds ", paste(unique(time_values), collapse = ", "), " but time_order gives ", paste(TIME_ORDER, collapse = ", "))
  }
  time_levels <- TIME_ORDER
}
metadata$time <- factor(time_values, levels = time_levels)
if (nlevels(metadata$time) < 2) stop("The time column holds one level only; a time course needs at least two")

design_columns <- setdiff(union(all.vars(FULL_DESIGN), all.vars(REDUCED_DESIGN)), c("condition", "time"))
for (column in design_columns) {
  if (!column %in% colnames(metadata)) stop("A design names ", column, " but the sample table has no such column")
  if (is.character(metadata[[column]])) metadata[[column]] <- factor(metadata[[column]])
}
if (!all(c("condition", "time") %in% all.vars(FULL_DESIGN))) stop("The full design must name condition and time")
full_terms <- attr(terms(FULL_DESIGN), "term.labels")
reduced_terms <- attr(terms(REDUCED_DESIGN), "term.labels")
extra_terms <- setdiff(reduced_terms, full_terms)
if (length(extra_terms) > 0) stop("The reduced design holds terms that the full design does not: ", paste(extra_terms, collapse = ", "))
removed_terms <- setdiff(full_terms, reduced_terms)
if (length(removed_terms) == 0) stop("The reduced design holds every term of the full design; the test has nothing to remove")
full_model_matrix <- model.matrix(FULL_DESIGN, data = metadata)
reduced_model_matrix <- model.matrix(REDUCED_DESIGN, data = metadata)
df_tested <- ncol(full_model_matrix) - ncol(reduced_model_matrix)
if (df_tested < 1) stop("The full design has no more coefficients than the reduced design")

message("Samples: ", ncol(counts), "; genes: ", nrow(counts))
message("Full design: ", deparse(FULL_DESIGN), "; reduced design: ", deparse(REDUCED_DESIGN))
message("Terms removed by the test: ", paste(removed_terms, collapse = ", "), " (", df_tested, " degrees of freedom)")
message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "), " (reference ", REFERENCE_LEVEL, ")")
message("Time levels: ", paste(levels(metadata$time), collapse = ", "))

# ── Filter ────────────────────────────────────────────────────────────────────
cell_sizes <- table(metadata$condition, metadata$time)
if (is.na(MIN_SAMPLES)) MIN_SAMPLES <- as.integer(min(cell_sizes[cell_sizes > 0]))
keep <- rowSums(counts >= MIN_COUNT) >= MIN_SAMPLES
message("Low count filter: keep genes with >= ", MIN_COUNT, " counts in >= ", MIN_SAMPLES, " samples: ", sum(keep), " of ", nrow(counts), " kept")
counts <- counts[keep, , drop = FALSE]

# ── Model ─────────────────────────────────────────────────────────────────────
dds <- DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = FULL_DESIGN)
dds <- DESeq(dds, test = "LRT", reduced = REDUCED_DESIGN, quiet = TRUE)
message("Size factors: ", paste(sprintf("%s=%.2f", colnames(dds), sizeFactors(dds)), collapse = ", "))

res <- results(dds, alpha = ALPHA)

# ── Results table ─────────────────────────────────────────────────────────────
results_table <- data.frame(
  gene = rownames(res),
  base_mean = res$baseMean,
  stat = res$stat,
  pvalue = res$pvalue,
  adjusted_pvalue = res$padj,
  stringsAsFactors = FALSE
)
results_table <- results_table[order(results_table$pvalue, na.last = TRUE), ]
write.csv(results_table, out("lrt_results.csv"), row.names = FALSE)

n_tested <- sum(!is.na(res$padj))
n_significant <- sum(!is.na(res$padj) & res$padj < ALPHA)
message("Tested ", n_tested, " genes after independent filtering; ", n_significant, " at padj < ", ALPHA)

# ── Per-timepoint log2 fold changes from the coefficients ─────────────────────
# For each non-reference condition level and each time level, the contrast is
# the difference between two rows of the full model matrix: the level and the
# reference at that time, with every other column of the sample table held
# equal. An additive covariate cancels in the difference.
coefficients <- coef(dds)
template_rows <- as.data.frame(colData(dds))[c(1, 1), all.vars(FULL_DESIGN), drop = FALSE]
timepoint_contrast <- function(level, time_level) {
  rows <- template_rows
  rows$condition <- factor(c(level, REFERENCE_LEVEL), levels = levels(metadata$condition))
  rows$time <- factor(c(time_level, time_level), levels = levels(metadata$time))
  contrast_matrix <- model.matrix(FULL_DESIGN, data = rows)
  if (ncol(contrast_matrix) != ncol(coefficients)) {
    stop("The contrast has ", ncol(contrast_matrix), " columns but the model has ", ncol(coefficients), " coefficients")
  }
  contrast_matrix[1, ] - contrast_matrix[2, ]
}
significant_genes <- results_table$gene[!is.na(results_table$adjusted_pvalue) & results_table$adjusted_pvalue < ALPHA]
timepoint_lfc <- data.frame(
  gene = significant_genes,
  adjusted_pvalue = results_table$adjusted_pvalue[match(significant_genes, results_table$gene)],
  stringsAsFactors = FALSE
)
for (level in setdiff(levels(metadata$condition), REFERENCE_LEVEL)) {
  for (time_level in levels(metadata$time)) {
    column <- paste0("lfc_", level, "_vs_", REFERENCE_LEVEL, "_at_", time_level)
    lfc <- as.numeric(coefficients[significant_genes, , drop = FALSE] %*% timepoint_contrast(level, time_level))
    timepoint_lfc[[column]] <- lfc
  }
}
write.csv(timepoint_lfc, out("timepoint_lfc.csv"), row.names = FALSE)
message("Per-timepoint log2 fold changes for ", nrow(timepoint_lfc), " significant genes: ", out("timepoint_lfc.csv"))

# ── Figures ───────────────────────────────────────────────────────────────────
vsd <- vst(dds, blind = TRUE)

pca <- plotPCA(vsd, intgroup = c("condition", "time"), ntop = min(N_TOP_GENES_PCA, nrow(vsd)), returnData = TRUE)
percent_var <- round(100 * attr(pca, "percentVar"))
point_shapes <- rep_len(c(16, 17, 15, 18, 8, 3, 4, 7, 9, 10, 11, 12, 13, 14, 0, 1, 2, 5, 6), nlevels(metadata$time))
pca_plot <- ggplot(pca, aes(PC1, PC2, color = condition, shape = time, label = name)) +
  geom_point(size = 3) +
  geom_text(vjust = -0.8, size = 2.5, show.legend = FALSE) +
  scale_shape_manual(values = point_shapes) +
  xlab(paste0("PC1: ", percent_var[1], "% variance")) +
  ylab(paste0("PC2: ", percent_var[2], "% variance")) +
  scale_color_viridis_d(end = 0.8) +
  ggtitle("PCA of the samples, VST, top variable genes") +
  theme_classic()
save_figure(pca_plot, "pca")

top_genes <- head(results_table$gene[!is.na(results_table$pvalue)], N_TOP_GENES_HEATMAP)
if (length(top_genes) >= 2) {
  sample_order <- order(metadata$condition, metadata$time)
  heatmap_matrix <- assay(vsd)[top_genes, sample_order, drop = FALSE]
  annotation <- data.frame(condition = metadata$condition, time = metadata$time, row.names = colnames(vsd))[sample_order, , drop = FALSE]
  heatmap_title <- paste0("Top ", length(top_genes), " likelihood ratio test genes, VST, scaled by row")
  draw_heatmap <- function() {
    pheatmap(heatmap_matrix, scale = "row", cluster_cols = FALSE, annotation_col = annotation, fontsize_row = 6, main = heatmap_title)
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

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-deseq2-lrt-timecourse@1.0.0",
  method = "DESeq2 likelihood ratio test",
  full_design = deparse(FULL_DESIGN),
  reduced_design = deparse(REDUCED_DESIGN),
  terms_removed = as.list(removed_terms),
  df_tested = df_tested,
  condition = list(column = CONDITION_COLUMN, levels = as.list(levels(metadata$condition)), reference = REFERENCE_LEVEL),
  time = list(column = TIME_COLUMN, levels = as.list(levels(metadata$time))),
  n_samples = ncol(counts),
  cell_sizes = as.list(setNames(as.integer(cell_sizes), paste(rep(rownames(cell_sizes), times = ncol(cell_sizes)), rep(colnames(cell_sizes), each = nrow(cell_sizes)), sep = ":"))),
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(counts),
  n_genes_tested = n_tested,
  n_significant = n_significant,
  alpha = ALPHA,
  min_count = MIN_COUNT,
  min_samples = MIN_SAMPLES,
  n_top_genes_heatmap = N_TOP_GENES_HEATMAP,
  size_factors = as.list(setNames(round(sizeFactors(dds), 4), colnames(dds))),
  versions = list(
    R = R.version.string,
    DESeq2 = as.character(packageVersion("DESeq2")),
    ggplot2 = as.character(packageVersion("ggplot2")),
    pheatmap = as.character(packageVersion("pheatmap"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("lrt_results.csv"))
