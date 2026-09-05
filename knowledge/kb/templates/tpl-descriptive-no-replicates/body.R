#!/usr/bin/env Rscript
# tpl-descriptive-no-replicates — descriptive log2 fold changes, no inferential test.
#
# Rendered by the Inflexa knowledge service. Each line that carries a value the
# planner may adapt is marked `# [adaptable: <slot>]`. Every other constant is
# pinned by the template and carries its source in the decision record.
#
# Method: at least one group holds one sample, thus no within-group dispersion
# can be estimated and a p-value has no inferential basis (DESeq2 vignette,
# "Experiments without replicates"; Schurch et al. 2016). The script normalizes
# the counts (DESeq2 median-of-ratios size factors, or CPM), keeps the genes
# with enough counts in every sample, and reports per gene the log2 ratio of
# the group means with a pseudocount. No p-value, no adjusted p-value.

suppressPackageStartupMessages({
  library(DESeq2)
  library(ggplot2)
  library(jsonlite)
})

# ── Parameters ────────────────────────────────────────────────────────────────
COUNTS_PATH      <- {{counts_path}}  # [adaptable: counts_path]
METADATA_PATH    <- {{metadata_path}}  # [adaptable: metadata_path]
SAMPLE_ID_COLUMN <- {{sample_id_column}}  # [adaptable: sample_id_column]
CONDITION_COLUMN <- {{condition_column}}  # [adaptable: condition_column]
REFERENCE_LEVEL  <- {{reference_level}}  # [adaptable: reference_level]
TEST_LEVEL       <- {{test_level}}  # [adaptable: test_level]
NORMALIZATION    <- {{normalization}}  # [adaptable: normalization]
MIN_COUNT        <- {{min_count}}  # [adaptable: min_count]
PSEUDOCOUNT      <- {{pseudocount}}  # [adaptable: pseudocount]
N_TOP_LABELS     <- {{n_top_labels}}  # [adaptable: n_top_labels]
OUTPUT_PREFIX    <- {{output_prefix}}  # [adaptable: output_prefix]

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
  stop("The count matrix must hold non-negative integers. The script takes raw counts, not TPM or FPKM.")
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
reference_samples <- rownames(metadata)[metadata$condition == REFERENCE_LEVEL]
test_samples <- rownames(metadata)[metadata$condition == TEST_LEVEL]
group_sizes <- c(length(reference_samples), length(test_samples))
names(group_sizes) <- c(REFERENCE_LEVEL, TEST_LEVEL)
message("Samples: ", ncol(counts), "; genes: ", nrow(counts))
message("Group sizes: ", paste(sprintf("%s=%d", names(group_sizes), group_sizes), collapse = ", "))
if (min(group_sizes) >= 2) {
  stop("Every group holds at least two samples. This template is for a design without replication; use an inferential method instead.")
}
message("At least one group holds one sample: no dispersion can be estimated, thus the script does no inferential test.")

# ── Normalize ─────────────────────────────────────────────────────────────────
# The full matrix gives the size factors, thus the filter does not move them.
if (NORMALIZATION == "median_of_ratios") {
  dds <- DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = ~ 1)
  dds <- estimateSizeFactors(dds)
  size_factors <- sizeFactors(dds)
  normalized_all <- counts(dds, normalized = TRUE)
  message("DESeq2 median-of-ratios size factors: ", paste(sprintf("%s=%.3f", names(size_factors), size_factors), collapse = ", "))
} else if (NORMALIZATION == "cpm") {
  library_sizes <- colSums(counts)
  size_factors <- library_sizes / 1e6
  normalized_all <- sweep(counts, 2, size_factors, "/")
  message("Counts per million by library size: ", paste(sprintf("%s=%.0f", names(library_sizes), library_sizes), collapse = ", "))
} else {
  stop("Unknown normalization ", NORMALIZATION, "; use median_of_ratios or cpm")
}
write.csv(data.frame(gene = rownames(normalized_all), normalized_all, check.names = FALSE), out("normalized_counts.csv"), row.names = FALSE)

# ── Filter ────────────────────────────────────────────────────────────────────
keep <- rowSums(counts >= MIN_COUNT) == ncol(counts)
message("Low count filter: keep genes with >= ", MIN_COUNT, " raw counts in every sample: ", sum(keep), " of ", nrow(counts), " kept")
if (sum(keep) == 0) stop("No gene passes the low count filter; lower min_count")
normalized <- normalized_all[keep, , drop = FALSE]

# ── Descriptive fold change ───────────────────────────────────────────────────
reference_mean <- rowMeans(normalized[, reference_samples, drop = FALSE])
test_mean <- rowMeans(normalized[, test_samples, drop = FALSE])
log2_fold_change <- log2((test_mean + PSEUDOCOUNT) / (reference_mean + PSEUDOCOUNT))
base_mean <- rowMeans(normalized)

normalized_columns <- as.data.frame(normalized, check.names = FALSE)
colnames(normalized_columns) <- paste0("normalized_", colnames(normalized))
results_table <- data.frame(
  gene = rownames(normalized),
  base_mean = base_mean,
  log2_fold_change = log2_fold_change,
  normalized_columns,
  check.names = FALSE,
  stringsAsFactors = FALSE
)
results_table <- results_table[order(-abs(results_table$log2_fold_change)), ]
write.csv(results_table, out("results.csv"), row.names = FALSE)

n_up_2fold <- sum(results_table$log2_fold_change >= 1)
n_down_2fold <- sum(results_table$log2_fold_change <= -1)
message("Reported ", nrow(results_table), " genes; ", n_up_2fold, " with log2 fold change >= 1 and ", n_down_2fold, " with <= -1 (descriptive, no test)")

# ── Figures ───────────────────────────────────────────────────────────────────
top_labels <- head(results_table, N_TOP_LABELS)
ma_plot <- ggplot(results_table, aes(x = base_mean, y = log2_fold_change)) +
  geom_point(size = 0.6, alpha = 0.5, color = "grey40") +
  geom_point(data = top_labels, size = 1.2, color = "#440154") +
  geom_text(data = top_labels, aes(label = gene), size = 2.5, vjust = -0.6) +
  scale_x_log10() +
  geom_hline(yintercept = 0, linetype = "dashed") +
  geom_hline(yintercept = c(-1, 1), linetype = "dotted", color = "grey50") +
  xlab("Mean of normalized counts") + ylab(paste0("log2 fold change (pseudocount ", PSEUDOCOUNT, ")")) +
  ggtitle(paste0("MA-style plot: ", TEST_LEVEL, " vs ", REFERENCE_LEVEL, ", no replication, no test")) +
  theme_classic()
save_figure(ma_plot, "ma")

scatter_df <- data.frame(reference = log2(reference_mean + PSEUDOCOUNT), test = log2(test_mean + PSEUDOCOUNT))
scatter_plot <- ggplot(scatter_df, aes(x = reference, y = test)) +
  geom_point(size = 0.6, alpha = 0.5, color = "grey40") +
  geom_abline(slope = 1, intercept = 0, linetype = "dashed") +
  geom_abline(slope = 1, intercept = c(-1, 1), linetype = "dotted", color = "grey50") +
  xlab(paste0("log2 normalized counts, ", REFERENCE_LEVEL)) +
  ylab(paste0("log2 normalized counts, ", TEST_LEVEL)) +
  ggtitle("Sample scatter, genes that pass the filter") +
  theme_classic()
save_figure(scatter_plot, "sample_scatter")

# ── Summary ───────────────────────────────────────────────────────────────────
summary_record <- list(
  template = "tpl-descriptive-no-replicates@1.0.0",
  method = "Descriptive log2 fold change, no inferential test",
  contrast = list(factor = "condition", test = TEST_LEVEL, reference = REFERENCE_LEVEL),
  n_samples = ncol(counts),
  group_sizes = as.list(group_sizes),
  replication = list(
    has_replication = FALSE,
    n_per_group_min = as.integer(min(group_sizes)),
    statement = paste0(
      "The design has no replication: at least one group holds one sample. ",
      "No within-group dispersion can be estimated, thus no p-value and no adjusted p-value are reported. ",
      "The log2 fold changes are descriptive. A design with at least three, better six, biological replicates per group supports inference."
    )
  ),
  normalization = NORMALIZATION,
  n_genes_input = length(gene_ids),
  n_genes_after_filter = nrow(results_table),
  n_genes_tested = 0L,
  n_significant = 0L,
  n_up_2fold = n_up_2fold,
  n_down_2fold = n_down_2fold,
  min_count = MIN_COUNT,
  pseudocount = PSEUDOCOUNT,
  size_factors = as.list(setNames(round(size_factors, 4), colnames(counts))),
  versions = list(
    R = R.version.string,
    DESeq2 = as.character(packageVersion("DESeq2")),
    ggplot2 = as.character(packageVersion("ggplot2"))
  )
)
write_json(summary_record, out("summary.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
writeLines(capture.output(sessionInfo()), file.path("output", "session_info.txt"))
message("Done: ", out("results.csv"))
