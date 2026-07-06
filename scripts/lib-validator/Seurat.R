#!/usr/bin/env Rscript
# Smoke test for the R `Seurat` package.
#
# Fully self-contained: no input files, no network. Builds a small synthetic
# Poisson counts matrix with a fixed seed and runs the standard early scRNA-seq
# pipeline (NormalizeData -> FindVariableFeatures -> ScaleData -> RunPCA) on it.
# Small-data statistical chatter is silenced with suppressWarnings/Messages, but
# real errors propagate. Checks are structural (class per step, non-empty
# variable features, PCA embedding dimensions) -- never numeric equality on the
# stochastic fit. Exits 0 only if every check passes, so it can be used as a
# pass/fail library validator:
#
#   Rscript Seurat.R
#
# NOTE (needs re-check once installed): RunPCA on a 100-gene x 20-cell toy
# matrix is at the edge of what PCA tolerates -- npcs is held to 5 and
# approx = FALSE forces the exact (non-irlba) solver, but the exact embedding
# column count and any small-data guard rails should be re-confirmed against an
# installed build. The pipeline entry points (NormalizeData/FindVariableFeatures/
# ScaleData/RunPCA) and the Embeddings/VariableFeatures accessors were written
# from the documented API.

if (!requireNamespace("Seurat", quietly = TRUE)) {
  cat("FAIL: package 'Seurat' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(Seurat))
cat(sprintf("Seurat version: %s\n", as.character(packageVersion("Seurat"))))

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

# Synthetic counts: 100 genes x 20 cells, integer Poisson draws (same toy design
# as the SeuratObject smoke test). Fixed seed keeps the object reproducible; the
# downstream fits are still stochastic, so all assertions stay structural.
set.seed(1)
m <- matrix(rpois(100 * 20, 5), nrow = 100, ncol = 20)
rownames(m) <- paste0("gene", 1:100)
colnames(m) <- paste0("cell", 1:20)

# Build once, reuse the same object across the pipeline stages. Each stage
# mutates and returns a Seurat object, so we thread it forward.
make_obj <- function() {
  suppressWarnings(suppressMessages(CreateSeuratObject(counts = m)))
}

run_test("NormalizeData returns a Seurat object", function() {
  obj <- make_obj()
  obj <- suppressWarnings(suppressMessages(NormalizeData(obj, verbose = FALSE)))
  stopifnot(inherits(obj, "Seurat"))
})

run_test("FindVariableFeatures flags variable genes", function() {
  obj <- make_obj()
  obj <- suppressWarnings(suppressMessages(NormalizeData(obj, verbose = FALSE)))
  obj <- suppressWarnings(suppressMessages(FindVariableFeatures(obj, verbose = FALSE)))
  stopifnot(inherits(obj, "Seurat"))
  vf <- VariableFeatures(obj)
  stopifnot(length(vf) > 0L, all(vf %in% rownames(m)))
})

run_test("ScaleData returns a Seurat object", function() {
  obj <- make_obj()
  obj <- suppressWarnings(suppressMessages(NormalizeData(obj, verbose = FALSE)))
  obj <- suppressWarnings(suppressMessages(FindVariableFeatures(obj, verbose = FALSE)))
  obj <- suppressWarnings(suppressMessages(ScaleData(obj, verbose = FALSE)))
  stopifnot(inherits(obj, "Seurat"))
})

run_test("RunPCA yields a pca embedding of the expected shape", function() {
  obj <- make_obj()
  obj <- suppressWarnings(suppressMessages(NormalizeData(obj, verbose = FALSE)))
  obj <- suppressWarnings(suppressMessages(FindVariableFeatures(obj, verbose = FALSE)))
  obj <- suppressWarnings(suppressMessages(ScaleData(obj, verbose = FALSE)))
  # npcs kept small for a 20-cell matrix; approx=FALSE avoids irlba, which is
  # unstable at this size. verbose off to suppress the loadings printout.
  obj <- suppressWarnings(suppressMessages(
    RunPCA(obj, npcs = 5, approx = FALSE, verbose = FALSE)
  ))
  stopifnot(inherits(obj, "Seurat"))
  stopifnot("pca" %in% Reductions(obj))
  emb <- Embeddings(obj, "pca")
  # One row per cell, one column per requested principal component.
  stopifnot(nrow(emb) == 20L, ncol(emb) == 5L)
  stopifnot(all(is.finite(emb)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all Seurat smoke tests passed\n")
