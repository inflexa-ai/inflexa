# Shared helper functions for the treated-vs-control DESeq2 analysis.
#
# Used by both scripts/deseq2_primary.R (excludes shallow sample_01, per the
# T1S1 QC decision) and scripts/deseq2_sensitivity.R (all 12 samples, the
# "with sample_01" sensitivity arm T1S1 recommended reporting alongside the
# primary result).

suppressPackageStartupMessages({
  library(DESeq2)
  library(apeglm)
})

MIN_COUNT <- 10L
REFERENCE_LEVEL <- "control"
COEF_NAME <- "condition_treated_vs_control"

#' Load the raw gene x sample count matrix (genes as rows).
load_counts <- function(path) {
  df <- read.csv(path, row.names = 1, check.names = FALSE)
  as.matrix(df)
}

#' Load the sample sheet (sample -> condition), rownames = sample id.
load_metadata <- function(path) {
  read.csv(path, row.names = 1, check.names = FALSE)
}

#' Load the gene length reference table (gene -> length in bp).
load_gene_lengths <- function(path) {
  read.csv(path, row.names = 1, check.names = FALSE)
}

#' Keep genes with >= min_count counts in >= min_samples samples.
#' min_samples must equal the smallest arm size of the samples actually
#' analyzed (filter_policy = minimal_then_independent), computed by the
#' caller from the col_data actually passed to fit_deseq2().
filter_low_count_genes <- function(counts, min_samples, min_count = MIN_COUNT) {
  keep <- rowSums(counts >= min_count) >= min_samples
  message(sprintf(
    "Pre-filter: kept %d / %d genes (>= %d counts in >= %d samples)",
    sum(keep), length(keep), min_count, min_samples
  ))
  counts[keep, , drop = FALSE]
}

#' Build a DESeqDataSet, relevel condition so 'control' is the explicit
#' reference, and run the Wald test. No pre-normalization of counts is
#' applied here: DESeq2's own median-of-ratios size factors are estimated
#' internally by DESeq().
fit_deseq2 <- function(counts, col_data, reference_level = REFERENCE_LEVEL) {
  stopifnot(identical(colnames(counts), rownames(col_data)))
  storage.mode(counts) <- "integer"
  col_data$condition <- relevel(factor(col_data$condition), ref = reference_level)
  dds <- DESeqDataSetFromMatrix(
    countData = counts,
    colData = col_data,
    design = ~condition
  )
  dds <- DESeq(dds, test = "Wald", fitType = "parametric")
  dds
}

#' Extract Wald results for condition treated vs control plus apeglm
#' shrinkage, merged into one table carrying both unshrunken and shrunken
#' log2FoldChange/lfcSE. Positive log2FoldChange = higher in treated.
extract_results <- function(dds, alpha = 0.05) {
  stopifnot(COEF_NAME %in% resultsNames(dds))

  res <- results(
    dds,
    contrast = c("condition", "treated", "control"),
    alpha = alpha,
    independentFiltering = TRUE,
    pAdjustMethod = "BH",
    cooksCutoff = TRUE
  )
  res_shrunk <- lfcShrink(dds, coef = COEF_NAME, type = "apeglm", quiet = TRUE)

  res_df <- as.data.frame(res)
  shrunk_df <- as.data.frame(res_shrunk)[rownames(res_df), ]

  table <- data.frame(
    gene = rownames(res_df),
    base_mean = res_df$baseMean,
    log2_fold_change = res_df$log2FoldChange,
    lfc_se = res_df$lfcSE,
    stat = res_df$stat,
    pvalue = res_df$pvalue,
    adjusted_pvalue = res_df$padj,
    log2_fold_change_shrunken = shrunk_df$log2FoldChange,
    lfc_se_shrunken = shrunk_df$lfcSE,
    stringsAsFactors = FALSE
  )
  rownames(table) <- NULL
  list(res = res, res_shrunk = res_shrunk, table = table)
}

#' Split padj == NA genes into independent-filtering NAs (pvalue present,
#' gene excluded by the mean-count filter) vs Cook's-distance outlier NAs
#' (pvalue itself set to NA because a sample's Cook's distance for that gene
#' exceeded the F-distribution cutoff). These are DISTINCT NA mechanisms in
#' DESeq2's results() and must be reported separately (count_outlier_policy
#' = flag_and_report_na).
na_breakdown <- function(res) {
  is_na_padj <- is.na(res$padj)
  is_na_pvalue <- is.na(res$pvalue)
  list(
    n_genes_tested = length(res$padj),
    n_cooks_outlier_na = sum(is_na_pvalue),
    n_independent_filtering_na = sum(is_na_padj & !is_na_pvalue),
    n_padj_na_total = sum(is_na_padj)
  )
}

#' Smallest arm size in a col_data data.frame's condition column.
smallest_group_size <- function(col_data) {
  min(table(col_data$condition))
}
