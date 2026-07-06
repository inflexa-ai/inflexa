#!/usr/bin/env Rscript
# Smoke test for the R `SeuratObject` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# SeuratObject itself (and the Matrix dependency it implies). All data is a
# small synthetic Poisson counts matrix built with a fixed seed; checks are
# structural (class, dimensions, cell/feature accessors, layer round-trip,
# metadata) rather than numeric-equality on anything random. Exercises the
# core data-structure API and exits 0 only if every check passes, so it can be
# used as a pass/fail library validator:
#
#   Rscript SeuratObject.R
#
# NOTE (needs re-check once installed): SeuratObject v5 moved assay storage
# from `slot=`-addressed slots to named `layer=`s, so counts access is written
# to try `LayerData(obj, layer="counts")` first and fall back to
# `GetAssayData(obj, slot="counts")` for v4 -- re-confirm the accessor and the
# returned class (dgCMatrix vs matrix) once a build is available.

if (!requireNamespace("SeuratObject", quietly = TRUE)) {
  cat("FAIL: package 'SeuratObject' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(SeuratObject))
cat(sprintf("SeuratObject version: %s\n", as.character(packageVersion("SeuratObject"))))

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

# Synthetic counts: 100 genes x 20 cells, integer Poisson draws. With lambda 5
# over 20 cells every gene is non-empty with overwhelming probability, so the
# default CreateSeuratObject filters (min.cells = 0, min.features = 0) drop
# nothing and the object keeps all 100 x 20 entries.
set.seed(1)
m <- matrix(rpois(100 * 20, 5), nrow = 100, ncol = 20)
rownames(m) <- paste0("gene", 1:100)
colnames(m) <- paste0("cell", 1:20)

run_test("CreateSeuratObject builds a Seurat object", function() {
  obj <- CreateSeuratObject(counts = m)
  stopifnot(inherits(obj, "Seurat"))
  stopifnot(ncol(obj) == 20L, nrow(obj) == 100L)
})

run_test("Cells and Features accessors", function() {
  obj <- CreateSeuratObject(counts = m)
  cells <- Cells(obj)
  feats <- Features(obj)
  stopifnot(length(cells) == 20L, length(feats) == 100L)
  # Names are preserved from the input matrix dimnames.
  stopifnot(all(cells %in% colnames(m)), all(feats %in% rownames(m)))
})

run_test("counts layer round-trips the input matrix", function() {
  obj <- CreateSeuratObject(counts = m)
  # v5: LayerData(layer=); v4: GetAssayData(slot=). Prefer v5, fall back.
  counts_back <- tryCatch(
    LayerData(obj, layer = "counts"),
    error = function(e) GetAssayData(obj, slot = "counts")
  )
  cm <- as.matrix(counts_back)
  stopifnot(nrow(cm) == 100L, ncol(cm) == 20L)
  # Align by name in case the assay reorders, then compare exactly: counts are
  # integers stored verbatim, so equality is legitimate here (not floats).
  stopifnot(all(cm[rownames(m), colnames(m)] == m))
})

run_test("per-cell metadata is populated and positive", function() {
  obj <- CreateSeuratObject(counts = m)
  nc <- obj$nCount_RNA
  nf <- obj$nFeature_RNA
  stopifnot(!is.null(nc), length(nc) == 20L, all(is.finite(nc)), all(nc > 0))
  stopifnot(!is.null(nf), length(nf) == 20L, all(nf > 0))
  # nCount_RNA is the per-cell total UMI count == column sums of the counts.
  stopifnot(all(as.numeric(nc) == colSums(m)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all SeuratObject smoke tests passed\n")
