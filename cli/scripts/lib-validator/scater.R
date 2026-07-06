#!/usr/bin/env Rscript
# Smoke test for the R `scater` package.
#
# Fully self-contained: no input files, no network, no packages beyond scater
# and the Bioconductor deps it attaches. scater `Depends:` SingleCellExperiment
# and scuttle, so `SingleCellExperiment()`, `logNormCounts()` and
# `perCellQCMetrics()` all reach the search path from a bare `library(scater)`.
# All data is a small synthetic Poisson counts matrix built with a fixed seed;
# checks are structural (assay populated, QC columns present, embedding shape)
# and tolerance-based (finiteness) rather than numeric-equality on anything
# random. Exercises the normalize -> QC -> PCA path and exits 0 only if every
# check passes, so it can be used as a pass/fail library validator:
#
#   Rscript scater.R
#
# ============================ SIGNATURES TO RE-CHECK ========================
# FLAG (verify once installed):
#   - logNormCounts() and perCellQCMetrics() are re-exported from *scuttle*
#     (attached via scater's Depends). If a build no longer attaches scuttle,
#     qualify them as `scuttle::logNormCounts` / `scuttle::perCellQCMetrics`.
#   - perCellQCMetrics() is assumed to return a DataFrame with `sum` and
#     `detected` columns, one row per cell.
#   - runPCA() is scater's method with argument `ncomponents=`, writing an
#     embedding into reducedDim(sce, "PCA"); confirm the arg name and slot.
# runUMAP()/runTSNE() are intentionally NOT exercised (heavy, and runUMAP pulls
# a Python/uwot backend on some installs).
# ============================================================================

if (!requireNamespace("scater", quietly = TRUE)) {
  cat("FAIL: package 'scater' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(scater))
cat(sprintf("scater version: %s\n", as.character(packageVersion("scater"))))

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

# Synthetic counts: 100 genes x 20 cells, integer Poisson draws, fully named.
set.seed(1)
counts <- matrix(rpois(100 * 20, 5), nrow = 100, ncol = 20)
rownames(counts) <- paste0("gene", seq_len(100))
colnames(counts) <- paste0("cell", seq_len(20))
sce0 <- SingleCellExperiment(assays = list(counts = counts))

run_test("logNormCounts() populates the logcounts assay", function() {
  sce <- suppressWarnings(suppressMessages(logNormCounts(sce0)))
  stopifnot("logcounts" %in% assayNames(sce))
  lc <- as.matrix(logcounts(sce))
  stopifnot(nrow(lc) == 100L, ncol(lc) == 20L, all(is.finite(lc)))
})

run_test("perCellQCMetrics() returns sum/detected per cell", function() {
  qc <- suppressWarnings(suppressMessages(perCellQCMetrics(sce0)))
  stopifnot(nrow(qc) == 20L)                 # one row per cell
  stopifnot(all(c("sum", "detected") %in% colnames(qc)))
  stopifnot(all(qc$sum > 0), all(qc$detected > 0))
})

run_test("runPCA() writes a finite (cells x 5) embedding", function() {
  sce <- suppressWarnings(suppressMessages(logNormCounts(sce0)))
  sce <- suppressWarnings(suppressMessages(runPCA(sce, ncomponents = 5)))
  stopifnot("PCA" %in% reducedDimNames(sce))
  rd <- reducedDim(sce, "PCA")
  stopifnot(nrow(rd) == 20L, ncol(rd) == 5L, all(is.finite(rd)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all scater smoke tests passed\n")
