# Count provenance check + DESeq2 sample sheet construction
#
# Two independent jobs that must both happen before any DESeq2 modeling:
#  1. Confirm counts.csv holds raw, non-length-scaled integer counts (or
#     report the ambiguity explicitly if it does not), by inspecting
#     integrality, value range, per-sample sums, and the count-vs-gene-length
#     relationship against gene_length_reference.csv.
#  2. Build the single sample sheet DESeq2 will read downstream, encoding the
#     T1S1 QC decision on the shallow sample (sample_01) so that decision is
#     applied consistently rather than re-litigated per script.

suppressPackageStartupMessages({
  library(ggplot2)
})

INPUT_DIR <- "/eval-u25-live-with-two-group-n6-enrich-s1-1/data/inputs/local"
COUNTS_PATH <- file.path(INPUT_DIR, "counts.csv")
METADATA_PATH <- file.path(INPUT_DIR, "metadata.csv")
GENE_LENGTH_PATH <- file.path(INPUT_DIR, "gene_lengths.csv")
SHALLOW_SAMPLE <- "sample_01"

dir.create("output", showWarnings = FALSE)
dir.create("figures", showWarnings = FALSE)

read_counts <- function(path) as.matrix(read.csv(path, row.names = 1, check.names = FALSE))
read_lengths <- function(path) read.csv(path, row.names = 1, check.names = FALSE)
read_metadata <- function(path) read.csv(path, row.names = 1, check.names = FALSE)

#' Inspect counts.csv for integrality, value range, and a length-scaling
#' signature against gene_length_reference.csv. Writes a markdown provenance
#' report and a numeric stats CSV; returns the stats list invisibly.
check_count_provenance <- function(counts, gene_lengths) {
  is_integer_valued <- all(abs(counts - round(counts)) < 1e-8)
  n_negative <- sum(counts < 0)
  value_range <- range(counts)
  col_sums <- colSums(counts)

  # TPM sums to exactly 1e6 per sample by construction; FPKM/RPKM do not sum
  # to a fixed constant but are almost never integer-valued after the
  # length + library-size division. Both signatures are absent here if
  # is_integer_valued is TRUE and col_sums are library-scale, not 1e6-scale.
  tpm_like <- all(abs(col_sums - 1e6) < 1)

  genes_common <- intersect(rownames(counts), rownames(gene_lengths))
  gene_set_matches <- length(genes_common) == nrow(counts) && length(genes_common) == nrow(gene_lengths)

  gene_lengths_ord <- gene_lengths[rownames(counts), , drop = FALSE]
  mean_count <- rowMeans(counts)
  length_bp <- gene_lengths_ord[[1]]
  ct <- suppressWarnings(cor.test(log1p(mean_count), log(length_bp), method = "spearman"))

  stats <- list(
    is_integer_valued = is_integer_valued,
    n_negative_values = n_negative,
    value_min = value_range[1],
    value_max = value_range[2],
    library_size_min = min(col_sums),
    library_size_max = max(col_sums),
    library_size_median = median(col_sums),
    tpm_like_sums_to_1e6 = tpm_like,
    gene_set_matches_length_reference = gene_set_matches,
    n_genes_counts = nrow(counts),
    n_genes_length_reference = nrow(gene_lengths),
    spearman_rho_meancount_vs_length = unname(ct$estimate),
    spearman_p_meancount_vs_length = ct$p.value
  )

  write.csv(as.data.frame(stats), "output/count_provenance_stats.csv", row.names = FALSE)

  plot_df <- data.frame(length_bp = length_bp, mean_count = mean_count)
  p <- ggplot(plot_df, aes(x = length_bp, y = mean_count + 1)) +
    geom_point(alpha = 0.25, size = 0.7, color = "#21908CFF") +
    scale_x_log10() +
    scale_y_log10() +
    labs(
      title = "Provenance check: mean raw count vs. gene length",
      subtitle = sprintf(
        "Spearman rho = %.3f (p = %.2e) between per-gene mean count and length",
        stats$spearman_rho_meancount_vs_length, stats$spearman_p_meancount_vs_length
      ),
      x = "Gene length (bp, log10 scale)",
      y = "Mean count + 1 across 12 samples (log10 scale)"
    ) +
    theme_minimal(base_size = 12)
  ggsave("figures/count_vs_gene_length_provenance.png", p, width = 7, height = 5, dpi = 300)
  ggsave("figures/count_vs_gene_length_provenance.pdf", p, width = 7, height = 5)

  rho <- stats$spearman_rho_meancount_vs_length
  rho_txt <- if (abs(rho) < 0.1) {
    sprintf(
      "The mean-count-vs-length Spearman correlation is essentially null (rho = %.3f, p = %.2f). This argues AGAINST the values already being length-scaled: if counts.csv held FPKM/TPM-like quantities (raw_count / length), dividing by length imposes a mechanical negative correlation with length unless the underlying raw counts were engineered to compensate almost exactly -- a coincidence, not a default. A null correlation is also compatible with raw counts drawn without a modeled length-capture bias (plausible for a simulated dataset). Net effect: this diagnostic does not by itself prove the counts are raw, but it rules out the clearest length-division signature.",
      rho, ct$p.value
    )
  } else if (rho > 0) {
    sprintf(
      "The mean-count-vs-length Spearman correlation is positive (rho = %.3f, p = %.2e), the classic raw-count signature (longer transcripts recruit more reads at equal expression). Length-normalized values (TPM/FPKM) would have this relationship removed by construction, not present, so a positive correlation is evidence for raw counts.",
      rho, ct$p.value
    )
  } else {
    sprintf(
      "The mean-count-vs-length Spearman correlation is negative (rho = %.3f, p = %.2e). A negative correlation is the signature a length-division (FPKM/TPM-like) operation would leave behind. Combined with the other checks below, treat this as an AMBIGUITY flag rather than a confirmed raw-count matrix.",
      rho, ct$p.value
    )
  }

  verdict <- if (is_integer_valued && !tpm_like) {
    paste(
      "Counts are integer-valued and per-sample sums are library-scale (not ~1,000,000), consistent with raw,",
      "non-length-scaled read counts -- FPKM/TPM values are essentially never integer, and TPM sums to exactly",
      "1e6 per sample by construction; neither signature is present here.", rho_txt
    )
  } else if (!is_integer_valued) {
    "AMBIGUITY: counts.csv contains non-integer values. This is inconsistent with raw read counts and consistent with a length- and/or library-scaled quantity (e.g. FPKM/TPM rounded imprecisely). DESeq2's negative-binomial count model assumes raw integer counts; modeling this matrix as-is would violate that assumption. This must be resolved before trusting any DESeq2 p-value."
  } else {
    "AMBIGUITY: counts.csv is integer-valued but per-sample sums are ~1e6, the TPM signature. Report this rather than assuming raw counts."
  }

  writeLines(c(
    "# Count provenance report",
    "",
    sprintf("**Verdict:** %s", verdict),
    "",
    "## Checks performed",
    sprintf("- Integer-valued (no fractional counts): %s", is_integer_valued),
    sprintf("- Negative values present: %d", n_negative),
    sprintf("- Value range: [%d, %d]", value_range[1], value_range[2]),
    sprintf("- Per-sample library sizes (colSums): min = %.0f, median = %.0f, max = %.0f", min(col_sums), median(col_sums), max(col_sums)),
    sprintf("- Per-sample sums ~= 1,000,000 (TPM signature): %s", tpm_like),
    sprintf("- Gene set in counts.csv exactly matches gene_lengths.csv (%d genes both files): %s", nrow(counts), gene_set_matches),
    sprintf(
      "- Spearman correlation, mean count vs. gene length: rho = %.3f, p = %.2e (see figures/count_vs_gene_length_provenance.png)",
      stats$spearman_rho_meancount_vs_length, stats$spearman_p_meancount_vs_length
    ),
    "",
    "## Conclusion",
    "gene_length_reference.csv is treated as NOT applied to counts.csv: counts.csv is modeled as raw integer",
    "read counts, and gene_length_reference.csv is not consumed further in the DESeq2 model (DESeq2's own",
    "median-of-ratios size factors handle library-size normalization; gene length is a within-sample, not a",
    "between-sample or between-condition, artifact and does not enter a two-group comparison of the same genes).",
    "The length-vs-log2FoldChange diagnostic in the primary DE script provides an additional post-hoc check",
    "for residual length-associated bias in the DE result itself."
  ), "output/count_provenance.md")

  invisible(stats)
}

#' Build the DESeq2 sample sheet, encoding the T1S1 shallow-sample decision.
#' T1S1 recommendation: EXCLUDE sample_01 from the primary DE contrast;
#' report a with/without sensitivity comparison. This sheet marks sample_01
#' `excluded_primary = TRUE` so every downstream script reads the SAME
#' decision rather than re-deciding it.
build_sample_sheet <- function(metadata, counts, shallow_sample) {
  library_size <- colSums(counts)[rownames(metadata)]
  sheet <- data.frame(
    sample = rownames(metadata),
    condition = metadata$condition,
    library_size = library_size,
    excluded_primary = rownames(metadata) == shallow_sample,
    exclusion_reason = ifelse(
      rownames(metadata) == shallow_sample,
      "T1S1 QC decision: 3.84x below median library size AND a 23.77-SD PC2 outlier within its own condition group on the top-500-gene PCA (see T1S1/output/qc_decision_memo.md). Excluded from the primary contrast; retained for a with/without sensitivity comparison (scripts/deseq2_sensitivity.R).",
      ""
    ),
    stringsAsFactors = FALSE
  )
  write.csv(sheet, "output/sample_sheet_deseq2.csv", row.names = FALSE)
  invisible(sheet)
}

main <- function() {
  counts <- read_counts(COUNTS_PATH)
  gene_lengths <- read_lengths(GENE_LENGTH_PATH)
  metadata <- read_metadata(METADATA_PATH)

  message("Running count provenance check...")
  stats <- check_count_provenance(counts, gene_lengths)
  message(sprintf(
    "Provenance: integer=%s, tpm_like=%s, spearman_rho=%.3f",
    stats$is_integer_valued, stats$tpm_like_sums_to_1e6, stats$spearman_rho_meancount_vs_length
  ))

  message("Building DESeq2 sample sheet with T1S1 shallow-sample decision applied...")
  sheet <- build_sample_sheet(metadata, counts, SHALLOW_SAMPLE)
  message(sprintf("Sample sheet: %d samples, %d excluded from primary contrast.", nrow(sheet), sum(sheet$excluded_primary)))
}

main()
