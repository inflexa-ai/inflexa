#!/usr/bin/env Rscript
# Smoke test for the R `SingleCellExperiment` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# SingleCellExperiment and the Bioconductor deps it attaches (SummarizedExperiment
# / S4Vectors -- from which `DataFrame` reaches the search path). All data is a
# small synthetic Poisson counts matrix built with a fixed seed; checks are
# structural (class, dimensions, assay/reducedDim/altExp round-trips, colData)
# rather than numeric-equality on anything random. Exercises the core
# data-structure API and exits 0 only if every check passes, so it can be used
# as a pass/fail library validator:
#
#   Rscript SingleCellExperiment.R
#
# NOTE (needs re-check once installed): `DataFrame` is expected on the search
# path because SingleCellExperiment attaches S4Vectors transitively (via
# SummarizedExperiment -> GenomicRanges -> S4Vectors); if a future packaging
# change stops attaching it, qualify as `S4Vectors::DataFrame`. reducedDim<- /
# altExp<- store an embedding / an alternative experiment whose column count
# must match the parent (20 cells) -- re-confirm the accessor names once a build
# is available.

if (!requireNamespace("SingleCellExperiment", quietly = TRUE)) {
  cat("FAIL: package 'SingleCellExperiment' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(SingleCellExperiment))
cat(sprintf("SingleCellExperiment version: %s\n", as.character(packageVersion("SingleCellExperiment"))))

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
# colData tags cells with an alternating a/b condition (10 each).
set.seed(1)
counts <- matrix(rpois(100 * 20, 5), nrow = 100, ncol = 20)
rownames(counts) <- paste0("gene", seq_len(100))
colnames(counts) <- paste0("cell", seq_len(20))
coldata <- DataFrame(cond = rep(c("a", "b"), 10))

run_test("SingleCellExperiment() builds an SCE of the right shape", function() {
  sce <- SingleCellExperiment(assays = list(counts = counts), colData = coldata)
  stopifnot(inherits(sce, "SingleCellExperiment"))
  stopifnot(identical(dim(sce), c(100L, 20L)))
})

run_test("counts() round-trips the input assay", function() {
  sce <- SingleCellExperiment(assays = list(counts = counts), colData = coldata)
  back <- counts(sce)
  stopifnot(nrow(back) == 100L, ncol(back) == 20L)
  # Counts are integers stored verbatim, so equality is legitimate (not floats).
  stopifnot(all(back == counts))
  stopifnot(identical(rownames(back), rownames(counts)))
})

run_test("logcounts() assign and read back", function() {
  sce <- SingleCellExperiment(assays = list(counts = counts), colData = coldata)
  logcounts(sce) <- log1p(counts)
  stopifnot("logcounts" %in% assayNames(sce))
  lc <- logcounts(sce)
  stopifnot(nrow(lc) == 100L, ncol(lc) == 20L)
  stopifnot(isTRUE(all.equal(lc, log1p(counts))))
})

run_test("reducedDim() stores and names an embedding", function() {
  sce <- SingleCellExperiment(assays = list(counts = counts), colData = coldata)
  pca <- matrix(rnorm(20 * 2), nrow = 20, ncol = 2)  # one row per cell
  reducedDim(sce, "PCA") <- pca
  stopifnot("PCA" %in% reducedDimNames(sce))
  rd <- reducedDim(sce, "PCA")
  stopifnot(nrow(rd) == 20L, ncol(rd) == 2L)
})

run_test("altExp() stores an alternative experiment", function() {
  sce <- SingleCellExperiment(assays = list(counts = counts), colData = coldata)
  # An altExp must share the cell axis (20 columns) with its parent.
  spike <- SingleCellExperiment(
    assays = list(counts = matrix(rpois(5 * 20, 2), nrow = 5, ncol = 20)))
  altExp(sce, "spike") <- spike
  stopifnot("spike" %in% altExpNames(sce))
  ae <- altExp(sce, "spike")
  stopifnot(inherits(ae, "SingleCellExperiment"), ncol(ae) == 20L)
})

run_test("colData carries the per-cell annotation", function() {
  sce <- SingleCellExperiment(assays = list(counts = counts), colData = coldata)
  cond <- colData(sce)$cond
  stopifnot(length(cond) == 20L, all(cond %in% c("a", "b")))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all SingleCellExperiment smoke tests passed\n")
