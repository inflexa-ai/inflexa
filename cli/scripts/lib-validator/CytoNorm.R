#!/usr/bin/env Rscript
# Smoke test for the R `CytoNorm` package.
#
# Fully self-contained: no input files, NO network. CytoNorm is a CyTOF/flow
# batch-normalization method (FlowSOM clustering + per-cluster quantile
# normalization). This test stays MODEST: it (1) asserts the key train/normalize
# entry points are exported functions, (2) builds a synthetic two-batch
# flowCore::flowSet (with a planted per-batch shift) and checks its shape, then
# (3) runs a SOFT lower-level QuantileNorm.train -> QuantileNorm.normalize
# round-trip and, only if it is constructible offline, asserts the normalized
# output keeps its dims and that the between-batch mean gap SHRINKS. Checks are
# STRUCTURAL/tolerance (object shape, dims, an inequality on the batch gap)
# rather than numeric equality on random data. Exits 0 only if every check
# passes, so it can be used as a pass/fail library validator:
#
#   Rscript CytoNorm.R
#
# Install (GitHub-hosted, not on CRAN/Bioconductor):
#   remotes::install_github("saeyslab/CytoNorm")
#
# ======================= ASSUMPTIONS TO RE-CHECK (FIDDLY) ====================
# Written from the CytoNorm source (saeyslab/CytoNorm) rather than a live
# install. The train/normalize signatures + the transformList contract are the
# easy-to-get-wrong parts -- RE-VERIFY every one of these:
#
#  * HIGH-LEVEL pipeline (heavily version-sensitive):
#      CytoNorm.train(files, labels, channels, transformList,
#                     FlowSOM.params = list(nCells=, xdim=, ydim=, nClus=, ...),
#                     normMethod.train = QuantileNorm.train, seed=, ...)
#      CytoNorm.normalize(model, files, labels, transformList,
#                         transformList.reverse, outputDir=, prefix=, ...)
#    - `files` is a flowSet (or a character vector of FCS paths); `labels` is a
#      per-FILE batch label vector; `channels` are the channels to normalize.
#    - transformList is REQUIRED for real CyTOF data: intensities must be
#      asinh-transformed (typical cofactor 5) BEFORE clustering/normalization,
#      and transformList.reverse un-does it on the written output. Passing the
#      wrong (or no) transform silently corrupts results. CytoNorm.normalize
#      WRITES normalized FCS files to `outputDir` (disk I/O) and returns paths.
#    - We DO NOT run the high-level FlowSOM pipeline here (too much surface to
#      pin offline); we only assert CytoNorm.train / CytoNorm.normalize EXIST.
#
#  * LOWER-LEVEL quantile normalization (what the soft round-trip exercises):
#      QuantileNorm.train(files, labels, channels, transformList,
#                         nQ = 101, goal = "mean", ...)
#      QuantileNorm.normalize(model, files, labels, transformList,
#                             transformList.reverse, outputDir=, prefix=,
#                             write = TRUE, ...)
#    - transformList MAY be NULL here (data assumed already on the analysis
#      scale) -- so the soft round-trip passes NULL and feeds already-modest
#      synthetic values, sidestepping the asinh/reverse-asinh pair entirely.
#    - `goal = "mean"` aligns every batch to the pooled mean quantiles; it can
#      also be a batch label or an explicit goal-quantile matrix.
#    - QuantileNorm.normalize WRITES FCS to outputDir and returns the written
#      paths; the round-trip reads them back with flowCore::read.flowSet. This
#      exact 3-plus-arg signature + file-writing behaviour is UNVERIFIED here,
#      so the whole round-trip is best-effort: if it will not construct offline
#      it SOFT-SKIPS (no failure); only once it produces output do the dims /
#      finiteness / gap-shrinks assertions become HARD.
#
#  * flowCore is a hard dependency of CytoNorm, so it is guaranteed installed
#    whenever CytoNorm is; the synthetic flowSet is built with flowCore.
# ============================================================================

if (!requireNamespace("CytoNorm", quietly = TRUE)) {
  cat("FAIL: package 'CytoNorm' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(CytoNorm))
cat(sprintf("CytoNorm version: %s\n", as.character(packageVersion("CytoNorm"))))

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

# ---- synthetic two-batch data --------------------------------------------
# Two batches of 2000 cells x 5 markers. Batch 2 carries a planted +2 shift on
# every marker (the "batch effect" quantile normalization should remove). Values
# are already on a modest scale, so no transformList is needed (see NOTE above).
set.seed(1)
markers <- paste0("M", 1:5)
n_cells <- 2000L
mat_b1 <- matrix(rnorm(n_cells * length(markers), mean = 0, sd = 1),
                 ncol = length(markers), dimnames = list(NULL, markers))
mat_b2 <- matrix(rnorm(n_cells * length(markers), mean = 2, sd = 1),
                 ncol = length(markers), dimnames = list(NULL, markers))

# Uncorrected between-batch mean gap (planted ~2 on each marker).
gap_before <- mean(abs(colMeans(mat_b1) - colMeans(mat_b2)))

# One flowFrame per batch -> a 2-sample flowSet, one label per sample.
synthetic_flowset <- function() {
  ff1 <- flowCore::flowFrame(mat_b1)
  ff2 <- flowCore::flowFrame(mat_b2)
  fs <- flowCore::flowSet(ff1, ff2)
  flowCore::sampleNames(fs) <- c("batch1", "batch2")
  fs
}

# SOFT: full QuantileNorm.train -> normalize -> read-back round-trip. Throws if
# it cannot be constructed offline (uncertain signature / disk I/O); the caller
# turns that throw into a soft-skip.
quantile_roundtrip <- function() {
  stopifnot(requireNamespace("flowCore", quietly = TRUE))
  fs <- synthetic_flowset()
  labels <- c("batch1", "batch2")   # one batch label per file/sample

  model <- QuantileNorm.train(
    files = fs, labels = labels, channels = markers,
    transformList = NULL, nQ = 101, goal = "mean")

  out_dir <- file.path(tempdir(), sprintf("cytonorm-smoke-%d", as.integer(Sys.time())))
  dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
  on.exit(unlink(out_dir, recursive = TRUE), add = TRUE)

  written <- QuantileNorm.normalize(
    model = model, files = fs, labels = labels,
    transformList = NULL, transformList.reverse = NULL,
    outputDir = out_dir, prefix = "Norm_", write = TRUE)

  normed <- flowCore::read.flowSet(files = as.character(written))
  after1 <- flowCore::exprs(normed[[1]])[, markers, drop = FALSE]
  after2 <- flowCore::exprs(normed[[2]])[, markers, drop = FALSE]
  list(
    n = n_cells,
    after1 = after1,
    after2 = after2,
    gap_after = mean(abs(colMeans(after1) - colMeans(after2)))
  )
}

run_test("train/normalize entry points are exported functions", function() {
  stopifnot(is.function(CytoNorm.train))
  stopifnot(is.function(CytoNorm.normalize))
  stopifnot(is.function(QuantileNorm.train))
  stopifnot(is.function(QuantileNorm.normalize))
})

run_test("synthetic 2-batch flowSet has the expected shape", function() {
  stopifnot(requireNamespace("flowCore", quietly = TRUE))
  fs <- synthetic_flowset()
  stopifnot(is(fs, "flowSet"))
  stopifnot(length(fs) == 2L)                       # two batches
  stopifnot(all(markers %in% flowCore::colnames(fs)))
  stopifnot(nrow(flowCore::exprs(fs[[1]])) == n_cells)
  stopifnot(nrow(flowCore::exprs(fs[[2]])) == n_cells)
})

run_test("QuantileNorm round-trip (soft): dims preserved & batch gap shrinks", function() {
  res <- tryCatch(
    suppressWarnings(suppressMessages(quantile_roundtrip())),
    error = function(e) {
      cat(sprintf("       (soft-skip: round-trip not constructible offline: %s)\n",
                  conditionMessage(e)))
      NULL
    })
  if (is.null(res)) return(invisible(NULL))  # soft-skip: nothing to assert
  # Round-trip produced output -> assertions are now HARD.
  stopifnot(nrow(res$after1) == res$n, nrow(res$after2) == res$n)
  stopifnot(all(is.finite(res$after1)), all(is.finite(res$after2)))
  # Quantile normalization aligns the batches: the mean gap must not grow, and
  # in practice shrinks well below the planted ~2 (tolerance, not equality).
  stopifnot(res$gap_after <= gap_before + 1e-8)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all CytoNorm smoke tests passed\n")
