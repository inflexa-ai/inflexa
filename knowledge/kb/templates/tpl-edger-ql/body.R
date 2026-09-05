#!/usr/bin/env Rscript
# tpl-edger-ql — edgeR quasi-likelihood F-test, two-group differential expression.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: edgeR negative binomial GLM with quasi-likelihood dispersion,
# filterByExpr on the groups, TMM normalization, estimateDisp, glmQLFit with a
# robust prior, and the QL F-test on the condition coefficient. The FDR is the
# Benjamini-Hochberg adjustment of topTags (Robinson et al. 2010; Chen et al.
# 2025).

suppressPackageStartupMessages({
  library(edgeR)
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
ROBUST               <- {{robust}}
ALPHA                <- {{alpha}}
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

# ── Inputs ────────────────────────────────────────────────────────────────────
message("Reading counts from ", COUNTS_PATH)
counts_df <- read.csv(COUNTS_PATH, check.names = FALSE, stringsAsFactors = FALSE)
gene_ids <- as.character(counts_df[[1]])
counts <- as.matrix(counts_df[, -1, drop = FALSE])
storage.mode(counts) <- "numeric"
rownames(counts) <- gene_ids
if (any(is.na(counts))) stop("The count matrix holds a missing value. edgeR takes a complete matrix of raw counts.")
if (any(counts < 0) || any(abs(counts - round(counts)) > 1e-6)) {
  stop("The count matrix must hold non-negative integers. edgeR takes raw counts, not TPM or FPKM.")
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
if (REFERENCE_LEVEL == TEST_LEVEL) stop("The reference level and the test level are the same: ", TEST_LEVEL)
metadata$condition <- relevel(metadata$condition, ref = REFERENCE_LEVEL)
for (column in setdiff(all.vars(DESIGN), "condition")) {
  if (!column %in% colnames(metadata)) stop("The design names ", column, " but the sample table has no such column")
  if (is.character(metadata[[column]])) metadata[[column]] <- factor(metadata[[column]])
}
group_sizes <- table(metadata$condition)
if (min(group_sizes[c(REFERENCE_LEVEL, TEST_LEVEL)]) < 2) {
  stop("The quasi-likelihood F-test needs at least 2 replicates in each of ", REFERENCE_LEVEL, " and ", TEST_LEVEL)
}
message("Samples: ", ncol(counts), "; genes: ", nrow(counts), "; design: ", deparse(DESIGN))
message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "), " (reference ", REFERENCE_LEVEL, ")")

# ── Filter ────────────────────────────────────────────────────────────────────
y <- DGEList(counts = counts, group = metadata$condition)
keep <- filterByExpr(y, group = y$samples$group, min.count = MIN_COUNT, min.total.count = MIN_TOTAL_COUNT)
message("filterByExpr with the groups, min.count ", MIN_COUNT, ", min.total.count ", MIN_TOTAL_COUNT, ": ", sum(keep), " of ", nrow(y), " genes kept")
y <- y[keep, , keep.lib.sizes = FALSE]

# ── Normalize ─────────────────────────────────────────────────────────────────
y <- calcNormFactors(y, method = NORMALIZATION_METHOD)
message("Normalization (", NORMALIZATION_METHOD, ") factors: ", paste(sprintf("%s=%.3f", colnames(y), y$samples$norm.factors), collapse = ", "))
message("Library sizes: ", paste(sprintf("%s=%d", colnames(y), as.integer(y$samples$lib.size)), collapse = ", "))

# ── Model ─────────────────────────────────────────────────────────────────────
design_matrix <- model.matrix(DESIGN, data = metadata)
coefficient <- paste0("condition", TEST_LEVEL)
if (!coefficient %in% colnames(design_matrix)) {
  stop("The coefficient ", coefficient, " is not in the design matrix: ", paste(colnames(design_matrix), collapse = ", "))
}
if (qr(design_matrix)$rank < ncol(design_matrix)) {
  stop("The design matrix is not of full rank. A term of the design is confounded with another term.")
}
y <- estimateDisp(y, design_matrix)
message("Common dispersion: ", sprintf("%.4f", y$common.dispersion), " (BCV ", sprintf("%.3f", sqrt(y$common.dispersion)), ")")
fit <- glmQLFit(y, design_matrix, robust = ROBUST)
message("Quasi-likelihood F-test on ", coefficient, " (", TEST_LEVEL, " vs ", REFERENCE_LEVEL, ")")
qlf <- glmQLFTest(fit, coef = coefficient)
top <- topTags(qlf, n = Inf, adjust.method = "BH", sort.by = "PValue")$table

# ── Results table ─────────────────────────────────────────────────────────────
results_table <- data.frame(
  gene = rownames(top),
  log2_fold_change = top$logFC,
  log_cpm = top$logCPM,
  f_stat = top$F,
  pvalue = top$PValue,
  adjusted_pvalue = top$FDR,
  stringsAsFactors = FALSE
)
write.csv(results_table, out("results.csv"), row.names = FALSE)

normalized_cpm <- cpm(y, normalized.lib.sizes = TRUE, log = FALSE)
write.csv(data.frame(gene = rownames(normalized_cpm), normalized_cpm, check.names = FALSE), out("normalized_cpm.csv"), row.names = FALSE)

n_tested <- nrow(results_table)
n_significant <- sum(results_table$adjusted_pvalue < ALPHA)
n_up <- sum(results_table$adjusted_pvalue < ALPHA & results_table$log2_fold_change > 0)
n_down <- n_significant - n_up
message("Tested ", n_tested, " genes; ", n_significant, " at FDR < ", ALPHA, " (", n_up, " up, ", n_down, " down)")

# ── Figures ───────────────────────────────────────────────────────────────────
n_levels <- nlevels(metadata$condition)
condition_colors <- head(hcl.colors(n_levels + 1, "viridis"), n_levels)  # drop the yellow end, unreadable on white
draw_mds <- function() {
  par(mar = c(7, 4.5, 4, 2))
  plotMDS(
    y,
    top = min(N_TOP_GENES_MDS, nrow(y)),
    labels = colnames(y),
    col = condition_colors[as.integer(metadata$condition)],
    main = "MDS of the samples, log-CPM, top variable genes"
  )
  legend("bottom", inset = c(0, -0.38), horiz = TRUE, xpd = TRUE, bty = "n",
         legend = levels(metadata$condition), text.col = condition_colors, pch = 15, col = condition_colors)
}
png(fig("mds.png"), width = 6, height = 5, units = "in", res = 300)
draw_mds()
dev.off()
pdf(fig("mds.pdf"), width = 6, height = 5)
draw_mds()
dev.off()

plot_df <- results_table
plot_df$significant <- plot_df$adjusted_pvalue < ALPHA
ma_plot <- ggplot(plot_df, aes(x = log_cpm, y = log2_fold_change, color = significant)) +
  geom_point(size = 0.6, alpha = 0.6) +
  scale_color_manual(values = c(`FALSE` = "grey60", `TRUE` = "#440154"), name = paste0("FDR < ", ALPHA)) +
  geom_hline(yintercept = 0, linetype = "dashed") +
  xlab("Average log2 CPM") + ylab("log2 fold change") +
  ggtitle(paste0("MA plot: ", TEST_LEVEL, " vs ", REFERENCE_LEVEL)) +
  theme_classic()
save_figure(ma_plot, "ma")

top_labels <- head(plot_df[order(plot_df$adjusted_pvalue), ], 15)
volcano_plot <- ggplot(plot_df, aes(x = log2_fold_change, y = -log10(adjusted_pvalue), color = significant)) +
  geom_point(size = 0.6, alpha = 0.6) +
  geom_text(data = top_labels, aes(label = gene), size = 2.5, vjust = -0.6, show.legend = FALSE) +
  scale_color_manual(values = c(`FALSE` = "grey60", `TRUE` = "#21908C"), name = paste0("FDR < ", ALPHA)) +
  geom_hline(yintercept = -log10(ALPHA), linetype = "dashed") +
  xlab("log2 fold change") + ylab("-log10 FDR") +
  ggtitle(paste0("Volcano: ", TEST_LEVEL, " vs ", REFERENCE_LEVEL)) +
  theme_classic()
save_figure(volcano_plot, "volcano")

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-edger-ql@1.0.0",
  method = "edgeR quasi-likelihood F-test",
  contrast = list(factor = "condition", test = TEST_LEVEL, reference = REFERENCE_LEVEL, coefficient = coefficient),
  design = deparse(DESIGN),
  n_samples = ncol(counts),
  group_sizes = as.list(group_sizes),
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(y),
  n_genes_tested = n_tested,
  n_significant = n_significant,
  n_up = n_up,
  n_down = n_down,
  alpha = ALPHA,
  adjust_method = "BH",
  min_count = MIN_COUNT,
  min_total_count = MIN_TOTAL_COUNT,
  normalization_method = NORMALIZATION_METHOD,
  robust = ROBUST,
  common_dispersion = round(y$common.dispersion, 6),
  library_sizes = as.list(setNames(as.integer(y$samples$lib.size), colnames(y))),
  norm_factors = as.list(setNames(round(y$samples$norm.factors, 4), colnames(y))),
  versions = list(
    R = R.version.string,
    edgeR = as.character(packageVersion("edgeR")),
    limma = as.character(packageVersion("limma"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("results.csv"))
