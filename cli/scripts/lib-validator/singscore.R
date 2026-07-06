#!/usr/bin/env Rscript
# Smoke test for the R `singscore` (Bioconductor) package.
#
# Fully self-contained: no input files, NO network. singscore computes a
# rank-based, single-sample gene-set score; this test SIMULATES an expression
# matrix (genes x samples) and a user-supplied up-regulated gene set, then
# scores every sample. Nothing reaches an online annotation source. Exits 0
# only if every check passes, so it can be used as a pass/fail library
# validator:
#
#   Rscript singscore.R
#
# ============================ API UNCERTAINTY ================================
# RE-CHECK once installed -- the two core signatures:
#
#   * rankGenes(expreMatrix) -> a per-sample rank matrix with the same dims as
#     the input (genes x samples). Accepts a matrix / data.frame / DGEList.
#
#   * simpleScore(rankData, upSet, downSet = NULL, ...) -> a data.frame with one
#     row per sample. `upSet` is assumed to accept a plain CHARACTER VECTOR of
#     gene ids (it also accepts a GSEABase::GeneSet). The score column is
#     assumed to be named "TotalScore".
#
#   * generateNull(upSet, rankData, B, ncores, seed, ...) -> a permutation null
#     matrix with one column per sample and B rows. Signature/shape is the most
#     likely thing to drift here -- flagged, and B is kept tiny (10).
# ============================================================================

if (!requireNamespace("singscore", quietly = TRUE)) {
  cat("FAIL: package 'singscore' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(singscore))
cat(sprintf("singscore version: %s\n", as.character(packageVersion("singscore"))))

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

# Synthetic 200-gene x 10-sample expression matrix with named rows/cols, and an
# up-regulated gene set drawn from the first 40 genes.
set.seed(7)
n_genes <- 200L
n_samples <- 10L
gene_ids <- paste0("g", seq_len(n_genes))
sample_ids <- paste0("s", seq_len(n_samples))
expr <- matrix(
  rnorm(n_genes * n_samples),
  nrow = n_genes,
  ncol = n_samples,
  dimnames = list(gene_ids, sample_ids)
)
up_set <- gene_ids[1:40]

run_test("rankGenes yields a rank matrix matching expr dimensions", function() {
  rank_data <- singscore::rankGenes(expr)
  stopifnot(nrow(rank_data) == nrow(expr), ncol(rank_data) == ncol(expr))
})

run_test("simpleScore returns a per-sample frame with TotalScore", function() {
  rank_data <- singscore::rankGenes(expr)
  scores <- singscore::simpleScore(rank_data, upSet = up_set)
  stopifnot(is.data.frame(scores))
  stopifnot("TotalScore" %in% names(scores))
  stopifnot(nrow(scores) == ncol(expr))
})

run_test("TotalScore values are finite numerics", function() {
  rank_data <- singscore::rankGenes(expr)
  scores <- singscore::simpleScore(rank_data, upSet = up_set)
  stopifnot(is.numeric(scores$TotalScore))
  stopifnot(all(is.finite(scores$TotalScore)))
})

run_test("generateNull produces a (B x nsamples) permutation null", function() {
  rank_data <- singscore::rankGenes(expr)
  null_mat <- singscore::generateNull(
    upSet = up_set, rankData = rank_data,
    B = 10L, ncores = 1L, seed = 1L)
  # one column per sample, B permutation rows; all finite.
  stopifnot(ncol(null_mat) == ncol(expr))
  stopifnot(nrow(null_mat) == 10L)
  stopifnot(all(is.finite(as.matrix(null_mat))))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all singscore smoke tests passed\n")
