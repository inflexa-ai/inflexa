#!/usr/bin/env Rscript
# tpl-limma-trend-timecourse — limma-trend moderated F-test for a time course on log-scale values.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: log2(value + offset) on a linear-scale abundance (TPM, FPKM, RPKM),
# or the values as they are when they are already on a log2 scale, an
# expression floor in at least the smallest cell, a linear model with lmFit on
# the full design, empirical Bayes moderated statistics with a mean-variance
# trend and robust hyperparameter estimation (Ritchie et al. 2015; Phipson et
# al. 2016). The test is the moderated F-test over the coefficients that the
# full design holds and the reduced design does not (Law et al. 2020). With a
# condition column and the default designs these are the condition:time
# terms, thus the test finds the genes whose condition effect differs between
# time points. With one group and the designs ~ time against ~ 1 it finds the
# genes that change over time. The per-timepoint log2 fold changes are
# contrasts of the fitted coefficients. No count model applies to such values.

suppressPackageStartupMessages({
  library(limma)
  library(ggplot2)
  library(pheatmap)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
ABUNDANCE_PATH      <- {{abundance_path}}  # [adaptable: abundance_path]
METADATA_PATH       <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN    <- {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN    <- {{condition_column}}  # [adaptable: condition_column] absent: one group over time
REFERENCE_LEVEL     <- {{reference_level}}  # [adaptable: reference_level] absent: one group over time
TIME_COLUMN         <- {{time_column}}  # [adaptable: time_column]
TIME_ORDER          <- {{time_order}}  # [adaptable: time_order] absent: the order of first appearance in the sample table
FULL_DESIGN         <- {{full_design}}  # [adaptable: full_design]
REDUCED_DESIGN      <- {{reduced_design}}  # [adaptable: reduced_design]
VALUES_ARE_LOG      <- {{values_are_log}}  # [adaptable: values_are_log]
LOG_OFFSET          <- {{log_offset}}  # [adaptable: log_offset]
EXPRESSION_FLOOR    <- {{expression_floor}}  # [adaptable: expression_floor]
MIN_SAMPLES         <- {{min_samples}}  # [adaptable: min_samples] absent: the smallest condition-by-time cell, computed below
TREND               <- {{trend}}
ROBUST              <- {{robust}}  # [adaptable: robust]
ALPHA               <- {{alpha}}
N_TOP_GENES_MDS     <- {{n_top_genes_mds}}  # [adaptable: n_top_genes_mds]
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

save_base_figure <- function(draw, name, width = 6, height = 5) {
  png(fig(paste0(name, ".png")), width = width, height = height, units = "in", res = 300)
  draw()
  dev.off()
  pdf(fig(paste0(name, ".pdf")), width = width, height = height)
  draw()
  dev.off()
}

has_condition <- !is.na(CONDITION_COLUMN)
if (has_condition && is.na(REFERENCE_LEVEL)) stop("A condition column needs a reference_level")
if (!has_condition && !is.na(REFERENCE_LEVEL)) stop("A reference_level needs a condition_column")

# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading the abundance matrix from ", ABUNDANCE_PATH)
abundance_df <- read.csv(ABUNDANCE_PATH, check.names = FALSE, stringsAsFactors = FALSE)
gene_ids <- as.character(abundance_df[[1]])
values <- as.matrix(abundance_df[, -1, drop = FALSE])
storage.mode(values) <- "numeric"
rownames(values) <- gene_ids
if (any(is.na(values))) stop("The abundance matrix holds a missing or non-numeric value")
if (any(duplicated(gene_ids))) stop("The abundance matrix holds a duplicated gene identifier")

message("Reading the sample table from ", METADATA_PATH)
metadata <- read.csv(METADATA_PATH, check.names = FALSE, stringsAsFactors = FALSE)
for (column in c(SAMPLE_ID_COLUMN, if (has_condition) CONDITION_COLUMN, TIME_COLUMN)) {
  if (!column %in% colnames(metadata)) stop("The sample table has no column ", column)
}
rownames(metadata) <- as.character(metadata[[SAMPLE_ID_COLUMN]])
missing <- setdiff(colnames(values), rownames(metadata))
if (length(missing) > 0) stop("Samples in the abundance matrix but not in the sample table: ", paste(missing, collapse = ", "))
metadata <- metadata[colnames(values), , drop = FALSE]

if (has_condition) {
  metadata$condition <- factor(metadata[[CONDITION_COLUMN]])
  if (!REFERENCE_LEVEL %in% levels(metadata$condition)) {
    stop("The condition column holds ", paste(levels(metadata$condition), collapse = ", "), " but not ", REFERENCE_LEVEL)
  }
  if (nlevels(metadata$condition) < 2) stop("The condition column holds one level only. For one group over time, leave condition_column absent and set full_design ~ time and reduced_design ~ 1.")
  metadata$condition <- relevel(metadata$condition, ref = REFERENCE_LEVEL)
} else if ("condition" %in% union(all.vars(FULL_DESIGN), all.vars(REDUCED_DESIGN))) {
  stop("A design names condition, but no condition_column is set. For one group over time, set full_design ~ time and reduced_design ~ 1.")
}

time_values <- as.character(metadata[[TIME_COLUMN]])
if (length(TIME_ORDER) == 0) {
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
if (!"time" %in% all.vars(FULL_DESIGN)) stop("The full design must name time")
if (has_condition && !"condition" %in% all.vars(FULL_DESIGN)) stop("The full design must name condition when a condition column is set")
full_terms <- attr(terms(FULL_DESIGN), "term.labels")
reduced_terms <- attr(terms(REDUCED_DESIGN), "term.labels")
extra_terms <- setdiff(reduced_terms, full_terms)
if (length(extra_terms) > 0) stop("The reduced design holds terms that the full design does not: ", paste(extra_terms, collapse = ", "))
removed_terms <- setdiff(full_terms, reduced_terms)
if (length(removed_terms) == 0) stop("The reduced design holds every term of the full design; the test has nothing to remove")
design <- model.matrix(FULL_DESIGN, data = metadata)
reduced_model_matrix <- model.matrix(REDUCED_DESIGN, data = metadata)
tested_columns <- setdiff(colnames(design), colnames(reduced_model_matrix))
df_tested <- length(tested_columns)
if (df_tested < 1) stop("The full design has no more coefficients than the reduced design")
if (qr(design)$rank < ncol(design)) stop("The full design matrix is not of full rank. Remove a term that is confounded with another term.")
if (ncol(design) >= ncol(values)) stop("The full design has ", ncol(design), " coefficients for ", ncol(values), " samples, thus no residual degree of freedom remains.")

message("Samples: ", ncol(values), "; genes: ", nrow(values))
message("Full design: ", deparse(FULL_DESIGN), "; reduced design: ", deparse(REDUCED_DESIGN))
message("Coefficients tested: ", paste(tested_columns, collapse = ", "), " (", df_tested, " degrees of freedom)")
if (has_condition) message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "), " (reference ", REFERENCE_LEVEL, ")")
message("Time levels: ", paste(levels(metadata$time), collapse = ", "))

# ── Normalize: the log2 scale ─────────────────────────────────────────────────
if (VALUES_ARE_LOG) {
  transform <- "none (the values are log2 already)"
  log_expression <- values
  if (max(values) > 50) message("Note: the largest value is ", round(max(values), 1), ", which is large for a log2 value. Make sure that values_are_log is correct.")
} else {
  transform <- paste0("log2(value + ", LOG_OFFSET, ")")
  if (any(values < 0)) stop("The abundance matrix holds a negative value. A linear-scale abundance is not negative. If the values are log2 already, set values_are_log to true.")
  if (any(values + LOG_OFFSET <= 0)) stop("A value plus the offset ", LOG_OFFSET, " is not positive, thus its log2 is not finite. Use a positive log_offset.")
  if (all(abs(values - round(values)) < 1e-6)) message("Note: every value is an integer. If the matrix holds raw counts, a count model is the correct method.")
  log_expression <- log2(values + LOG_OFFSET)
}
message("Transform: ", transform)

# ── Filter ────────────────────────────────────────────────────────────────────
cell_sizes <- if (has_condition) table(metadata$condition, metadata$time) else table(metadata$time)
if (is.na(MIN_SAMPLES)) MIN_SAMPLES <- as.integer(min(cell_sizes[cell_sizes > 0]))
keep <- rowSums(log_expression >= EXPRESSION_FLOOR) >= MIN_SAMPLES
message("Expression filter: keep genes with log2 expression >= ", EXPRESSION_FLOOR, " in >= ", MIN_SAMPLES, " samples: ", sum(keep), " of ", nrow(log_expression), " kept")
if (sum(keep) < 2) stop("Fewer than two genes pass the expression filter. Lower expression_floor or make sure that the values are on the expected scale.")
log_expression <- log_expression[keep, , drop = FALSE]

# ── Linear model and the moderated F-test ─────────────────────────────────────
message("eBayes: moderated statistics (trend = ", TREND, ", robust = ", ROBUST, ")")
fit <- lmFit(log_expression, design)
fit <- eBayes(fit, trend = TREND, robust = ROBUST)
message("Prior degrees of freedom: ", paste(round(range(fit$df.prior), 2), collapse = " to "))
f_table <- topTable(fit, coef = tested_columns, number = Inf, sort.by = if (df_tested == 1) "P" else "F", adjust.method = "BH")
results_table <- data.frame(
  gene = rownames(f_table),
  log_expression_mean = f_table$AveExpr,
  f_stat = if (df_tested == 1) f_table$t^2 else f_table$F,
  pvalue = f_table$P.Value,
  adjusted_pvalue = f_table$adj.P.Val,
  stringsAsFactors = FALSE
)
write.csv(results_table, out("f_test_results.csv"), row.names = FALSE)
n_tested <- nrow(results_table)
n_significant <- sum(!is.na(results_table$adjusted_pvalue) & results_table$adjusted_pvalue < ALPHA)
message("Tested ", n_tested, " genes; ", n_significant, " at adjusted p < ", ALPHA)

# ── Per-timepoint log2 fold changes as contrasts of the coefficients ─────────
# A contrast is the difference between two rows of the full model matrix, with
# every other column of the sample table held equal, thus an additive covariate
# cancels. With a condition: the condition level against the reference at each
# time point. In every case: each time point against the first, within each
# condition level.
coefficients <- fit$coefficients
template_rows <- metadata[c(1, 1), all.vars(FULL_DESIGN), drop = FALSE]
contrast_vector <- function(condition_a, time_a, condition_b, time_b) {
  rows <- template_rows
  if (has_condition) rows$condition <- factor(c(condition_a, condition_b), levels = levels(metadata$condition))
  rows$time <- factor(c(time_a, time_b), levels = levels(metadata$time))
  contrast_matrix <- model.matrix(FULL_DESIGN, data = rows)
  if (ncol(contrast_matrix) != ncol(coefficients)) {
    stop("The contrast has ", ncol(contrast_matrix), " columns but the model has ", ncol(coefficients), " coefficients")
  }
  contrast_matrix[1, ] - contrast_matrix[2, ]
}
contrasts <- list()
condition_levels <- if (has_condition) levels(metadata$condition) else NA_character_
if (has_condition) {
  for (level in setdiff(condition_levels, REFERENCE_LEVEL)) {
    for (time_level in levels(metadata$time)) {
      contrasts[[paste0(level, "_vs_", REFERENCE_LEVEL, "_at_", time_level)]] <- contrast_vector(level, time_level, REFERENCE_LEVEL, time_level)
    }
  }
}
first_time <- levels(metadata$time)[1]
for (level in condition_levels) {
  for (time_level in levels(metadata$time)[-1]) {
    name <- paste0(time_level, "_vs_", first_time, if (has_condition) paste0("_in_", level) else "")
    contrasts[[name]] <- contrast_vector(level, time_level, level, first_time)
  }
}
significant_genes <- results_table$gene[!is.na(results_table$adjusted_pvalue) & results_table$adjusted_pvalue < ALPHA]
timepoint_lfc <- data.frame(
  gene = significant_genes,
  adjusted_pvalue = results_table$adjusted_pvalue[match(significant_genes, results_table$gene)],
  stringsAsFactors = FALSE
)
for (name in names(contrasts)) {
  timepoint_lfc[[paste0("lfc_", name)]] <- as.numeric(coefficients[significant_genes, , drop = FALSE] %*% contrasts[[name]])
}
write.csv(timepoint_lfc, out("timepoint_lfc.csv"), row.names = FALSE)
message("Per-timepoint log2 fold changes for ", nrow(timepoint_lfc), " significant genes: ", out("timepoint_lfc.csv"))

write.csv(data.frame(gene = rownames(log_expression), log_expression, check.names = FALSE), out("log_expression.csv"), row.names = FALSE)

# ── Figures ───────────────────────────────────────────────────────────────────
mds <- plotMDS(log_expression, top = min(N_TOP_GENES_MDS, nrow(log_expression)), plot = FALSE)
mds_df <- data.frame(sample = colnames(log_expression), dim1 = mds$x, dim2 = mds$y, time = metadata$time, stringsAsFactors = FALSE)
if (has_condition) mds_df$condition <- metadata$condition
var_explained <- round(100 * mds$var.explained[1:2])
point_shapes <- rep_len(c(16, 17, 15, 18, 8, 3, 4, 7, 9, 10, 11, 12, 13, 14, 0, 1, 2, 5, 6), nlevels(metadata$time))
mds_plot <- if (has_condition) {
  ggplot(mds_df, aes(dim1, dim2, color = condition, shape = time, label = sample)) + scale_shape_manual(values = point_shapes)
} else {
  ggplot(mds_df, aes(dim1, dim2, color = time, label = sample))
}
mds_plot <- mds_plot +
  geom_point(size = 3) +
  geom_text(vjust = -0.8, size = 2.5, show.legend = FALSE) +
  xlab(paste0("Leading logFC dim 1 (", var_explained[1], "%)")) +
  ylab(paste0("Leading logFC dim 2 (", var_explained[2], "%)")) +
  scale_color_viridis_d(end = 0.8) +
  ggtitle("MDS of the samples, log2 expression, top variable genes") +
  theme_classic()
save_figure(mds_plot, "mds")

draw_mean_variance <- function() {
  plotSA(fit, xlab = "Mean log2 expression", ylab = "sqrt(residual standard deviation)", main = "limma-trend: mean-variance relation")
}
save_base_figure(draw_mean_variance, "mean_variance")

top_genes <- head(results_table$gene[!is.na(results_table$pvalue)], N_TOP_GENES_HEATMAP)
if (length(top_genes) >= 2) {
  sample_order <- if (has_condition) order(metadata$condition, metadata$time) else order(metadata$time)
  heatmap_matrix <- log_expression[top_genes, sample_order, drop = FALSE]
  annotation <- if (has_condition) {
    data.frame(condition = metadata$condition, time = metadata$time, row.names = colnames(log_expression))
  } else {
    data.frame(time = metadata$time, row.names = colnames(log_expression))
  }
  annotation <- annotation[sample_order, , drop = FALSE]
  heatmap_title <- paste0("Top ", length(top_genes), " moderated F-test genes, log2 expression, scaled by row")
  draw_heatmap <- function() {
    pheatmap(heatmap_matrix, scale = "row", cluster_cols = FALSE, annotation_col = annotation, fontsize_row = 6, main = heatmap_title)
  }
  save_base_figure(draw_heatmap, "top_genes_heatmap", width = 7, height = 8)
} else {
  message("Fewer than 2 genes have a p-value; no heatmap")
}

# ── Summary ───────────────────────────────────────────────────────────────────
cell_size_names <- if (has_condition) {
  paste(rep(rownames(cell_sizes), times = ncol(cell_sizes)), rep(colnames(cell_sizes), each = nrow(cell_sizes)), sep = ":")
} else {
  names(cell_sizes)
}
summary_record <- list(
  template = "tpl-limma-trend-timecourse@1.0.0",
  method = "limma-trend: moderated F-test over the coefficients the reduced design drops",
  full_design = deparse(FULL_DESIGN),
  reduced_design = deparse(REDUCED_DESIGN),
  terms_removed = as.list(removed_terms),
  coefficients_tested = as.list(tested_columns),
  df_tested = df_tested,
  condition = if (has_condition) list(column = CONDITION_COLUMN, levels = as.list(levels(metadata$condition)), reference = REFERENCE_LEVEL) else NULL,
  n_condition_levels = if (has_condition) nlevels(metadata$condition) else 1L,
  time = list(column = TIME_COLUMN, levels = as.list(levels(metadata$time))),
  contrasts = as.list(names(contrasts)),
  transform = transform,
  values_are_log = VALUES_ARE_LOG,
  log_offset = if (VALUES_ARE_LOG) NA else LOG_OFFSET,
  n_samples = ncol(log_expression),
  cell_sizes = as.list(setNames(as.integer(cell_sizes), cell_size_names)),
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(log_expression),
  n_genes_tested = n_tested,
  n_significant = n_significant,
  alpha = ALPHA,
  adjust_method = "BH",
  trend = TREND,
  robust = ROBUST,
  expression_floor = EXPRESSION_FLOOR,
  min_samples = MIN_SAMPLES,
  n_top_genes_heatmap = N_TOP_GENES_HEATMAP,
  df_prior = if (length(fit$df.prior) == 1) fit$df.prior else list(min = min(fit$df.prior), max = max(fit$df.prior)),
  versions = list(
    R = R.version.string,
    limma = as.character(packageVersion("limma"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA, null = "null")
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("f_test_results.csv"))
