# Sensitivity DESeq2 analysis: treated vs control with ALL 12 samples,
# i.e. sample_01 (the shallow, PCA-outlier control) INCLUDED.
#
# T1S1 recommended reporting the DE contrast with and without sample_01
# rather than dropping it silently. This script is that "with" arm; the
# primary, decision-bearing result is scripts/deseq2_primary.R (sample_01
# excluded). Same design/test/shrinkage/filtering policy as primary, only
# the sample set and (consequently) the smallest-arm-size filter threshold
# differ (6 here vs 5 in primary).

suppressPackageStartupMessages({
  library(DESeq2)
  library(ggplot2)
})
source("scripts/deseq2_helpers.R")

INPUT_DIR <- "/eval-u25-live-with-two-group-n6-enrich-s1-1/data/inputs/local"
COUNTS_PATH <- file.path(INPUT_DIR, "counts.csv")
SAMPLE_SHEET_PATH <- "output/sample_sheet_deseq2.csv"
PRIMARY_RESULTS_PATH <- "output/de_results_treated_vs_control_primary.csv"
ALPHA <- 0.05

dir.create("output", showWarnings = FALSE)
dir.create("figures", showWarnings = FALSE)

load_sensitivity_inputs <- function(counts_path, sample_sheet_path) {
  counts <- load_counts(counts_path)
  sheet <- read.csv(sample_sheet_path, row.names = "sample", check.names = FALSE)
  all_samples <- rownames(sheet) # all 12, sample_01 included
  list(counts = counts[, all_samples, drop = FALSE], col_data = sheet[all_samples, "condition", drop = FALSE])
}

#' Compare the sensitivity (n=6/6, sample_01 in) result to the primary
#' (n=5/6, sample_01 out) result: significant-gene overlap and LFC agreement.
compare_to_primary <- function(sensitivity_table, primary_table_path) {
  primary <- read.csv(primary_table_path)
  merged <- merge(
    primary[, c("gene", "adjusted_pvalue", "log2_fold_change_shrunken")],
    sensitivity_table[, c("gene", "adjusted_pvalue", "log2_fold_change_shrunken")],
    by = "gene", suffixes = c("_primary", "_sensitivity")
  )
  sig_primary <- merged$gene[!is.na(merged$adjusted_pvalue_primary) & merged$adjusted_pvalue_primary < ALPHA]
  sig_sensitivity <- merged$gene[!is.na(merged$adjusted_pvalue_sensitivity) & merged$adjusted_pvalue_sensitivity < ALPHA]
  both <- length(intersect(sig_primary, sig_sensitivity))
  only_primary <- length(setdiff(sig_primary, sig_sensitivity))
  only_sensitivity <- length(setdiff(sig_sensitivity, sig_primary))

  lfc_complete <- merged[!is.na(merged$log2_fold_change_shrunken_primary) & !is.na(merged$log2_fold_change_shrunken_sensitivity), ]
  lfc_cor <- cor(lfc_complete$log2_fold_change_shrunken_primary, lfc_complete$log2_fold_change_shrunken_sensitivity, method = "pearson")

  p <- ggplot(lfc_complete, aes(x = log2_fold_change_shrunken_primary, y = log2_fold_change_shrunken_sensitivity)) +
    geom_point(alpha = 0.25, size = 0.7, color = "#31688EFF") +
    geom_abline(slope = 1, intercept = 0, linetype = "dashed", color = "grey40") +
    labs(
      title = "Sensitivity check: shrunken log2FC, sample_01 excluded vs included",
      subtitle = sprintf("Pearson r = %.3f across %d genes tested in both runs", lfc_cor, nrow(lfc_complete)),
      x = "log2FC, primary (sample_01 excluded, n=5 vs 6)",
      y = "log2FC, sensitivity (sample_01 included, n=6 vs 6)"
    ) +
    theme_minimal(base_size = 12)
  ggsave("figures/sensitivity_lfc_agreement.png", p, width = 6, height = 6, dpi = 300)
  ggsave("figures/sensitivity_lfc_agreement.pdf", p, width = 6, height = 6)

  comparison <- data.frame(
    n_significant_primary = length(sig_primary),
    n_significant_sensitivity = length(sig_sensitivity),
    n_significant_both = both,
    n_significant_only_primary = only_primary,
    n_significant_only_sensitivity = only_sensitivity,
    pearson_r_shrunken_lfc = lfc_cor,
    n_genes_compared = nrow(lfc_complete)
  )
  write.csv(comparison, "output/sensitivity_vs_primary_comparison.csv", row.names = FALSE)
  invisible(comparison)
}

main <- function() {
  inputs <- load_sensitivity_inputs(COUNTS_PATH, SAMPLE_SHEET_PATH)
  min_samples <- smallest_group_size(inputs$col_data)
  message(sprintf(
    "Sensitivity contrast samples: n=%d total (%s). Smallest arm = %d.",
    nrow(inputs$col_data), paste(table(inputs$col_data$condition), collapse = "/"), min_samples
  ))

  counts_filtered <- filter_low_count_genes(inputs$counts, min_samples = min_samples)
  dds <- fit_deseq2(counts_filtered, inputs$col_data)

  extracted <- extract_results(dds, alpha = ALPHA)
  res <- extracted$res
  table <- extracted$table

  breakdown <- na_breakdown(res)
  write.csv(as.data.frame(breakdown), "output/na_breakdown_sensitivity.csv", row.names = FALSE)
  message(sprintf(
    "NA breakdown (sensitivity): %d Cook's-outlier NA, %d independent-filtering NA, of %d genes tested.",
    breakdown$n_cooks_outlier_na, breakdown$n_independent_filtering_na, breakdown$n_genes_tested
  ))

  table_sorted <- table[order(table$adjusted_pvalue, na.last = TRUE), ]
  write.csv(table_sorted, "output/de_results_treated_vs_control_sensitivity.csv", row.names = FALSE)

  sig <- table_sorted[!is.na(table_sorted$adjusted_pvalue) & table_sorted$adjusted_pvalue < ALPHA, ]
  write.csv(sig, "output/significant_genes_sensitivity.csv", row.names = FALSE)
  message(sprintf("Significant genes (sensitivity, sample_01 included), padj < %.2f: %d", ALPHA, nrow(sig)))

  comparison <- compare_to_primary(table, PRIMARY_RESULTS_PATH)
  message(sprintf(
    "Primary vs sensitivity: %d sig in both, %d only primary, %d only sensitivity, LFC Pearson r = %.3f",
    comparison$n_significant_both, comparison$n_significant_only_primary,
    comparison$n_significant_only_sensitivity, comparison$pearson_r_shrunken_lfc
  ))
}

main()
