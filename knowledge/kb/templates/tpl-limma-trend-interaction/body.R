#!/usr/bin/env Rscript
# tpl-limma-trend-interaction — limma-trend 2x2 factorial design with an interaction term on log-scale values.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: log2(value + offset) on a linear-scale abundance (TPM, FPKM, RPKM),
# or the values as they are when they are already on a log2 scale, an
# expression floor in at least the smallest cell, a linear model with lmFit on
# ~ factor_a * factor_b, empirical Bayes moderated t-statistics with a
# mean-variance trend and robust hyperparameter estimation (Ritchie et al.
# 2015; Phipson et al. 2016). The interaction test is the moderated t-test on
# the interaction coefficient. The simple effect of factor_b inside the
# reference level of factor_a is its main effect coefficient; inside the test
# level of factor_a it is the sum of that coefficient and the interaction
# coefficient, as a contrast (Law et al. 2020). No count model applies to such
# values.

suppressPackageStartupMessages({
  library(limma)
  library(ggplot2)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
ABUNDANCE_PATH     <- {{abundance_path}}  # [adaptable: abundance_path]
METADATA_PATH      <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN   <- {{sample_id_column}}  # [adaptable: sample_id_column]
FACTOR_A_COLUMN    <- {{factor_a_column}}  # [adaptable: factor_a_column]
FACTOR_A_REFERENCE <- {{factor_a_reference}}  # [adaptable: factor_a_reference]
FACTOR_B_COLUMN    <- {{factor_b_column}}  # [adaptable: factor_b_column]
FACTOR_B_REFERENCE <- {{factor_b_reference}}  # [adaptable: factor_b_reference]
VALUES_ARE_LOG     <- {{values_are_log}}  # [adaptable: values_are_log]
LOG_OFFSET         <- {{log_offset}}  # [adaptable: log_offset]
EXPRESSION_FLOOR   <- {{expression_floor}}  # [adaptable: expression_floor]
MIN_SAMPLES        <- {{min_samples}}  # [adaptable: min_samples] absent: the smallest cell size, computed below
TREND              <- {{trend}}
ROBUST             <- {{robust}}  # [adaptable: robust]
ALPHA              <- {{alpha}}
N_TOP_GENES_MDS    <- {{n_top_genes_mds}}  # [adaptable: n_top_genes_mds]
OUTPUT_PREFIX      <- {{output_prefix}}  # [adaptable: output_prefix]
DESIGN             <- ~ factor_a * factor_b  # the two main effects and their interaction (Law et al. 2020)

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))
file_token <- function(text) gsub("[^A-Za-z0-9_.-]", "_", text)

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
for (column in c(SAMPLE_ID_COLUMN, FACTOR_A_COLUMN, FACTOR_B_COLUMN)) {
  if (!column %in% colnames(metadata)) stop("The sample table has no column ", column)
}
if (FACTOR_A_COLUMN == FACTOR_B_COLUMN) stop("factor_a_column and factor_b_column name the same column")
rownames(metadata) <- as.character(metadata[[SAMPLE_ID_COLUMN]])
missing <- setdiff(colnames(values), rownames(metadata))
if (length(missing) > 0) stop("Samples in the abundance matrix but not in the sample table: ", paste(missing, collapse = ", "))
metadata <- metadata[colnames(values), , drop = FALSE]

two_level_factor <- function(column, reference, label) {
  factor_values <- factor(metadata[[column]])
  if (nlevels(factor_values) != 2) {
    stop("The ", label, " column ", column, " holds ", nlevels(factor_values), " levels (", paste(levels(factor_values), collapse = ", "), "); this template is for two levels per factor")
  }
  if (!reference %in% levels(factor_values)) stop("The ", label, " column ", column, " holds ", paste(levels(factor_values), collapse = ", "), " but not the reference ", reference)
  relevel(factor_values, ref = reference)
}
metadata$factor_a <- two_level_factor(FACTOR_A_COLUMN, FACTOR_A_REFERENCE, "factor_a")
metadata$factor_b <- two_level_factor(FACTOR_B_COLUMN, FACTOR_B_REFERENCE, "factor_b")
FACTOR_A_TEST <- setdiff(levels(metadata$factor_a), FACTOR_A_REFERENCE)
FACTOR_B_TEST <- setdiff(levels(metadata$factor_b), FACTOR_B_REFERENCE)
cell_sizes <- table(metadata$factor_a, metadata$factor_b)
cell_text <- paste(sprintf("%s:%s=%d", rep(rownames(cell_sizes), times = 2), rep(colnames(cell_sizes), each = 2), as.integer(cell_sizes)), collapse = ", ")
if (any(cell_sizes == 0)) stop("A cell of the 2x2 design holds no sample: ", cell_text)
if (any(cell_sizes < 2)) message("Warning: a cell holds one sample only, thus the interaction test has low power. Cell sizes: ", cell_text)
message("Samples: ", ncol(values), "; genes: ", nrow(values), "; design: ", deparse(DESIGN))
message("factor_a ", FACTOR_A_COLUMN, ": ", FACTOR_A_TEST, " vs ", FACTOR_A_REFERENCE, "; factor_b ", FACTOR_B_COLUMN, ": ", FACTOR_B_TEST, " vs ", FACTOR_B_REFERENCE, "; cells: ", cell_text)

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
if (is.na(MIN_SAMPLES)) MIN_SAMPLES <- as.integer(min(cell_sizes))
keep <- rowSums(log_expression >= EXPRESSION_FLOOR) >= MIN_SAMPLES
message("Expression filter: keep genes with log2 expression >= ", EXPRESSION_FLOOR, " in >= ", MIN_SAMPLES, " samples: ", sum(keep), " of ", nrow(log_expression), " kept")
if (sum(keep) < 2) stop("Fewer than two genes pass the expression filter. Lower expression_floor or make sure that the values are on the expected scale.")
log_expression <- log_expression[keep, , drop = FALSE]

# ── Model design ──────────────────────────────────────────────────────────────
design <- model.matrix(DESIGN, data = metadata)
b_coefficient <- paste0("factor_b", FACTOR_B_TEST)
interaction_coefficient <- paste0("factor_a", FACTOR_A_TEST, ":factor_b", FACTOR_B_TEST)
for (expected in c(b_coefficient, interaction_coefficient)) {
  if (!expected %in% colnames(design)) stop("The coefficient ", expected, " is not in the design columns: ", paste(colnames(design), collapse = ", "))
}
if (ncol(design) >= ncol(log_expression)) stop("The design has ", ncol(design), " coefficients for ", ncol(log_expression), " samples, thus no residual degree of freedom remains.")
message("Interaction coefficient: ", interaction_coefficient, "; factor_b main effect: ", b_coefficient)

# ── Linear model and moderated statistics ─────────────────────────────────────
message("eBayes: moderated t-tests (trend = ", TREND, ", robust = ", ROBUST, ")")
fit <- lmFit(log_expression, design)
fit <- eBayes(fit, trend = TREND, robust = ROBUST)
message("Prior degrees of freedom: ", paste(round(range(fit$df.prior), 2), collapse = " to "))

# One moderated t-test per table. `coef` names one coefficient of the fit;
# `contrast` gives a numeric contrast over the coefficients, fitted with
# contrasts.fit and its own eBayes.
moderated_table <- function(label, coef = NULL, contrast = NULL) {
  if (!is.null(coef)) {
    top <- topTable(fit, coef = coef, number = Inf, sort.by = "P", adjust.method = "BH")
  } else {
    contrast_fit <- eBayes(contrasts.fit(lmFit(log_expression, design), contrast), trend = TREND, robust = ROBUST)
    top <- topTable(contrast_fit, coef = 1, number = Inf, sort.by = "P", adjust.method = "BH")
  }
  table <- data.frame(
    gene = rownames(top),
    log_expression_mean = top$AveExpr,
    log2_fold_change = top$logFC,
    t_stat = top$t,
    pvalue = top$P.Value,
    adjusted_pvalue = top$adj.P.Val,
    stringsAsFactors = FALSE
  )
  n_significant <- sum(!is.na(table$adjusted_pvalue) & table$adjusted_pvalue < ALPHA)
  n_up <- sum(!is.na(table$adjusted_pvalue) & table$adjusted_pvalue < ALPHA & table$log2_fold_change > 0)
  message(label, ": ", nrow(table), " genes tested; ", n_significant, " at adjusted p < ", ALPHA, " (", n_up, " up, ", n_significant - n_up, " down)")
  list(table = table, counts = list(n_genes_tested = nrow(table), n_significant = n_significant, n_up = n_up, n_down = n_significant - n_up))
}

interaction_label <- paste0(FACTOR_A_COLUMN, ":", FACTOR_B_COLUMN, " (", FACTOR_A_TEST, " x ", FACTOR_B_TEST, ")")
interaction <- moderated_table(paste("interaction", interaction_label), coef = interaction_coefficient)
write.csv(interaction$table, out("interaction_results.csv"), row.names = FALSE)

simple_effect_label <- function(level_a) paste0(FACTOR_B_TEST, " vs ", FACTOR_B_REFERENCE, " inside ", FACTOR_A_COLUMN, " = ", level_a)
simple_reference <- moderated_table(simple_effect_label(FACTOR_A_REFERENCE), coef = b_coefficient)
write.csv(simple_reference$table, out(paste0("simple_effect_", file_token(FACTOR_A_REFERENCE), ".csv")), row.names = FALSE)
simple_contrast <- as.numeric(colnames(design) %in% c(b_coefficient, interaction_coefficient))
simple_test <- moderated_table(simple_effect_label(FACTOR_A_TEST), contrast = simple_contrast)
write.csv(simple_test$table, out(paste0("simple_effect_", file_token(FACTOR_A_TEST), ".csv")), row.names = FALSE)

write.csv(data.frame(gene = rownames(log_expression), log_expression, check.names = FALSE), out("log_expression.csv"), row.names = FALSE)

# ── Figures ───────────────────────────────────────────────────────────────────
mds <- plotMDS(log_expression, top = min(N_TOP_GENES_MDS, nrow(log_expression)), plot = FALSE)
mds_df <- data.frame(sample = colnames(log_expression), dim1 = mds$x, dim2 = mds$y, factor_a = metadata$factor_a, factor_b = metadata$factor_b, stringsAsFactors = FALSE)
var_explained <- round(100 * mds$var.explained[1:2])
mds_plot <- ggplot(mds_df, aes(dim1, dim2, color = factor_a, shape = factor_b, label = sample)) +
  geom_point(size = 3) +
  geom_text(vjust = -0.8, size = 2.5, show.legend = FALSE) +
  xlab(paste0("Leading logFC dim 1 (", var_explained[1], "%)")) +
  ylab(paste0("Leading logFC dim 2 (", var_explained[2], "%)")) +
  scale_color_viridis_d(end = 0.8, name = FACTOR_A_COLUMN) +
  scale_shape_discrete(name = FACTOR_B_COLUMN) +
  ggtitle("MDS of the samples, log2 expression, top variable genes") +
  theme_classic()
save_figure(mds_plot, "mds")

draw_mean_variance <- function() {
  plotSA(fit, xlab = "Mean log2 expression", ylab = "sqrt(residual standard deviation)", main = "limma-trend: mean-variance relation")
}
save_base_figure(draw_mean_variance, "mean_variance")

plot_df <- interaction$table[!is.na(interaction$table$adjusted_pvalue), ]
plot_df$significant <- plot_df$adjusted_pvalue < ALPHA
top_labels <- head(plot_df[order(plot_df$adjusted_pvalue), ], 15)
volcano_plot <- ggplot(plot_df, aes(x = log2_fold_change, y = -log10(adjusted_pvalue), color = significant)) +
  geom_point(size = 0.6, alpha = 0.6) +
  geom_text(data = top_labels, aes(label = gene), size = 2.5, vjust = -0.6, show.legend = FALSE) +
  scale_color_manual(values = c(`FALSE` = "grey60", `TRUE` = "#21908C"), name = paste0("adj. p < ", ALPHA)) +
  geom_hline(yintercept = -log10(ALPHA), linetype = "dashed") +
  xlab("Interaction log2 fold change") + ylab("-log10 adjusted p-value") +
  ggtitle(paste0("Volcano, interaction: ", interaction_label)) +
  theme_classic()
save_figure(volcano_plot, "volcano")

# ── Summary ───────────────────────────────────────────────────────────────────
cell_sizes_record <- setNames(lapply(rownames(cell_sizes), function(level_a) {
  as.list(setNames(as.integer(cell_sizes[level_a, ]), colnames(cell_sizes)))
}), rownames(cell_sizes))
simple_effects_record <- list()
simple_effects_record[[FACTOR_A_REFERENCE]] <- c(list(coefficients = b_coefficient, file = basename(out(paste0("simple_effect_", file_token(FACTOR_A_REFERENCE), ".csv")))), simple_reference$counts)
simple_effects_record[[FACTOR_A_TEST]] <- c(list(coefficients = c(b_coefficient, interaction_coefficient), file = basename(out(paste0("simple_effect_", file_token(FACTOR_A_TEST), ".csv")))), simple_test$counts)

summary_record <- list(
  template = "tpl-limma-trend-interaction@1.0.0",
  method = "limma-trend, moderated t-test on the interaction coefficient",
  design = deparse(DESIGN),
  factor_a = list(column = FACTOR_A_COLUMN, reference = FACTOR_A_REFERENCE, test = FACTOR_A_TEST),
  factor_b = list(column = FACTOR_B_COLUMN, reference = FACTOR_B_REFERENCE, test = FACTOR_B_TEST),
  transform = transform,
  values_are_log = VALUES_ARE_LOG,
  log_offset = if (VALUES_ARE_LOG) NA else LOG_OFFSET,
  n_samples = ncol(log_expression),
  cell_sizes = cell_sizes_record,
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(log_expression),
  interaction = c(list(coefficient = interaction_coefficient), interaction$counts),
  simple_effects = simple_effects_record,
  alpha = ALPHA,
  adjust_method = "BH",
  trend = TREND,
  robust = ROBUST,
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
message("Done: ", out("interaction_results.csv"))
