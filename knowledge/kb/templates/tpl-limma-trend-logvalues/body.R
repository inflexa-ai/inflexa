#!/usr/bin/env Rscript
# tpl-limma-trend-logvalues — limma-trend two-group differential expression on log-scale values.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: log2(value + offset) on a linear-scale abundance (TPM, FPKM, RPKM),
# or the values as they are when they are already on a log2 scale, an
# expression floor in at least the smallest group, a linear model with lmFit,
# empirical Bayes moderated t-statistics with a mean-variance trend on the
# prior variance and robust hyperparameter estimation, and Benjamini-Hochberg
# adjusted p-values (Ritchie et al. 2015; Phipson et al. 2016). No count model
# applies to such values.

suppressPackageStartupMessages({
  library(limma)
  library(ggplot2)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
ABUNDANCE_PATH   <- {{abundance_path}}  # [adaptable: abundance_path]
METADATA_PATH    <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN <- {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN <- {{condition_column}}  # [adaptable: condition_column]
REFERENCE_LEVEL  <- {{reference_level}}  # [adaptable: reference_level]
TEST_LEVEL       <- {{test_level}}  # [adaptable: test_level]
DESIGN           <- {{design}}  # [adaptable: design]
VALUES_ARE_LOG   <- {{values_are_log}}  # [adaptable: values_are_log]
LOG_OFFSET       <- {{log_offset}}  # [adaptable: log_offset]
EXPRESSION_FLOOR <- {{expression_floor}}  # [adaptable: expression_floor]
{{#if min_samples}}
MIN_SAMPLES      <- {{min_samples}}  # [adaptable: min_samples]
{{/if}}
{{#unless min_samples}}
MIN_SAMPLES      <- NA_integer_  # [adaptable: min_samples] NA: the smallest group size, computed below
{{/unless}}
TREND            <- {{trend}}
ROBUST           <- {{robust}}  # [adaptable: robust]
ALPHA            <- {{alpha}}
LFC_THRESHOLD    <- {{lfc_threshold}}  # [adaptable: lfc_threshold]
N_TOP_GENES_MDS  <- {{n_top_genes_mds}}  # [adaptable: n_top_genes_mds]
OUTPUT_PREFIX    <- {{output_prefix}}  # [adaptable: output_prefix]

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
if (!SAMPLE_ID_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", SAMPLE_ID_COLUMN)
if (!CONDITION_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", CONDITION_COLUMN)
rownames(metadata) <- as.character(metadata[[SAMPLE_ID_COLUMN]])
missing <- setdiff(colnames(values), rownames(metadata))
if (length(missing) > 0) stop("Samples in the abundance matrix but not in the sample table: ", paste(missing, collapse = ", "))
metadata <- metadata[colnames(values), , drop = FALSE]
metadata$condition <- factor(metadata[[CONDITION_COLUMN]])
if (!all(c(REFERENCE_LEVEL, TEST_LEVEL) %in% levels(metadata$condition))) {
  stop("The condition column holds ", paste(levels(metadata$condition), collapse = ", "), " but not both ", REFERENCE_LEVEL, " and ", TEST_LEVEL)
}
metadata$condition <- relevel(metadata$condition, ref = REFERENCE_LEVEL)
for (column in setdiff(all.vars(DESIGN), "condition")) {
  if (!column %in% colnames(metadata)) stop("The design names ", column, " but the sample table has no such column")
  if (is.character(metadata[[column]])) metadata[[column]] <- factor(metadata[[column]])
}
message("Samples: ", ncol(values), "; genes: ", nrow(values), "; design: ", deparse(DESIGN))
message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "), " (reference ", REFERENCE_LEVEL, ")")

# ── Normalize: the log2 scale ─────────────────────────────────────────────────
# A TPM, FPKM, or RPKM value is already scaled within its sample. The transform
# to log2 gives the scale on which the linear model and the variance trend
# apply. A value that is already on the log2 scale stays as it is.
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
group_sizes <- table(metadata$condition)
if (is.na(MIN_SAMPLES)) MIN_SAMPLES <- as.integer(min(group_sizes))
keep <- rowSums(log_expression >= EXPRESSION_FLOOR) >= MIN_SAMPLES
message("Expression filter: keep genes with log2 expression >= ", EXPRESSION_FLOOR, " in >= ", MIN_SAMPLES, " samples: ", sum(keep), " of ", nrow(log_expression), " kept")
if (sum(keep) < 2) stop("Fewer than two genes pass the expression filter. Lower expression_floor or make sure that the values are on the expected scale.")
log_expression <- log_expression[keep, , drop = FALSE]

# ── Model design ──────────────────────────────────────────────────────────────
design <- model.matrix(DESIGN, data = metadata)
coefficient <- paste0("condition", TEST_LEVEL)
if (!coefficient %in% colnames(design)) {
  stop("The coefficient ", coefficient, " is not in the design columns: ", paste(colnames(design), collapse = ", "))
}
if (qr(design)$rank < ncol(design)) stop("The design matrix is not of full rank. Remove a term that is confounded with another term.")
if (ncol(design) >= ncol(log_expression)) stop("The design has ", ncol(design), " coefficients for ", ncol(log_expression), " samples, thus no residual degree of freedom remains.")

# ── Linear model and moderated statistics ─────────────────────────────────────
fit <- lmFit(log_expression, design)
if (LFC_THRESHOLD > 0) {
  message("treat: moderated t-test relative to |log2 fold change| > ", LFC_THRESHOLD, " (trend = ", TREND, ", robust = ", ROBUST, ")")
  fit <- treat(fit, lfc = LFC_THRESHOLD, trend = TREND, robust = ROBUST)
  top <- topTreat(fit, coef = coefficient, number = Inf, sort.by = "P", adjust.method = "BH")
} else {
  message("eBayes: moderated t-test (trend = ", TREND, ", robust = ", ROBUST, ")")
  fit <- eBayes(fit, trend = TREND, robust = ROBUST)
  top <- topTable(fit, coef = coefficient, number = Inf, sort.by = "P", adjust.method = "BH")
}
message("Prior degrees of freedom: ", paste(round(range(fit$df.prior), 2), collapse = " to "))

# ── Results table ─────────────────────────────────────────────────────────────
results_table <- data.frame(
  gene = rownames(top),
  log_expression_mean = top$AveExpr,
  log2_fold_change = top$logFC,
  pvalue = top$P.Value,
  adjusted_pvalue = top$adj.P.Val,
  stringsAsFactors = FALSE
)
write.csv(results_table, out("results.csv"), row.names = FALSE)

write.csv(data.frame(gene = rownames(log_expression), log_expression, check.names = FALSE), out("log_expression.csv"), row.names = FALSE)

n_tested <- nrow(results_table)
n_significant <- sum(!is.na(results_table$adjusted_pvalue) & results_table$adjusted_pvalue < ALPHA)
n_up <- sum(!is.na(results_table$adjusted_pvalue) & results_table$adjusted_pvalue < ALPHA & results_table$log2_fold_change > 0)
n_down <- n_significant - n_up
message("Tested ", n_tested, " genes; ", n_significant, " at adjusted p < ", ALPHA, " (", n_up, " up, ", n_down, " down)")

# ── Figures ───────────────────────────────────────────────────────────────────
mds <- plotMDS(log_expression, top = min(N_TOP_GENES_MDS, nrow(log_expression)), plot = FALSE)
mds_df <- data.frame(
  sample = colnames(log_expression),
  dim1 = mds$x,
  dim2 = mds$y,
  condition = metadata$condition,
  stringsAsFactors = FALSE
)
var_explained <- round(100 * mds$var.explained[1:2])
mds_plot <- ggplot(mds_df, aes(dim1, dim2, color = condition, label = sample)) +
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

plot_df <- results_table[!is.na(results_table$adjusted_pvalue), ]
plot_df$significant <- plot_df$adjusted_pvalue < ALPHA
top_labels <- head(plot_df[order(plot_df$adjusted_pvalue), ], 15)
volcano_plot <- ggplot(plot_df, aes(x = log2_fold_change, y = -log10(adjusted_pvalue), color = significant)) +
  geom_point(size = 0.6, alpha = 0.6) +
  geom_text(data = top_labels, aes(label = gene), size = 2.5, vjust = -0.6, show.legend = FALSE) +
  scale_color_manual(values = c(`FALSE` = "grey60", `TRUE` = "#21908C"), name = paste0("adj. p < ", ALPHA)) +
  geom_hline(yintercept = -log10(ALPHA), linetype = "dashed") +
  xlab("log2 fold change") + ylab("-log10 adjusted p-value") +
  ggtitle(paste0("Volcano: ", TEST_LEVEL, " vs ", REFERENCE_LEVEL)) +
  theme_classic()
save_figure(volcano_plot, "volcano")

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-limma-trend-logvalues@1.0.0",
  method = if (LFC_THRESHOLD > 0) "limma-trend, treat" else "limma-trend, moderated t-test",
  contrast = list(factor = "condition", test = TEST_LEVEL, reference = REFERENCE_LEVEL, coefficient = coefficient),
  design = deparse(DESIGN),
  transform = transform,
  values_are_log = VALUES_ARE_LOG,
  log_offset = if (VALUES_ARE_LOG) NA else LOG_OFFSET,
  n_samples = ncol(log_expression),
  group_sizes = as.list(group_sizes),
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(log_expression),
  n_genes_tested = n_tested,
  n_significant = n_significant,
  n_up = n_up,
  n_down = n_down,
  alpha = ALPHA,
  adjust_method = "BH",
  trend = TREND,
  robust = ROBUST,
  lfc_threshold = LFC_THRESHOLD,
  expression_floor = EXPRESSION_FLOOR,
  min_samples = MIN_SAMPLES,
  df_prior = if (length(fit$df.prior) == 1) fit$df.prior else list(min = min(fit$df.prior), max = max(fit$df.prior)),
  versions = list(
    R = R.version.string,
    limma = as.character(packageVersion("limma"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("results.csv"))
