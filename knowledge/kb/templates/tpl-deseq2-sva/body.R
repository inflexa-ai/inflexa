#!/usr/bin/env Rscript
# tpl-deseq2-sva — DESeq2 two-group differential expression with sva
# surrogate variables in the design.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: a suspected batch with no recorded batch variable. svaseq estimates
# the surrogate variables from the median-of-ratios normalized counts with the
# condition as the known factor (Leek et al. 2012). num.sv (method "be")
# gives the number of surrogate variables, capped by a slot. Each surrogate
# variable enters the DESeq2 design as a covariate beside the condition. The
# counts stay unchanged. DESeq2 negative binomial GLM, Wald test on the
# condition coefficient, independent filtering at alpha, and shrinkage of the
# reported log2 fold change (Love et al. 2014; Zhu et al. 2019).

suppressPackageStartupMessages({
  library(DESeq2)
  library(sva)
  library(ggplot2)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH             <- {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH           <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN        <- {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN        <- {{condition_column}}  # [adaptable: condition_column]
REFERENCE_LEVEL         <- {{reference_level}}  # [adaptable: reference_level]
TEST_LEVEL              <- {{test_level}}  # [adaptable: test_level]
MAX_SURROGATE_VARIABLES <- {{max_surrogate_variables}}  # [adaptable: max_surrogate_variables]
MIN_COUNT               <- {{min_count}}  # [adaptable: min_count]
{{#if min_samples}}
MIN_SAMPLES             <- {{min_samples}}  # [adaptable: min_samples]
{{/if}}
{{#unless min_samples}}
MIN_SAMPLES             <- NA_integer_  # [adaptable: min_samples] NA: the smallest group size, computed below
{{/unless}}
SVA_MIN_MEAN_COUNT      <- {{sva_min_mean_count}}  # [adaptable: sva_min_mean_count]
ALPHA                   <- {{alpha}}
LFC_SHRINK              <- {{lfc_shrink}}  # [adaptable: lfc_shrink]
N_TOP_GENES_PCA         <- {{n_top_genes_pca}}  # [adaptable: n_top_genes_pca]
OUTPUT_PREFIX           <- {{output_prefix}}  # [adaptable: output_prefix]

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))
SURROGATE_VARIABLES_PATH <- file.path("output", "surrogate_variables.csv")

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
metadata_full <- read.csv(METADATA_PATH, check.names = FALSE, stringsAsFactors = FALSE)
if (!SAMPLE_ID_COLUMN %in% colnames(metadata_full)) stop("The sample table has no column ", SAMPLE_ID_COLUMN)
if (!CONDITION_COLUMN %in% colnames(metadata_full)) stop("The sample table has no column ", CONDITION_COLUMN)
# The situation has no batch variable, thus the script keeps only the sample id and the condition.
metadata <- data.frame(
  sample = as.character(metadata_full[[SAMPLE_ID_COLUMN]]),
  condition = as.character(metadata_full[[CONDITION_COLUMN]]),
  stringsAsFactors = FALSE
)
rownames(metadata) <- metadata$sample
missing <- setdiff(colnames(counts), rownames(metadata))
if (length(missing) > 0) stop("Samples in the counts but not in the sample table: ", paste(missing, collapse = ", "))
metadata <- metadata[colnames(counts), , drop = FALSE]
metadata$condition <- factor(metadata$condition)
if (!all(c(REFERENCE_LEVEL, TEST_LEVEL) %in% levels(metadata$condition))) {
  stop("The condition column holds ", paste(levels(metadata$condition), collapse = ", "), " but not both ", REFERENCE_LEVEL, " and ", TEST_LEVEL)
}
metadata$condition <- relevel(metadata$condition, ref = REFERENCE_LEVEL)
group_sizes <- table(metadata$condition)
if (min(group_sizes) < 4) {
  stop("The smallest group holds ", min(group_sizes), " samples. The surrogate variable estimate needs four or more replicates per group.")
}
message("Samples: ", ncol(counts), "; genes: ", nrow(counts))
message("Condition levels: ", paste(levels(metadata$condition), collapse = ", "), " (reference ", REFERENCE_LEVEL, ")")

# ── Filter ────────────────────────────────────────────────────────────────────
if (is.na(MIN_SAMPLES)) MIN_SAMPLES <- as.integer(min(group_sizes))
keep <- rowSums(counts >= MIN_COUNT) >= MIN_SAMPLES
message("Low count filter: keep genes with >= ", MIN_COUNT, " counts in >= ", MIN_SAMPLES, " samples: ", sum(keep), " of ", nrow(counts), " kept")
counts <- counts[keep, , drop = FALSE]

# ── Normalize ─────────────────────────────────────────────────────────────────
dds <- DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = ~ condition)
dds <- estimateSizeFactors(dds)
message("Size factors: ", paste(sprintf("%s=%.2f", colnames(dds), sizeFactors(dds)), collapse = ", "))
normalized <- counts(dds, normalized = TRUE)

# ── Surrogate variables ───────────────────────────────────────────────────────
sva_input <- normalized[rowMeans(normalized) > SVA_MIN_MEAN_COUNT, , drop = FALSE]
model_full <- model.matrix(~ condition, data = as.data.frame(colData(dds)))
model_null <- model.matrix(~ 1, data = as.data.frame(colData(dds)))
residual_df <- ncol(sva_input) - ncol(model_full)
n_sv_estimated <- num.sv(log(sva_input + 1), model_full, method = "be")
n_sv_ceiling <- min(MAX_SURROGATE_VARIABLES, max(residual_df - 2, 0))
n_sv <- min(n_sv_estimated, n_sv_ceiling)
message("Surrogate variables: num.sv (be) on ", nrow(sva_input), " genes estimates ", n_sv_estimated,
        "; the cap is ", n_sv_ceiling, " (slot ", MAX_SURROGATE_VARIABLES, ", residual df ", residual_df, "); ", n_sv, " enter the design")

sv_names <- character(0)
sv_matrix <- matrix(numeric(0), nrow = ncol(dds), ncol = 0)
if (n_sv > 0) {
  sv_fit <- svaseq(sva_input, model_full, model_null, n.sv = n_sv)
  sv_matrix <- as.matrix(sv_fit$sv)
  sv_names <- paste0("SV", seq_len(ncol(sv_matrix)))
  colnames(sv_matrix) <- sv_names
  for (name in sv_names) colData(dds)[[name]] <- sv_matrix[, name]
}
surrogate_table <- data.frame(sample = colnames(dds), stringsAsFactors = FALSE)
for (index in seq_along(sv_names)) surrogate_table[[paste0("sv", index)]] <- sv_matrix[, index]
write.csv(surrogate_table, SURROGATE_VARIABLES_PATH, row.names = FALSE)

# The association of each surrogate variable with the known factor: R squared of SV on condition.
sv_condition_r2 <- lapply(sv_names, function(name) {
  fit <- lm(sv_matrix[, name] ~ metadata$condition)
  round(summary(fit)$r.squared, 4)
})
names(sv_condition_r2) <- sv_names
if (length(sv_names) > 0) {
  message("Association of each surrogate variable with the condition (R squared): ",
          paste(sprintf("%s=%.3f", sv_names, unlist(sv_condition_r2)), collapse = ", "))
}

# ── Model ─────────────────────────────────────────────────────────────────────
DESIGN <- as.formula(paste("~", paste(c(sv_names, "condition"), collapse = " + ")))
message("Design: ", deparse(DESIGN))
design(dds) <- DESIGN
dds <- DESeq(dds, quiet = TRUE)

coefficient <- paste0("condition_", make.names(TEST_LEVEL), "_vs_", make.names(REFERENCE_LEVEL))
if (!coefficient %in% resultsNames(dds)) {
  stop("The coefficient ", coefficient, " is not in resultsNames: ", paste(resultsNames(dds), collapse = ", "))
}
res <- results(dds, name = coefficient, alpha = ALPHA)

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
  pvalue = res$pvalue,
  adjusted_pvalue = res$padj,
  stringsAsFactors = FALSE
)
results_table <- results_table[order(results_table$pvalue, na.last = TRUE), ]
write.csv(results_table, out("results.csv"), row.names = FALSE)
write.csv(data.frame(gene = rownames(normalized), normalized, check.names = FALSE), out("normalized_counts.csv"), row.names = FALSE)

n_significant <- sum(!is.na(res$padj) & res$padj < ALPHA)
n_up <- sum(!is.na(res$padj) & res$padj < ALPHA & res_shrunk$log2FoldChange > 0)
n_down <- n_significant - n_up
message("Tested ", sum(!is.na(res$padj)), " genes after independent filtering; ", n_significant, " at padj < ", ALPHA, " (", n_up, " up, ", n_down, " down)")

# ── Figures ───────────────────────────────────────────────────────────────────
vsd <- vst(dds, blind = TRUE)
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

if (length(sv_names) > 0) {
  sv_long <- do.call(rbind, lapply(sv_names, function(name) {
    data.frame(sample = colnames(dds), condition = metadata$condition, surrogate_variable = name, value = sv_matrix[, name], stringsAsFactors = FALSE)
  }))
} else {
  sv_long <- data.frame(sample = colnames(dds), condition = metadata$condition, surrogate_variable = "none", value = 0, stringsAsFactors = FALSE)
}
sv_plot <- ggplot(sv_long, aes(x = sample, y = value, fill = condition)) +
  geom_col() +
  facet_wrap(~ surrogate_variable, ncol = 1, scales = "free_y") +
  scale_fill_viridis_d(end = 0.8) +
  xlab("Sample") + ylab("Surrogate variable value") +
  ggtitle(paste0("Surrogate variables from svaseq (", length(sv_names), " in the design)")) +
  theme_classic() +
  theme(axis.text.x = element_text(angle = 90, vjust = 0.5, hjust = 1))
save_figure(sv_plot, "surrogate_variables", height = max(4, 2 * max(1, length(sv_names))))

plot_df <- results_table[!is.na(results_table$adjusted_pvalue), ]
plot_df$significant <- plot_df$adjusted_pvalue < ALPHA
ma_plot <- ggplot(plot_df, aes(x = base_mean, y = log2_fold_change, color = significant)) +
  geom_point(size = 0.6, alpha = 0.6) +
  scale_x_log10() +
  scale_color_manual(values = c(`FALSE` = "grey60", `TRUE` = "#440154"), name = paste0("padj < ", ALPHA)) +
  geom_hline(yintercept = 0, linetype = "dashed") +
  xlab("Mean of normalized counts") + ylab("Shrunken log2 fold change") +
  ggtitle(paste0("MA plot: ", TEST_LEVEL, " vs ", REFERENCE_LEVEL, ", ", length(sv_names), " surrogate variables")) +
  theme_classic()
save_figure(ma_plot, "ma")

top_labels <- head(plot_df[order(plot_df$adjusted_pvalue), ], 15)
volcano_plot <- ggplot(plot_df, aes(x = log2_fold_change, y = -log10(adjusted_pvalue), color = significant)) +
  geom_point(size = 0.6, alpha = 0.6) +
  geom_text(data = top_labels, aes(label = gene), size = 2.5, vjust = -0.6, show.legend = FALSE) +
  scale_color_manual(values = c(`FALSE` = "grey60", `TRUE` = "#21908C"), name = paste0("padj < ", ALPHA)) +
  geom_hline(yintercept = -log10(ALPHA), linetype = "dashed") +
  xlab("Shrunken log2 fold change") + ylab("-log10 adjusted p-value") +
  ggtitle(paste0("Volcano: ", TEST_LEVEL, " vs ", REFERENCE_LEVEL, ", ", length(sv_names), " surrogate variables")) +
  theme_classic()
save_figure(volcano_plot, "volcano")

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-deseq2-sva@1.0.0",
  method = "DESeq2 Wald test with sva surrogate variables as covariates",
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
  lfc_shrink = LFC_SHRINK,
  min_count = MIN_COUNT,
  min_samples = MIN_SAMPLES,
  surrogate_variables = list(
    tool = "sva::svaseq",
    n_sv_method = "be",
    n_estimated = n_sv_estimated,
    max_surrogate_variables = MAX_SURROGATE_VARIABLES,
    residual_df_before = residual_df,
    n_genes_for_estimate = nrow(sva_input),
    sva_min_mean_count = SVA_MIN_MEAN_COUNT,
    condition_r_squared = sv_condition_r2,
    path = SURROGATE_VARIABLES_PATH
  ),
  n_surrogate_variables = n_sv,
  size_factors = as.list(setNames(round(sizeFactors(dds), 4), colnames(dds))),
  versions = list(
    R = R.version.string,
    DESeq2 = as.character(packageVersion("DESeq2")),
    sva = as.character(packageVersion("sva")),
    apeglm = if (requireNamespace("apeglm", quietly = TRUE)) as.character(packageVersion("apeglm")) else NA,
    ashr = if (requireNamespace("ashr", quietly = TRUE)) as.character(packageVersion("ashr")) else NA
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("results.csv"))
