#!/usr/bin/env Rscript
# Smoke test for the R `DESeq2` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# DESeq2 itself (and the dependencies it implies, e.g. SummarizedExperiment /
# S4Vectors). All data is simulated with a fixed seed; differential-expression
# checks are structural / tolerance-based, never exact floating-point
# equality. Exercises the core API surface and exits 0 only if every check
# passes, so it can be used as a pass/fail library validator:
#
#   Rscript DESeq2.R

if (!requireNamespace("DESeq2", quietly = TRUE)) {
  cat("FAIL: package 'DESeq2' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(DESeq2))
cat(sprintf("DESeq2 version: %s\n", as.character(packageVersion("DESeq2"))))

failures <- 0L
run_test <- function(name, fn) {
  result <- tryCatch({
    fn()
    "ok"
  }, error = function(e) conditionMessage(e))
  if (identical(result, "ok")) {
    cat(sprintf("  ok   %s\n", name))
  } else {
    failures <<- failures + 1L
    cat(sprintf("  FAIL %s: %s\n", name, result))
  }
}

# Simulate a 200-gene x 6-sample count matrix: two conditions, 3 vs 3.
# Baseline counts are Poisson around a moderate mean; the first 20 genes
# (the planted DE set) get a strong ~8x up-shift in condition B, so there is
# a known effect to recover. The remaining 180 genes are null (same mean in
# both conditions).
set.seed(1)
n_genes <- 200L
n_per <- 3L
n_de <- 20L
base_mu <- 100
counts <- matrix(
  rpois(n_genes * 2L * n_per, lambda = base_mu),
  nrow = n_genes,
  ncol = 2L * n_per
)
b_cols <- (n_per + 1L):(2L * n_per) # columns 4:6 == condition B
counts[1:n_de, b_cols] <- rpois(n_de * n_per, lambda = base_mu * 8)
rownames(counts) <- sprintf("gene%03d", seq_len(n_genes))
colnames(counts) <- sprintf("s%d", seq_len(2L * n_per))
cond <- factor(rep(c("A", "B"), each = n_per))
de_idx <- 1:n_de
null_idx <- (n_de + 1L):n_genes

# suppressMessages silences DESeq()'s progress chatter ("estimating size
# factors", ...); genuine errors still propagate to run_test's tryCatch.
run_deseq <- function() {
  dds <- DESeqDataSetFromMatrix(
    countData = counts,
    colData = DataFrame(cond = cond),
    design = ~cond
  )
  suppressMessages(DESeq(dds))
}

run_test("DESeqDataSetFromMatrix + DESeq: object class and dims", function() {
  dds <- run_deseq()
  stopifnot(inherits(dds, "DESeqDataSet"))
  stopifnot(nrow(dds) == n_genes, ncol(dds) == 2L * n_per)
  stopifnot(identical(as.character(colnames(dds)), colnames(counts)))
})

run_test("results: table shape and required columns", function() {
  dds <- run_deseq()
  res <- results(dds)
  stopifnot(inherits(res, "DESeqResults"))
  stopifnot(nrow(res) == n_genes)
  stopifnot(all(c("log2FoldChange", "pvalue", "padj") %in% colnames(res)))
})

run_test("results: planted DE genes recovered with correct sign", function() {
  dds <- run_deseq()
  # Contrast B vs A: the up-shifted genes must show positive LFC; the null
  # genes must sit near zero. Aggregate medians, not per-gene equality.
  res <- results(dds, contrast = c("cond", "B", "A"))
  lfc <- res$log2FoldChange
  stopifnot(median(lfc[de_idx], na.rm = TRUE) > 2)
  stopifnot(abs(median(lfc[null_idx], na.rm = TRUE)) < 0.5)
})

run_test("results: DE genes have smaller adjusted p than null genes", function() {
  dds <- run_deseq()
  res <- results(dds, contrast = c("cond", "B", "A"))
  padj <- res$padj
  # The planted set is strongly significant; the null set is not. Compare
  # medians rather than asserting a per-gene threshold.
  stopifnot(median(padj[de_idx], na.rm = TRUE) < 0.01)
  stopifnot(median(padj[null_idx], na.rm = TRUE) > 0.1)
})

run_test("counts and sizeFactors accessors", function() {
  dds <- run_deseq()
  cm <- counts(dds)
  stopifnot(is.matrix(cm), identical(dim(cm), c(n_genes, 2L * n_per)))
  sf <- sizeFactors(dds)
  stopifnot(length(sf) == 2L * n_per, all(is.finite(sf)), all(sf > 0))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all DESeq2 smoke tests passed\n")
