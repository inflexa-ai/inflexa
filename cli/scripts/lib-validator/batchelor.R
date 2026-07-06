#!/usr/bin/env Rscript
# Smoke test for the R `batchelor` package.
#
# Fully self-contained: no input files, no network, no packages beyond batchelor
# and the Bioconductor deps it attaches. Two synthetic Gaussian batches are built
# with a fixed seed, sharing gene names but offset by a constant batch shift;
# checks are structural (return class, corrected slot present, batch labels) and
# tolerance-based (shape, finiteness) rather than numeric-equality on anything
# random. Exercises the batch-integration API and exits 0 only if every check
# passes, so it can be used as a pass/fail library validator:
#
#   Rscript batchelor.R
#
# ============================ SIGNATURES TO RE-CHECK ========================
# FLAG (verify once installed):
#   - INPUT FORM: fastMNN() / rescaleBatches() are called here with two BARE
#     MATRICES (genes x cells), one positional argument per batch, sharing
#     rownames. The alternative forms -- a list of SCEs, or a single object with
#     `batch=` -- are NOT exercised; confirm the multi-matrix positional form
#     still resolves each argument to a separate batch.
#   - fastMNN() returns a SingleCellExperiment carrying reducedDim(., "corrected")
#     (cells x d) and a colData `batch` column. `d`/`k` are pinned small (d=10,
#     k=10) so the internal PCA never requests more components than the low-rank
#     40-100 cell data supports -- re-confirm the arg names and the "corrected"
#     reducedDim name once a build is available.
#   - rescaleBatches() returns an SCE with a `corrected` ASSAY (genes x cells)
#     and a `batch` column.
# ============================================================================

if (!requireNamespace("batchelor", quietly = TRUE)) {
  cat("FAIL: package 'batchelor' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(batchelor))
cat(sprintf("batchelor version: %s\n", as.character(packageVersion("batchelor"))))

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

# Two batches: 100 genes x 30 cells each, i.i.d. normal, with batch 2 shifted by
# a constant so there is a batch effect to correct. Shared gene names are
# required for fastMNN/rescaleBatches to align the batches.
set.seed(1)
ngenes <- 100L
ncells <- 30L
total <- 2L * ncells
b1 <- matrix(rnorm(ngenes * ncells), nrow = ngenes, ncol = ncells)
b2 <- matrix(rnorm(ngenes * ncells) + 1, nrow = ngenes, ncol = ncells)  # batch shift
rownames(b1) <- rownames(b2) <- paste0("gene", seq_len(ngenes))
colnames(b1) <- paste0("b1_cell", seq_len(ncells))
colnames(b2) <- paste0("b2_cell", seq_len(ncells))

run_test("fastMNN() returns an SCE with a corrected embedding + batch labels", function() {
  mnn <- suppressWarnings(suppressMessages(fastMNN(b1, b2, d = 10, k = 10)))
  stopifnot(inherits(mnn, "SingleCellExperiment"))
  stopifnot("corrected" %in% reducedDimNames(mnn))
  corr <- reducedDim(mnn, "corrected")
  stopifnot(nrow(corr) == total, ncol(corr) == 10L, all(is.finite(corr)))
  stopifnot("batch" %in% colnames(colData(mnn)))
  stopifnot(length(mnn$batch) == total)
})

run_test("rescaleBatches() returns a corrected assay across both batches", function() {
  rb <- suppressWarnings(suppressMessages(rescaleBatches(b1, b2)))
  stopifnot(inherits(rb, "SingleCellExperiment"))
  stopifnot("corrected" %in% assayNames(rb))
  stopifnot(nrow(rb) == ngenes, ncol(rb) == total)
  stopifnot("batch" %in% colnames(colData(rb)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all batchelor smoke tests passed\n")
