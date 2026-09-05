#!/usr/bin/env Rscript
# tpl-deseq2-interaction — DESeq2 2x2 factorial design with an interaction term.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: DESeq2 negative binomial GLM on ~ factor_a + factor_b + factor_a:factor_b,
# Wald test on the interaction coefficient and on the simple effect of factor_b
# inside each level of factor_a, median-of-ratios size factors, independent
# filtering at alpha, and ashr shrinkage of each reported log2 fold change
# (Love et al. 2014; Stephens 2017). ashr and not apeglm, because the simple
# effect inside the test level of factor_a is a contrast of two coefficients,
# and apeglm shrinks one coefficient only.

suppressPackageStartupMessages({
  library(DESeq2)
  library(ggplot2)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH        <- {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH      <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN   <- {{sample_id_column}}  # [adaptable: sample_id_column]
FACTOR_A_COLUMN    <- {{factor_a_column}}  # [adaptable: factor_a_column]
FACTOR_A_REFERENCE <- {{factor_a_reference}}  # [adaptable: factor_a_reference]
FACTOR_B_COLUMN    <- {{factor_b_column}}  # [adaptable: factor_b_column]
FACTOR_B_REFERENCE <- {{factor_b_reference}}  # [adaptable: factor_b_reference]
DESIGN             <- ~ factor_a + factor_b + factor_a:factor_b
MIN_COUNT          <- {{min_count}}  # [adaptable: min_count]
{{#if min_samples}}
MIN_SAMPLES        <- {{min_samples}}  # [adaptable: min_samples]
{{/if}}
{{#unless min_samples}}
MIN_SAMPLES        <- NA_integer_  # [adaptable: min_samples] NA: the smallest cell size, computed below
{{/unless}}
ALPHA              <- {{alpha}}
LFC_SHRINK         <- {{lfc_shrink}}  # [adaptable: lfc_shrink]
LFC_THRESHOLD      <- {{lfc_threshold}}  # [adaptable: lfc_threshold]
N_TOP_GENES_PCA    <- {{n_top_genes_pca}}  # [adaptable: n_top_genes_pca]
OUTPUT_PREFIX      <- {{output_prefix}}  # [adaptable: output_prefix]

dir.create("output", showWarnings = FALSE, recursive = TRUE)
dir.create("figures", showWarnings = FALSE, recursive = TRUE)
out <- function(name) file.path("output", paste0(OUTPUT_PREFIX, "_", name))
fig <- function(name) file.path("figures", paste0(OUTPUT_PREFIX, "_", name))
file_token <- function(level) gsub("[^A-Za-z0-9_.-]", "_", level)

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
if (!FACTOR_A_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", FACTOR_A_COLUMN)
if (!FACTOR_B_COLUMN %in% colnames(metadata)) stop("The sample table has no column ", FACTOR_B_COLUMN)
if (FACTOR_A_COLUMN == FACTOR_B_COLUMN) stop("factor_a_column and factor_b_column name the same column ", FACTOR_A_COLUMN)
rownames(metadata) <- as.character(metadata[[SAMPLE_ID_COLUMN]])
missing <- setdiff(colnames(counts), rownames(metadata))
if (length(missing) > 0) stop("Samples in the counts but not in the sample table: ", paste(missing, collapse = ", "))
metadata <- metadata[colnames(counts), , drop = FALSE]

two_level_factor <- function(column, reference, label) {
  values <- factor(metadata[[column]])
  if (nlevels(values) != 2) {
    stop("The column ", column, " (", label, ") must hold exactly two levels for a 2x2 design, but holds ",
         nlevels(values), ": ", paste(levels(values), collapse = ", "))
  }
  if (!reference %in% levels(values)) {
    stop("The column ", column, " holds ", paste(levels(values), collapse = ", "), " but not the reference level ", reference)
  }
  relevel(values, ref = reference)
}
metadata$factor_a <- two_level_factor(FACTOR_A_COLUMN, FACTOR_A_REFERENCE, "factor_a")
metadata$factor_b <- two_level_factor(FACTOR_B_COLUMN, FACTOR_B_REFERENCE, "factor_b")
FACTOR_A_TEST <- levels(metadata$factor_a)[2]
FACTOR_B_TEST <- levels(metadata$factor_b)[2]
cell_sizes <- table(metadata$factor_a, metadata$factor_b)
cell_text <- paste(sprintf("%s/%s=%d", rep(rownames(cell_sizes), times = 2), rep(colnames(cell_sizes), each = 2), as.vector(cell_sizes)), collapse = ", ")
if (any(cell_sizes == 0)) stop("Each of the four cells of the 2x2 design needs at least one sample. Cell sizes: ", cell_text)
if (any(cell_sizes < 2)) message("Warning: a cell holds one sample only, thus the interaction test has low power. Cell sizes: ", cell_text)
message("Samples: ", ncol(counts), "; genes: ", nrow(counts), "; design: ", deparse(DESIGN))
message("factor_a = ", FACTOR_A_COLUMN, ": ", FACTOR_A_TEST, " vs ", FACTOR_A_REFERENCE, " (reference)")
message("factor_b = ", FACTOR_B_COLUMN, ": ", FACTOR_B_TEST, " vs ", FACTOR_B_REFERENCE, " (reference)")
message("Cell sizes: ", cell_text)

# ── Filter ────────────────────────────────────────────────────────────────────
if (is.na(MIN_SAMPLES)) MIN_SAMPLES <- as.integer(min(cell_sizes))
keep <- rowSums(counts >= MIN_COUNT) >= MIN_SAMPLES
message("Low count filter: keep genes with >= ", MIN_COUNT, " counts in >= ", MIN_SAMPLES, " samples: ", sum(keep), " of ", nrow(counts), " kept")
counts <- counts[keep, , drop = FALSE]

# ── Model ─────────────────────────────────────────────────────────────────────
dds <- DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = DESIGN)
dds <- DESeq(dds, quiet = TRUE)
message("Size factors: ", paste(sprintf("%s=%.2f", colnames(dds), sizeFactors(dds)), collapse = ", "))

coefficient_names <- resultsNames(dds)
find_coefficient <- function(expected, pattern, label) {
  if (expected %in% coefficient_names) return(expected)
  found <- grep(pattern, coefficient_names, value = TRUE)
  if (length(found) == 1) return(found)
  stop("The ", label, " coefficient ", expected, " is not in resultsNames: ", paste(coefficient_names, collapse = ", "))
}
b_coefficient <- find_coefficient(
  paste0("factor_b_", make.names(FACTOR_B_TEST), "_vs_", make.names(FACTOR_B_REFERENCE)),
  "^factor_b_.*_vs_", "factor_b main effect")
interaction_coefficient <- find_coefficient(
  paste0("factor_a", make.names(FACTOR_A_TEST), ".factor_b", make.names(FACTOR_B_TEST)),
  "^factor_a.*\\.factor_b", "interaction")
message("Interaction coefficient: ", interaction_coefficient, "; factor_b main effect: ", b_coefficient)

# ── Tests ─────────────────────────────────────────────────────────────────────
# One Wald test per table. `coef` names one coefficient, `contrast` gives the
# list form of results(): the sum of the named coefficients. The reported
# pvalue and adjusted_pvalue come from the Wald test, the reported
# log2_fold_change and lfc_se from the shrinkage estimator.
wald_table <- function(label, coef = NULL, contrast = NULL) {
  if (!is.null(coef)) {
    res <- results(dds, name = coef, alpha = ALPHA, lfcThreshold = LFC_THRESHOLD)
  } else {
    res <- results(dds, contrast = contrast, alpha = ALPHA, lfcThreshold = LFC_THRESHOLD)
  }
  if (LFC_SHRINK == "ashr") {
    message("Shrinking the log2 fold change of ", label, " with ashr")
    if (!is.null(coef)) {
      shrunk <- lfcShrink(dds, coef = coef, res = res, type = "ashr", quiet = TRUE)
    } else {
      shrunk <- lfcShrink(dds, contrast = contrast, res = res, type = "ashr", quiet = TRUE)
    }
  } else {
    shrunk <- res
  }
  table <- data.frame(
    gene = rownames(res),
    base_mean = res$baseMean,
    log2_fold_change = shrunk$log2FoldChange,
    lfc_se = shrunk$lfcSE,
    stat = res$stat,
    pvalue = res$pvalue,
    adjusted_pvalue = res$padj,
    stringsAsFactors = FALSE
  )
  table <- table[order(table$pvalue, na.last = TRUE), ]
  significant <- !is.na(table$adjusted_pvalue) & table$adjusted_pvalue < ALPHA
  counts_record <- list(
    n_tested = sum(!is.na(table$adjusted_pvalue)),
    n_significant = sum(significant),
    n_up = sum(significant & table$log2_fold_change > 0),
    n_down = sum(significant & table$log2_fold_change <= 0)
  )
  message(label, ": tested ", counts_record$n_tested, " genes after independent filtering; ", counts_record$n_significant,
          " at padj < ", ALPHA, " (", counts_record$n_up, " up, ", counts_record$n_down, " down)")
  list(table = table, counts = counts_record)
}

interaction_label <- paste0(FACTOR_A_COLUMN, ":", FACTOR_B_COLUMN, " (", FACTOR_A_TEST, " x ", FACTOR_B_TEST, ")")
interaction <- wald_table(paste("interaction", interaction_label), coef = interaction_coefficient)
write.csv(interaction$table, out("interaction_results.csv"), row.names = FALSE)

simple_effect_label <- function(level_a) {
  paste0(FACTOR_B_COLUMN, " ", FACTOR_B_TEST, " vs ", FACTOR_B_REFERENCE, " within ", FACTOR_A_COLUMN, " = ", level_a)
}
simple_reference <- wald_table(simple_effect_label(FACTOR_A_REFERENCE), coef = b_coefficient)
write.csv(simple_reference$table, out(paste0("simple_effect_", file_token(FACTOR_A_REFERENCE), ".csv")), row.names = FALSE)
simple_test <- wald_table(simple_effect_label(FACTOR_A_TEST), contrast = list(c(b_coefficient, interaction_coefficient)))
write.csv(simple_test$table, out(paste0("simple_effect_", file_token(FACTOR_A_TEST), ".csv")), row.names = FALSE)

# ── Figures ───────────────────────────────────────────────────────────────────
vsd <- vst(dds, blind = TRUE)
pca <- plotPCA(vsd, intgroup = c("factor_a", "factor_b"), ntop = min(N_TOP_GENES_PCA, nrow(vsd)), returnData = TRUE)
percent_var <- round(100 * attr(pca, "percentVar"))
pca_plot <- ggplot(pca, aes(PC1, PC2, color = factor_a, shape = factor_b, label = name)) +
  geom_point(size = 3) +
  geom_text(vjust = -0.8, size = 2.5, show.legend = FALSE) +
  xlab(paste0("PC1: ", percent_var[1], "% variance")) +
  ylab(paste0("PC2: ", percent_var[2], "% variance")) +
  scale_color_viridis_d(end = 0.8, name = FACTOR_A_COLUMN) +
  scale_shape_discrete(name = FACTOR_B_COLUMN) +
  ggtitle("PCA of the samples, VST, top variable genes") +
  theme_classic()
save_figure(pca_plot, "pca")

plot_df <- interaction$table[!is.na(interaction$table$adjusted_pvalue), ]
plot_df$significant <- plot_df$adjusted_pvalue < ALPHA
ma_plot <- ggplot(plot_df, aes(x = base_mean, y = log2_fold_change, color = significant)) +
  geom_point(size = 0.6, alpha = 0.6) +
  scale_x_log10() +
  scale_color_manual(values = c(`FALSE` = "grey60", `TRUE` = "#440154"), name = paste0("padj < ", ALPHA)) +
  geom_hline(yintercept = 0, linetype = "dashed") +
  xlab("Mean of normalized counts") + ylab("Shrunken interaction log2 fold change") +
  ggtitle(paste0("MA plot, interaction: ", interaction_label)) +
  theme_classic()
save_figure(ma_plot, "ma")

top_labels <- head(plot_df[order(plot_df$adjusted_pvalue), ], 15)
volcano_plot <- ggplot(plot_df, aes(x = log2_fold_change, y = -log10(adjusted_pvalue), color = significant)) +
  geom_point(size = 0.6, alpha = 0.6) +
  geom_text(data = top_labels, aes(label = gene), size = 2.5, vjust = -0.6, show.legend = FALSE) +
  scale_color_manual(values = c(`FALSE` = "grey60", `TRUE` = "#21908C"), name = paste0("padj < ", ALPHA)) +
  geom_hline(yintercept = -log10(ALPHA), linetype = "dashed") +
  xlab("Shrunken interaction log2 fold change") + ylab("-log10 adjusted p-value") +
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
  template = "tpl-deseq2-interaction@1.0.0",
  method = "DESeq2 Wald test",
  design = deparse(DESIGN),
  factor_a = list(column = FACTOR_A_COLUMN, reference = FACTOR_A_REFERENCE, test = FACTOR_A_TEST),
  factor_b = list(column = FACTOR_B_COLUMN, reference = FACTOR_B_REFERENCE, test = FACTOR_B_TEST),
  n_samples = ncol(counts),
  cell_sizes = cell_sizes_record,
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(counts),
  interaction = c(list(coefficient = interaction_coefficient), interaction$counts),
  simple_effects = simple_effects_record,
  alpha = ALPHA,
  lfc_threshold = LFC_THRESHOLD,
  lfc_shrink = LFC_SHRINK,
  min_count = MIN_COUNT,
  min_samples = MIN_SAMPLES,
  size_factors = as.list(setNames(round(sizeFactors(dds), 4), colnames(dds))),
  versions = list(
    R = R.version.string,
    DESeq2 = as.character(packageVersion("DESeq2")),
    ashr = if (requireNamespace("ashr", quietly = TRUE)) as.character(packageVersion("ashr")) else NA
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("interaction_results.csv"))
