#!/usr/bin/env Rscript
# tpl-limma-voom-qw — limma-voom with sample quality weights for a two-group design with an outlier sample.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: edgeR filterByExpr and TMM library size scaling factors, voom
# precision weights on log-CPM combined with an empirical weight per sample
# (voomWithQualityWeights), a fixed-effects linear model, robust empirical
# Bayes moderated t-statistics on the condition coefficient, and
# Benjamini-Hochberg adjusted p-values (Law et al. 2014; Liu et al. 2015;
# Ritchie et al. 2015; Phipson et al. 2016). The outlier sample stays in the
# analysis and gets a small weight instead of removal.

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
DESIGN               <- {{design}}  # [adaptable: design]
MIN_COUNT            <- {{min_count}}  # [adaptable: min_count]
MIN_TOTAL_COUNT      <- {{min_total_count}}  # [adaptable: min_total_count]
NORMALIZATION_METHOD <- {{normalization_method}}  # [adaptable: normalization_method]
WEIGHT_METHOD        <- {{weight_method}}  # [adaptable: weight_method]
ROBUST_EBAYES        <- {{robust_ebayes}}
ALPHA                <- {{alpha}}
LFC_THRESHOLD        <- {{lfc_threshold}}  # [adaptable: lfc_threshold]
N_TOP_GENES_MDS      <- {{n_top_genes_mds}}  # [adaptable: n_top_genes_mds]
OUTPUT_PREFIX        <- {{output_prefix}}  # [adaptable: output_prefix]

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
for (column in setdiff(all.vars(DESIGN), "condition")) {
  if (!column %in% colnames(metadata)) stop("The design names ", column, " but the sample table has no such column")
  if (is.character(metadata[[column]])) metadata[[column]] <- factor(metadata[[column]])
}
group_sizes <- table(metadata$condition)
if (min(group_sizes) < 3) {
  stop("The smallest group holds ", min(group_sizes), " samples. The sample weights come from the residuals of the fit, thus each group must hold three or more samples.")
}
message("Samples: ", ncol(counts), "; genes: ", nrow(counts), "; design: ", deparse(DESIGN))
message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "), " (reference ", REFERENCE_LEVEL, ")")

# ── Model design ──────────────────────────────────────────────────────────────
design <- model.matrix(DESIGN, data = metadata)
coefficient <- paste0("condition", TEST_LEVEL)
if (!coefficient %in% colnames(design)) {
  stop("The coefficient ", coefficient, " is not in the design columns: ", paste(colnames(design), collapse = ", "))
}
if (qr(design)$rank < ncol(design)) stop("The design matrix is not of full rank. Remove a term that is confounded with another term.")
residual_df <- nrow(design) - ncol(design)
if (residual_df < 2) stop("The design leaves ", residual_df, " residual degrees of freedom. The sample weights need at least 2.")

# ── Filter and normalize ──────────────────────────────────────────────────────
dge <- DGEList(counts = counts, group = metadata$condition)
keep <- filterByExpr(dge, design = design, min.count = MIN_COUNT, min.total.count = MIN_TOTAL_COUNT)
message("filterByExpr with min.count ", MIN_COUNT, " and min.total.count ", MIN_TOTAL_COUNT, ": ", sum(keep), " of ", nrow(dge), " genes kept")
dge <- dge[keep, , keep.lib.sizes = FALSE]
dge <- calcNormFactors(dge, method = NORMALIZATION_METHOD)
message("Library size scaling (", NORMALIZATION_METHOD, "): ", paste(sprintf("%s=%.3f", colnames(dge), dge$samples$norm.factors), collapse = ", "))

# ── voom with sample quality weights ──────────────────────────────────────────
# voomWithQualityWeights runs voom, estimates a weight per sample from the
# residual variance of the fit (arrayWeights), then runs voom once more with
# those weights. The final observation weight is the product of the precision
# weight and the sample weight. A sample with a weight well below 1 is the
# outlier: it stays in the model with less influence.
v <- voomWithQualityWeights(dge, design, method = WEIGHT_METHOD, plot = FALSE, save.plot = TRUE)
sample_weights <- v$targets$sample.weights
names(sample_weights) <- colnames(v)
message("Sample weights (", WEIGHT_METHOD, "): ", paste(sprintf("%s=%.3f", names(sample_weights), sample_weights), collapse = ", "))
lowest_weight_sample <- names(sample_weights)[which.min(sample_weights)]
message("Lowest weight: ", lowest_weight_sample, " at ", round(min(sample_weights), 3))
if (min(sample_weights) < 0.5) {
  message("Note: ", lowest_weight_sample, " has a weight below 0.5. It is a candidate outlier, and it stays in the analysis with that weight.")
}
sample_weights_table <- data.frame(sample = names(sample_weights), weight = round(sample_weights, 6), stringsAsFactors = FALSE)
write.csv(sample_weights_table, file.path("output", "sample_weights.csv"), row.names = FALSE)

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
weights_df <- data.frame(
  sample = factor(names(sample_weights), levels = names(sample_weights)),
  weight = as.numeric(sample_weights),
  condition = metadata$condition,
  stringsAsFactors = FALSE
)
weights_plot <- ggplot(weights_df, aes(x = sample, y = weight, fill = condition)) +
  geom_col() +
  geom_hline(yintercept = 1, linetype = "dashed", color = "red") +
  scale_fill_viridis_d(end = 0.8) +
  xlab("Sample") + ylab("Sample quality weight") +
  ggtitle("voomWithQualityWeights: weight per sample (1 is average)") +
  theme_classic() +
  theme(axis.text.x = element_text(angle = 45, hjust = 1))
save_figure(weights_plot, "sample_weights", width = 7, height = 4.5)

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
  weight = as.numeric(sample_weights),
  stringsAsFactors = FALSE
)
var_explained <- round(100 * mds$var.explained[1:2])
mds_plot <- ggplot(mds_df, aes(dim1, dim2, color = condition, size = weight, label = sample)) +
  geom_point() +
  geom_text(size = 2.5, vjust = -1.2, show.legend = FALSE) +
  xlab(paste0("Leading logFC dim 1 (", var_explained[1], "%)")) +
  ylab(paste0("Leading logFC dim 2 (", var_explained[2], "%)")) +
  scale_color_viridis_d(end = 0.8) +
  scale_size_continuous(range = c(1.5, 5), name = "sample weight") +
  ggtitle("MDS of the samples, voom log-CPM, sized by sample weight") +
  theme_classic()
save_figure(mds_plot, "mds")

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
  template = "tpl-limma-voom-qw@1.0.0",
  method = if (LFC_THRESHOLD > 0) "limma-voom with sample quality weights, treat" else "limma-voom with sample quality weights, robust moderated t-test",
  contrast = list(factor = "condition", test = TEST_LEVEL, reference = REFERENCE_LEVEL, coefficient = coefficient),
  design = deparse(DESIGN),
  n_samples = ncol(counts),
  group_sizes = as.list(group_sizes),
  residual_df = residual_df,
  weight_method = WEIGHT_METHOD,
  sample_weights = as.list(setNames(round(sample_weights, 4), names(sample_weights))),
  min_sample_weight = round(min(sample_weights), 4),
  lowest_weight_sample = lowest_weight_sample,
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
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("results.csv"))
