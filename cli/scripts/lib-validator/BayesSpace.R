#!/usr/bin/env Rscript
# Smoke test for the R `BayesSpace` package.
#
# Fully self-contained: no input files, no network. Builds a small synthetic
# SingleCellExperiment (genes x spots) with spatial coordinates in colData, then
# exercises only the LIGHT preprocessing surface. BayesSpace's core is a slow
# MCMC spatial-clustering step (spatialCluster / qTune) -- that is deliberately
# NOT run. Checks are structural (function existence, SCE class, spatial colData
# columns, a PCA reducedDim after preprocessing) -- never numeric. Exits 0 only
# if every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript BayesSpace.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# UNVERIFIABLE WITHOUT AN INSTALL -- confirm once BayesSpace is available:
#   - REQUIRED colData COLUMNS. BayesSpace keys off per-spot array coordinates
#     `row` and `col` (and pixel coordinates `imagerow`/`imagecol`); all four are
#     supplied. Re-confirm the exact names/spelling BayesSpace expects.
#   - spatialPreprocess() SIGNATURE. Assumes
#       spatialPreprocess(sce, platform = "ST", n.PCs = 5, n.HVGs = <= n_genes,
#                         log.normalize = TRUE)
#     returns an SCE carrying a "PCA" reducedDim with n.PCs columns. `n.HVGs`
#     defaults to 2000, which EXCEEDS the 100 synthetic genes and would error --
#     it is lowered here; re-check the argument name and default.
#   - HEAVY SURFACE NOT EXERCISED. spatialCluster() and qTune() run long MCMC
#     chains and are only checked for existence (is.function), never invoked.
#     Their signatures (q, platform, d, nrep, burn.in, ...) are entirely
#     UNVERIFIED here and must be validated separately.
# ============================================================================

if (!requireNamespace("BayesSpace", quietly = TRUE)) {
  cat("FAIL: package 'BayesSpace' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(BayesSpace))
cat(sprintf("BayesSpace version: %s\n", as.character(packageVersion("BayesSpace"))))

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

# Synthetic spatial data: 100 genes x 40 spots laid out on an 8x5 grid. colData
# carries the array coordinates (row/col) and pixel coordinates
# (imagerow/imagecol) BayesSpace consumes. Namespace-qualified constructors are
# used because BayesSpace imports SingleCellExperiment/S4Vectors without
# attaching them.
set.seed(1)
n_genes <- 100L
grid_rows <- 8L
grid_cols <- 5L
n_spots <- grid_rows * grid_cols

counts <- matrix(rpois(n_genes * n_spots, lambda = 5), nrow = n_genes, ncol = n_spots)
rownames(counts) <- paste0("gene", seq_len(n_genes))
colnames(counts) <- paste0("spot", seq_len(n_spots))

grid <- expand.grid(row = seq_len(grid_rows), col = seq_len(grid_cols))
col_data <- S4Vectors::DataFrame(
  row = grid$row,
  col = grid$col,
  imagerow = grid$row * 100,
  imagecol = grid$col * 100,
  row.names = colnames(counts)
)

make_sce <- function() {
  SingleCellExperiment::SingleCellExperiment(
    assays = list(counts = counts),
    colData = col_data
  )
}

run_test("prep + clustering entry points are exported functions", function() {
  stopifnot(is.function(spatialPreprocess))
  stopifnot(is.function(spatialCluster))
  stopifnot(is.function(qTune))
})

run_test("synthetic SCE carries the spatial colData columns", function() {
  sce <- make_sce()
  stopifnot(inherits(sce, "SingleCellExperiment"))
  stopifnot(ncol(sce) == n_spots)
  stopifnot(nrow(sce) == n_genes)
  cd_cols <- colnames(SummarizedExperiment::colData(sce))
  stopifnot(all(c("row", "col", "imagerow", "imagecol") %in% cd_cols))
  stopifnot("counts" %in% SummarizedExperiment::assayNames(sce))
})

run_test("spatialPreprocess yields a PCA reducedDim", function() {
  sce <- make_sce()
  # n.HVGs held to <= n_genes (default 2000 would exceed the 100 synthetic
  # genes). Preprocessing does log-normalisation + HVG selection + PCA; it
  # chatters, so silence warnings/messages. spatialCluster is NOT run.
  sce <- suppressWarnings(suppressMessages(
    spatialPreprocess(sce, platform = "ST", n.PCs = 5, n.HVGs = 50,
                      log.normalize = TRUE)
  ))
  stopifnot(inherits(sce, "SingleCellExperiment"))
  rd <- SingleCellExperiment::reducedDimNames(sce)
  stopifnot("PCA" %in% rd)
  pca <- SingleCellExperiment::reducedDim(sce, "PCA")
  stopifnot(nrow(pca) == n_spots, ncol(pca) == 5L)
  stopifnot(all(is.finite(pca)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all BayesSpace smoke tests passed\n")
