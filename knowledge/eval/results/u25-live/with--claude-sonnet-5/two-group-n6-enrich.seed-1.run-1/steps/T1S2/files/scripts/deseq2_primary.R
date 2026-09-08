# Primary DESeq2 analysis: treated (sample_07-12) vs control (sample_01-06),
# with the shallow sample_01 EXCLUDED per the T1S1 QC decision
# (output/sample_sheet_deseq2.csv, excluded_primary == TRUE).
#
# design = ~condition, condition releveled so 'control' is the explicit
# reference; Wald test; contrast = c("condition","treated","control")
# (positive log2FoldChange = higher in treated); apeglm shrinkage on the
# condition_treated_vs_control coefficient; independent filtering on;
# alpha = 0.05; BH adjustment; count outliers flagged (padj -> NA), not
# replaced or dropped silently.

suppressPackageStartupMessages({
  library(DESeq2)
  library(ggplot2)
  library(ggrepel)
  library(pheatmap)
})
source("scripts/deseq2_helpers.R")

INPUT_DIR <- "/eval-u25-live-with-two-group-n6-enrich-s1-1/data/inputs/local"
COUNTS_PATH <- file.path(INPUT_DIR, "counts.csv")
GENE_LENGTH_PATH <- file.path(INPUT_DIR, "gene_lengths.csv")
SAMPLE_SHEET_PATH <- "output/sample_sheet_deseq2.csv"
ALPHA <- 0.05
TOP_N_HEATMAP <- 50
TOP_N_VOLCANO_LABELS <- 15

dir.create("output", showWarnings = FALSE)
dir.create("figures", showWarnings = FALSE)

#' Load counts + the shared sample sheet, restrict to the primary
#' (sample_01-excluded) sample set, and align columns to sample-sheet rows.
load_primary_inputs <- function(counts_path, sample_sheet_path) {
  counts <- load_counts(counts_path)
  sheet <- read.csv(sample_sheet_path, row.names = "sample", check.names = FALSE)
  primary_samples <- rownames(sheet)[!sheet$excluded_primary]
  counts_primary <- counts[, primary_samples, drop = FALSE]
  col_data <- sheet[primary_samples, "condition", drop = FALSE]
  list(counts = counts_primary, col_data = col_data)
}

#' Dispersion plot -- fit diagnostic required alongside the MA plot.
save_dispersion_plot <- function(dds, base_path) {
  png(paste0(base_path, ".png"), width = 1800, height = 1500, res = 300)
  plotDispEsts(dds, main = "Dispersion estimates (primary: n=5 control, n=6 treated)")
  dev.off()
  pdf(paste0(base_path, ".pdf"), width = 6, height = 5)
  plotDispEsts(dds, main = "Dispersion estimates (primary: n=5 control, n=6 treated)")
  dev.off()
}

#' MA plot from DESeq2's own plotMA -- shrunken LFC is the recommended input
#' (vignette: MA plot after lfcShrink avoids the low-count fanning artifact).
save_ma_plot <- function(res_obj, base_path, title) {
  png(paste0(base_path, ".png"), width = 1800, height = 1500, res = 300)
  DESeq2::plotMA(res_obj, alpha = ALPHA, main = title)
  dev.off()
  pdf(paste0(base_path, ".pdf"), width = 6, height = 5)
  DESeq2::plotMA(res_obj, alpha = ALPHA, main = title)
  dev.off()
}

#' P-value histogram -- inspected before trusting the BH adjustment. A
#' well-behaved test gives a histogram flat outside a peak near 0; a peak
#' near 1 or a uniform-only shape without an enrichment near 0 signals a
#' problem with the null distribution assumptions.
save_pvalue_histogram <- function(res_df, base_path) {
  p <- ggplot(res_df[!is.na(res_df$pvalue), ], aes(x = pvalue)) +
    geom_histogram(breaks = seq(0, 1, by = 0.05), fill = "#31688EFF", color = "white") +
    labs(
      title = "P-value histogram, Wald test (condition treated vs control)",
      subtitle = "Primary contrast, sample_01 excluded",
      x = "Raw p-value", y = "Number of genes"
    ) +
    theme_minimal(base_size = 12)
  ggsave(paste0(base_path, ".png"), p, width = 6, height = 5, dpi = 300)
  ggsave(paste0(base_path, ".pdf"), p, width = 6, height = 5)
}

#' Volcano plot: shrunken log2FoldChange vs -log10(BH-adjusted p-value).
save_volcano_plot <- function(table, base_path, alpha = ALPHA) {
  df <- table
  df$neglog10_padj <- -log10(df$adjusted_pvalue)
  df$significant <- !is.na(df$adjusted_pvalue) & df$adjusted_pvalue < alpha
  top_labels <- df[df$significant, ]
  top_labels <- top_labels[order(top_labels$adjusted_pvalue), ][seq_len(min(TOP_N_VOLCANO_LABELS, sum(df$significant))), ]

  p <- ggplot(df, aes(x = log2_fold_change_shrunken, y = neglog10_padj, color = significant)) +
    geom_point(alpha = 0.5, size = 1.2) +
    scale_color_manual(values = c(`FALSE` = "grey70", `TRUE` = "#440154FF"), name = sprintf("padj < %.2f", alpha)) +
    geom_hline(yintercept = -log10(alpha), linetype = "dashed", color = "black") +
    ggrepel::geom_text_repel(data = top_labels, aes(label = gene), size = 2.8, color = "black", max.overlaps = 20) +
    labs(
      title = "Volcano: treated vs control (apeglm-shrunken log2FC)",
      subtitle = "Primary contrast, sample_01 excluded",
      x = "log2 fold change (apeglm-shrunken, treated vs control)",
      y = expression(-log[10] ~ "(BH-adjusted p-value)")
    ) +
    theme_minimal(base_size = 12)
  ggsave(paste0(base_path, ".png"), p, width = 7, height = 6, dpi = 300)
  ggsave(paste0(base_path, ".pdf"), p, width = 7, height = 6)
}

#' Top-N DE gene heatmap, z-scored VST values, column-annotated by condition.
save_top_gene_heatmap <- function(dds, table, base_path, top_n = TOP_N_HEATMAP) {
  ranked <- table[!is.na(table$adjusted_pvalue), ]
  ranked <- ranked[order(ranked$adjusted_pvalue), ]
  top_genes <- head(ranked$gene, top_n)
  if (length(top_genes) < 2) {
    message("Fewer than 2 non-NA genes available; skipping top-gene heatmap.")
    return(invisible(NULL))
  }
  vsd <- vst(dds, blind = FALSE)
  mat <- assay(vsd)[top_genes, , drop = FALSE]
  mat_z <- t(scale(t(mat)))
  ann_col <- as.data.frame(colData(dds)[, "condition", drop = FALSE])

  pheatmap(
    mat_z,
    annotation_col = ann_col,
    show_rownames = (length(top_genes) <= 50),
    fontsize_row = 6,
    main = sprintf("Top %d DE genes (z-scored VST), primary contrast", length(top_genes)),
    filename = paste0(base_path, ".png"),
    width = 7, height = 9
  )
  pheatmap(
    mat_z,
    annotation_col = ann_col,
    show_rownames = (length(top_genes) <= 50),
    fontsize_row = 6,
    main = sprintf("Top %d DE genes (z-scored VST), primary contrast", length(top_genes)),
    filename = paste0(base_path, ".pdf"),
    width = 7, height = 9
  )
}

#' Post-hoc length-bias diagnostic: correlate shrunken log2FoldChange against
#' gene length. A tools like cqn/EDASeq are absent from this environment; this
#' is the feasible substitute the caveats ask for. Does not block the result.
save_length_bias_diagnostic <- function(table, gene_lengths, base_path) {
  merged <- merge(table, gene_lengths, by.x = "gene", by.y = "row.names")
  names(merged)[names(merged) == names(gene_lengths)[1]] <- "length_bp"
  merged <- merged[!is.na(merged$log2_fold_change_shrunken), ]
  ct <- suppressWarnings(cor.test(merged$log2_fold_change_shrunken, log(merged$length_bp), method = "spearman"))

  p <- ggplot(merged, aes(x = length_bp, y = log2_fold_change_shrunken)) +
    geom_point(alpha = 0.25, size = 0.7, color = "#35B779FF") +
    geom_smooth(method = "loess", color = "#440154FF", se = FALSE) +
    scale_x_log10() +
    labs(
      title = "Length-bias diagnostic: shrunken log2FC vs. gene length",
      subtitle = sprintf("Spearman rho = %.3f (p = %.2e)", ct$estimate, ct$p.value),
      x = "Gene length (bp, log10 scale)", y = "log2 fold change (apeglm-shrunken)"
    ) +
    theme_minimal(base_size = 12)
  ggsave(paste0(base_path, ".png"), p, width = 7, height = 5, dpi = 300)
  ggsave(paste0(base_path, ".pdf"), p, width = 7, height = 5)

  list(rho = unname(ct$estimate), p_value = ct$p.value, n_genes = nrow(merged))
}

main <- function() {
  inputs <- load_primary_inputs(COUNTS_PATH, SAMPLE_SHEET_PATH)
  gene_lengths <- load_gene_lengths(GENE_LENGTH_PATH)

  min_samples <- smallest_group_size(inputs$col_data)
  message(sprintf(
    "Primary contrast samples: n=%d total (%s). Smallest arm = %d.",
    nrow(inputs$col_data), paste(table(inputs$col_data$condition), collapse = "/"), min_samples
  ))

  counts_filtered <- filter_low_count_genes(inputs$counts, min_samples = min_samples)

  dds <- fit_deseq2(counts_filtered, inputs$col_data)
  message("resultsNames(dds): ", paste(resultsNames(dds), collapse = ", "))

  save_dispersion_plot(dds, "figures/dispersion_plot_primary")

  extracted <- extract_results(dds, alpha = ALPHA)
  res <- extracted$res
  res_shrunk <- extracted$res_shrunk
  table <- extracted$table

  # Cross-check the manual NA breakdown against DESeq2's own summary() text.
  summary_txt <- capture.output(summary(res))
  writeLines(summary_txt, "output/deseq2_results_summary_primary.txt")
  breakdown <- na_breakdown(res)
  write.csv(as.data.frame(breakdown), "output/na_breakdown_primary.csv", row.names = FALSE)
  message(sprintf(
    "NA breakdown (primary): %d Cook's-outlier NA, %d independent-filtering NA, of %d genes tested.",
    breakdown$n_cooks_outlier_na, breakdown$n_independent_filtering_na, breakdown$n_genes_tested
  ))

  table_sorted <- table[order(table$adjusted_pvalue, na.last = TRUE), ]
  write.csv(table_sorted, "output/de_results_treated_vs_control_primary.csv", row.names = FALSE)

  sig <- table_sorted[!is.na(table_sorted$adjusted_pvalue) & table_sorted$adjusted_pvalue < ALPHA, ]
  write.csv(sig, "output/significant_genes_primary.csv", row.names = FALSE)
  message(sprintf(
    "Significant genes (padj < %.2f): %d (%d up in treated, %d down in treated)",
    ALPHA, nrow(sig), sum(sig$log2_fold_change_shrunken > 0), sum(sig$log2_fold_change_shrunken < 0)
  ))

  save_pvalue_histogram(table, "figures/pvalue_histogram_primary")
  save_ma_plot(res_shrunk, "figures/ma_plot_primary_shrunken", "MA plot (apeglm-shrunken LFC), primary contrast")
  save_ma_plot(res, "figures/ma_plot_primary_unshrunken", "MA plot (unshrunken LFC), primary contrast")
  save_volcano_plot(table, "figures/volcano_plot_primary")
  save_top_gene_heatmap(dds, table, "figures/top50_heatmap_primary")

  length_bias <- save_length_bias_diagnostic(table, gene_lengths, "figures/lfc_vs_length_diagnostic_primary")
  write.csv(as.data.frame(length_bias), "output/lfc_vs_length_diagnostic_primary.csv", row.names = FALSE)
  message(sprintf(
    "Length-bias diagnostic: Spearman rho = %.3f, p = %.2e, n = %d genes",
    length_bias$rho, length_bias$p_value, length_bias$n_genes
  ))

  # Persist normalized counts + VST as CSV (not an .rds of the S4 DESeqDataSet)
  # so downstream/cross-agent steps can consume them without R.
  norm_counts <- as.data.frame(counts(dds, normalized = TRUE))
  norm_counts <- cbind(gene = rownames(norm_counts), norm_counts)
  write.csv(norm_counts, "output/normalized_counts_primary.csv", row.names = FALSE)

  vsd <- vst(dds, blind = FALSE)
  vst_mat <- as.data.frame(assay(vsd))
  vst_mat <- cbind(gene = rownames(vst_mat), vst_mat)
  write.csv(vst_mat, "output/vst_counts_primary.csv", row.names = FALSE)

  size_factors <- data.frame(sample = colnames(dds), size_factor = sizeFactors(dds))
  write.csv(size_factors, "output/size_factors_primary.csv", row.names = FALSE)
}

main()
