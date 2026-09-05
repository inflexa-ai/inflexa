#!/usr/bin/env Rscript
# tpl-limma-voom-fixed — limma-voom with a fixed-effects linear model for a two-group design.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: edgeR filterByExpr and TMM library size scaling factors, voom
# precision weights on log-CPM, a fixed-effects linear model with the
# covariates before the condition, robust empirical Bayes moderated
# t-statistics on the condition coefficient, and Benjamini-Hochberg adjusted
# p-values (Law et al. 2014; Ritchie et al. 2015; Phipson et al. 2016). The
# path for a population-scale cohort, where the count models over-call
# (Li et al. 2022), and also valid at a small replicate number.

suppressPackageStartupMessages({
  library(edgeR)
  library(limma)
  library(ggplot2)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH          <- {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH        <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN     <- {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN     <- {{condition_column}}  # [adaptable: condition_column]
REFERENCE_LEVEL      <- {{reference_level}}  # [adaptable: reference_level]
TEST_LEVEL           <- {{test_level}}  # [adaptable: test_level]
{{#if covariates}}
COVARIATES           <- {{covariates}}  # [adaptable: covariates]
{{/if}}
{{#unless covariates}}
COVARIATES           <- character(0)  # [adaptable: covariates] none: the design is ~ condition
{{/unless}}
MIN_COUNT            <- {{min_count}}  # [adaptable: min_count]
MIN_TOTAL_COUNT      <- {{min_total_count}}  # [adaptable: min_total_count]
NORMALIZATION_METHOD <- {{normalization_method}}  # [adaptable: normalization_method]
ROBUST_EBAYES        <- {{robust_ebayes}}
ALPHA                <- {{alpha}}
LFC_THRESHOLD        <- {{lfc_threshold}}  # [adaptable: lfc_threshold]
N_TOP_GENES_MDS      <- {{n_top_genes_mds}}  # [adaptable: n_top_genes_mds]
OUTPUT_PREFIX        <- {{output_prefix}}  # [adaptable: output_prefix]
POPULATION_SCALE_MIN_GROUP <- 50  # Li et al. 2022: the count models over-call from about 50 samples per group

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
message("Reading counts from ", COUNTS_PATH)
counts_df <- read.csv(COUNTS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
gene_ids <- as.character(counts_df[[1]])
counts <- as.matrix(counts_df[, -1, drop = FALSE])
storage.mode(counts) <- "numeric"
rownames(counts) <- gene_ids
if (any(counts < 0, na.rm = TRUE) || any(abs(counts - round(counts)) > 1e-6, na.rm = TRUE)) {
  stop("The count matrix must hold non-negative integers. voom takes raw counts, not TPM or FPKM.")
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

# ── Model design ──────────────────────────────────────────────────────────────
# The design is ~ covariate_1 + ... + condition. Each covariate is a fixed
# effect. A character covariate becomes a factor, a numeric covariate stays
# numeric. The condition comes last, thus its coefficient is the contrast.
COVARIATES <- as.character(COVARIATES)
if (anyDuplicated(COVARIATES) > 0) stop("The covariates list names a column two times: ", paste(COVARIATES[duplicated(COVARIATES)], collapse = ", "))
for (column in COVARIATES) {
  if (column %in% c("condition", CONDITION_COLUMN)) stop("The covariates list names the condition column ", column, ". Give the condition only through condition_column.")
  if (column == SAMPLE_ID_COLUMN) stop("The covariates list names the sample identifier column ", column, ". A sample identifier is not a covariate.")
  if (!column %in% colnames(metadata)) stop("The covariates list names ", column, " but the sample table has no such column")
  if (anyNA(metadata[[column]])) stop("The covariate ", column, " has a missing value. Every sample needs a value for each covariate.")
  if (is.character(metadata[[column]]) || is.logical(metadata[[column]])) metadata[[column]] <- factor(metadata[[column]])
  if (is.factor(metadata[[column]]) && nlevels(metadata[[column]]) < 2) stop("The covariate ", column, " holds one level only, thus it adds nothing to the design.")
}
DESIGN <- as.formula(paste("~", paste(c(COVARIATES, "condition"), collapse = " + ")))
group_sizes <- table(metadata$condition)
message("Samples: ", ncol(counts), "; genes: ", nrow(counts), "; design: ", deparse(DESIGN))
message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "), " (reference ", REFERENCE_LEVEL, ")")
if (length(COVARIATES) > 0) message("Covariates: ", paste(COVARIATES, collapse = ", "))

design <- model.matrix(DESIGN, data = metadata)
coefficient <- paste0("condition", TEST_LEVEL)
if (!coefficient %in% colnames(design)) {
  stop("The coefficient ", coefficient, " is not in the design columns: ", paste(colnames(design), collapse = ", "))
}
if (qr(design)$rank < ncol(design)) stop("The design matrix is not of full rank. A covariate is confounded with the condition or with another covariate. Remove it.")
residual_df <- nrow(design) - ncol(design)
if (residual_df < 1) stop("The design leaves ", residual_df, " residual degrees of freedom. The moderated t-test needs at least 1. Remove a covariate or add samples.")
message("Residual degrees of freedom: ", residual_df)

population_scale <- min(group_sizes) >= POPULATION_SCALE_MIN_GROUP
population_scale_caution <- NULL
if (population_scale) {
  population_scale_caution <- paste0(
    "The smallest group holds ", min(group_sizes), " samples. On a population cohort the parametric models, limma-voom among them, ",
    "can exceed the nominal false discovery rate (Li et al. 2022). Report a Wilcoxon rank-sum test or a permutation check as the control."
  )
  message("Caution: ", population_scale_caution)
}

# ── Filter and normalize ──────────────────────────────────────────────────────
dge <- DGEList(counts = counts, group = metadata$condition)
keep <- filterByExpr(dge, design = design, min.count = MIN_COUNT, min.total.count = MIN_TOTAL_COUNT)
message("filterByExpr with min.count ", MIN_COUNT, " and min.total.count ", MIN_TOTAL_COUNT, ": ", sum(keep), " of ", nrow(dge), " genes kept")
dge <- dge[keep, , keep.lib.sizes = FALSE]
dge <- calcNormFactors(dge, method = NORMALIZATION_METHOD)
message("Library size scaling (", NORMALIZATION_METHOD, "): ", paste(sprintf("%s=%.3f", colnames(dge), dge$samples$norm.factors), collapse = ", "))

# ── voom ──────────────────────────────────────────────────────────────────────
# voom fits the mean-variance trend of the log-CPM and gives each observation
# a precision weight, thus the linear model applies to the counts.
v <- voom(dge, design, plot = FALSE, save.plot = TRUE)

# ── Linear model and moderated statistics ─────────────────────────────────────
fit <- lmFit(v, design)
if (LFC_THRESHOLD > 0) {
  message("treat: moderated t-test relative to |log2 fold change| > ", LFC_THRESHOLD, ", robust = ", ROBUST_EBAYES)
  fit <- treat(fit, lfc = LFC_THRESHOLD, robust = ROBUST_EBAYES)
  top <- topTreat(fit, coef = coefficient, number = Inf, sort.by = "P", adjust.method = "BH")
} else {
  message("eBayes: moderated t-test, robust = ", ROBUST_EBAYES)
  fit <- eBayes(fit, robust = ROBUST_EBAYES)
  top <- topTable(fit, coef = coefficient, number = Inf, sort.by = "P", adjust.method = "BH")
}

# ── Results table ─────────────────────────────────────────────────────────────
results_table <- data.frame(
  gene = rownames(top),
  log_cpm_mean = top$AveExpr,
  log2_fold_change = top$logFC,
  pvalue = top$P.Value,
  adjusted_pvalue = top$adj.P.Val,
  stringsAsFactors = FALSE
)
write.csv(results_table, out("results.csv"), row.names = FALSE)

write.csv(data.frame(gene = rownames(v$E), v$E, check.names = FALSE), out("logcpm.csv"), row.names = FALSE)

n_tested <- nrow(results_table)
n_significant <- sum(!is.na(results_table$adjusted_pvalue) & results_table$adjusted_pvalue < ALPHA)
n_up <- sum(!is.na(results_table$adjusted_pvalue) & results_table$adjusted_pvalue < ALPHA & results_table$log2_fold_change > 0)
n_down <- n_significant - n_up
message("Tested ", n_tested, " genes; ", n_significant, " at adjusted p < ", ALPHA, " (", n_up, " up, ", n_down, " down)")

# ── Figures ───────────────────────────────────────────────────────────────────
draw_voom_trend <- function() {
  plot(v$voom.xy$x, v$voom.xy$y, pch = 16, cex = 0.25, col = "grey40",
       xlab = v$voom.xy$xlab, ylab = v$voom.xy$ylab, main = "voom: mean-variance trend")
  lines(v$voom.line, col = "red", lwd = 2)
}
save_base_figure(draw_voom_trend, "voom_trend")

mds <- plotMDS(v, top = min(N_TOP_GENES_MDS, nrow(v)), plot = FALSE)
mds_df <- data.frame(
  sample = colnames(v),
  dim1 = mds$x,
  dim2 = mds$y,
  condition = metadata$condition,
  stringsAsFactors = FALSE
)
var_explained <- round(100 * mds$var.explained[1:2])
mds_plot <- ggplot(mds_df, aes(dim1, dim2, color = condition, label = sample)) +
  geom_point(size = 3) +
  geom_text(size = 2.5, vjust = -0.8, show.legend = FALSE) +
  xlab(paste0("Leading logFC dim 1 (", var_explained[1], "%)")) +
  ylab(paste0("Leading logFC dim 2 (", var_explained[2], "%)")) +
  scale_color_viridis_d(end = 0.8) +
  ggtitle("MDS of the samples, voom log-CPM, top variable genes") +
  theme_classic()
save_figure(mds_plot, "mds")

plot_df <- results_table[!is.na(results_table$adjusted_pvalue), ]
plot_df$significant <- plot_df$adjusted_pvalue < ALPHA
ma_plot <- ggplot(plot_df, aes(x = log_cpm_mean, y = log2_fold_change, color = significant)) +
  geom_point(size = 0.6, alpha = 0.6) +
  scale_color_manual(values = c(`FALSE` = "grey60", `TRUE` = "#440154"), name = paste0("adj. p < ", ALPHA)) +
  geom_hline(yintercept = 0, linetype = "dashed") +
  xlab("Mean log2 CPM") + ylab("log2 fold change") +
  ggtitle(paste0("MA plot: ", TEST_LEVEL, " vs ", REFERENCE_LEVEL)) +
  theme_classic()
save_figure(ma_plot, "ma")

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
  template = "tpl-limma-voom-fixed@1.0.0",
  method = if (LFC_THRESHOLD > 0) "limma-voom fixed-effects linear model, treat" else "limma-voom fixed-effects linear model, robust moderated t-test",
  contrast = list(factor = "condition", test = TEST_LEVEL, reference = REFERENCE_LEVEL, coefficient = coefficient),
  design = deparse(DESIGN),
  covariates = as.list(COVARIATES),
  n_covariates = length(COVARIATES),
  n_samples = ncol(counts),
  group_sizes = as.list(group_sizes),
  residual_df = residual_df,
  population_scale = population_scale,
  population_scale_caution = population_scale_caution,
  robust_ebayes = ROBUST_EBAYES,
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(dge),
  n_genes_tested = n_tested,
  n_significant = n_significant,
  n_up = n_up,
  n_down = n_down,
  alpha = ALPHA,
  adjust_method = "BH",
  lfc_threshold = LFC_THRESHOLD,
  min_count = MIN_COUNT,
  min_total_count = MIN_TOTAL_COUNT,
  normalization_method = NORMALIZATION_METHOD,
  library_sizes = as.list(setNames(dge$samples$lib.size, colnames(dge))),
  norm_factors = as.list(setNames(round(dge$samples$norm.factors, 4), colnames(dge))),
  versions = list(
    R = R.version.string,
    limma = as.character(packageVersion("limma")),
    edgeR = as.character(packageVersion("edgeR"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA, null = "null")
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("results.csv"))
