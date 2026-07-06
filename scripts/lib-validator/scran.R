#!/usr/bin/env Rscript
# Smoke test for the R `scran` package.
#
# Fully self-contained: no input files, no network, no packages beyond scran
# and the Bioconductor deps it attaches / imports. All data is a small synthetic
# Poisson counts matrix built with a fixed seed; checks are structural (per-gene
# variance columns, HVG cardinality, cluster factor shape) and tolerance-based
# (finiteness) rather than numeric-equality on anything random. Exercises the
# mean-variance / HVG / clustering path and exits 0 only if every check passes,
# so it can be used as a pass/fail library validator:
#
#   Rscript scran.R
#
# ============================ SIGNATURES TO RE-CHECK ========================
# FLAG (verify once installed):
#   - logNormCounts() is a *scuttle* function (a scran Import, NOT attached by
#     library(scran)); it is qualified below as `scuttle::logNormCounts`.
#   - modelGeneVar() returns a DataFrame (S4 DFrame, NOT a base data.frame -- so
#     is.data.frame() is deliberately NOT asserted); assumed columns include
#     `mean` / `total` / `bio`, one row per gene.
#   - getTopHVGs(dec, n=) returns a character vector of gene ids (rownames).
#   - clusterCells(x, use.dimred=) returns a factor of length ncol(x). We hand a
#     small base-R prcomp() embedding as reducedDim "PCA" so clustering never
#     runs its own PCA on a 20-cell matrix (avoids the low-rank SVD edge case);
#     confirm the `use.dimred` arg name and the factor return once a build is
#     available.
# computeSumFactors()/pooledSizeFactors() are intentionally NOT exercised (they
# want pre-computed clusters and add little to the smoke surface).
# ============================================================================

if (!requireNamespace("scran", quietly = TRUE)) {
  cat("FAIL: package 'scran' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(scran))
cat(sprintf("scran version: %s\n", as.character(packageVersion("scran"))))

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

# Synthetic counts: 100 genes x 20 cells, integer Poisson draws, fully named,
# then log-normalized so modelGeneVar()/clustering have a logcounts assay.
set.seed(1)
counts <- matrix(rpois(100 * 20, 5), nrow = 100, ncol = 20)
rownames(counts) <- paste0("gene", seq_len(100))
colnames(counts) <- paste0("cell", seq_len(20))
sce <- SingleCellExperiment(assays = list(counts = counts))
sce <- suppressWarnings(suppressMessages(scuttle::logNormCounts(sce)))

run_test("modelGeneVar() returns per-gene mean/total/bio", function() {
  dec <- suppressWarnings(suppressMessages(modelGeneVar(sce)))
  stopifnot(nrow(dec) == 100L)               # one row per gene
  stopifnot(all(c("mean", "total", "bio") %in% colnames(dec)))
  stopifnot(all(is.finite(dec$total)))
})

run_test("getTopHVGs() returns at most n highly variable gene ids", function() {
  dec <- suppressWarnings(suppressMessages(modelGeneVar(sce)))
  hvg <- getTopHVGs(dec, n = 20)
  stopifnot(is.character(hvg), length(hvg) >= 1L, length(hvg) <= 20L)
  stopifnot(all(hvg %in% rownames(sce)))
})

run_test("clusterCells() over a PCA embedding is a factor of length ncells", function() {
  # Precompute a deterministic 10-D embedding with base prcomp so clusterCells
  # clusters that, rather than running its own SVD on a 20-cell matrix.
  pcs <- prcomp(t(as.matrix(logcounts(sce))), center = TRUE, scale. = FALSE)$x
  reducedDim(sce, "PCA") <- pcs[, seq_len(10), drop = FALSE]
  cl <- suppressWarnings(suppressMessages(clusterCells(sce, use.dimred = "PCA")))
  stopifnot(is.factor(cl), length(cl) == ncol(sce))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all scran smoke tests passed\n")
