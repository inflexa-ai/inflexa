#!/usr/bin/env Rscript
# Smoke test for the R `UCell` package.
#
# Fully self-contained: no input files, no network. Simulates a small scRNA-seq
# counts matrix (genes x cells) with a fixed seed, defines one marker-gene
# signature, and scores every cell with ScoreSignatures_UCell(). UCell scores
# are rank-based Mann-Whitney U statistics normalised to [0, 1], so checks are
# structural / bound-based (matrix shape, signature column present, values in
# range) -- never exact numeric equality. Exits 0 only if every check passes,
# so it can be used as a pass/fail library validator:
#
#   Rscript UCell.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# UNVERIFIABLE WITHOUT AN INSTALL -- confirm once UCell is available:
#   - ScoreSignatures_UCell() OUTPUT ORIENTATION. This test assumes the result
#     is a CELLS-x-SIGNATURES matrix: one ROW per cell (nrow == n_cells) and one
#     COLUMN per signature. If UCell instead returns signatures-x-cells, the
#     nrow/ncol assertions must be transposed.
#   - COLUMN NAMING. Assumes each signature column is named "<sig>_UCell" (the
#     default `name = "_UCell"` suffix), i.e. "sigA_UCell" here.
#   - INPUT TYPE. UCell prefers a sparse matrix; the counts are coerced to a
#     dgCMatrix (via the Matrix package, a UCell dependency) before scoring.
#     A plain dense matrix is also accepted, so the coercion is a convenience,
#     not a hard requirement -- re-confirm the accepted input classes.
# ============================================================================

if (!requireNamespace("UCell", quietly = TRUE)) {
  cat("FAIL: package 'UCell' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(UCell))
cat(sprintf("UCell version: %s\n", as.character(packageVersion("UCell"))))

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

# Synthetic counts: 200 genes x 30 cells, integer Poisson draws. Named rows/cols
# are required so the signature (a set of gene names) can be resolved against the
# matrix. Coerced to a sparse dgCMatrix -- UCell's preferred input type.
set.seed(1)
n_genes <- 200L
n_cells <- 30L
counts <- matrix(rpois(n_genes * n_cells, lambda = 3), nrow = n_genes, ncol = n_cells)
rownames(counts) <- paste0("Gene", seq_len(n_genes))
colnames(counts) <- paste0("Cell", seq_len(n_cells))
counts_sparse <- suppressWarnings(as(counts, "dgCMatrix"))

# One signature: the first 20 genes. Expected scored column: "sigA_UCell".
sigs <- list(sigA = paste0("Gene", 1:20))
sig_col <- "sigA_UCell"

run_test("ScoreSignatures_UCell returns a numeric matrix", function() {
  scores <- suppressWarnings(suppressMessages(
    ScoreSignatures_UCell(counts_sparse, features = sigs)
  ))
  stopifnot(is.matrix(scores) || is.data.frame(scores))
  stopifnot(is.numeric(as.matrix(scores)))
})

run_test("scores are cells x signatures with the named signature column", function() {
  scores <- suppressWarnings(suppressMessages(
    ScoreSignatures_UCell(counts_sparse, features = sigs)
  ))
  # One row per cell (see ORIENTATION note in the header block above).
  stopifnot(nrow(scores) == n_cells)
  stopifnot(sig_col %in% colnames(scores))
  # Every cell is scored -- rownames should match the input cells.
  stopifnot(all(rownames(scores) %in% colnames(counts)))
})

run_test("UCell scores are finite and bounded in [0, 1]", function() {
  scores <- suppressWarnings(suppressMessages(
    ScoreSignatures_UCell(counts_sparse, features = sigs)
  ))
  vals <- as.numeric(scores[, sig_col])
  stopifnot(length(vals) == n_cells)
  stopifnot(all(is.finite(vals)))
  stopifnot(all(vals >= 0 & vals <= 1))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all UCell smoke tests passed\n")
