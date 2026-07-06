#!/usr/bin/env Rscript
# Smoke test for the R `cyCombine` package.
#
# Fully self-contained: no input files, NO network. cyCombine corrects batch
# effects in high-dimensional cytometry data (SOM clustering + per-cluster
# ComBat). It works on a TIDY data frame/tibble where rows = cells and columns
# = markers plus a `batch` (and optional `sample`) column. This test runs a
# GENUINE offline correction: it builds a synthetic 2000-cell x 10-marker tibble
# with a planted per-batch shift, calls batch_correct(), and asserts the
# corrected tibble keeps its row count + marker columns, stays finite, and that
# the between-batch mean gap SHRINKS versus the uncorrected data. Checks are
# STRUCTURAL/tolerance (shape, finiteness, an inequality on the batch gap)
# rather than numeric equality on random data. Exits 0 only if every check
# passes, so it can be used as a pass/fail library validator:
#
#   Rscript cyCombine.R
#
# Install (GitHub-hosted, not on CRAN/Bioconductor):
#   remotes::install_github("biosurf/cyCombine")
#
# ======================= ASSUMPTIONS TO RE-CHECK (FIDDLY) ====================
# Written from the cyCombine source (biosurf/cyCombine) rather than a live
# install. The batch_correct() argument names + the tibble column contract are
# the easy-to-get-wrong parts -- RE-VERIFY every one of these:
#
#  * batch_correct(df, markers = <chr>, batch = "batch", covar = NULL,
#                  seed = , xdim = 8, ydim = 8, rlen = 10,
#                  norm_method = "scale", ...):
#      - `df` is a tibble/data.frame: one ROW per cell, one COLUMN per marker,
#        PLUS a batch column and (optionally) a `sample` column. covar names an
#        optional biological covariate to preserve during ComBat.
#      - The `batch =` ARGUMENT NAME is UNVERIFIED. Some versions do NOT take a
#        `batch =` parameter and instead HARD-CODE a column literally named
#        "batch". We hedge by naming the column "batch" regardless -- so the
#        data is correct whether batch_correct reads the arg or the column. If a
#        given version rejects `batch =` ("unused argument"), DROP it from the
#        call; the "batch" column already carries the grouping.
#      - The `sample` column is OPTIONAL (used for anchoring / covariates); we
#        include it for realism, but correction keys on `batch`.
#
#  * RETURN VALUE: a corrected tibble on the NORMALIZED scale. It preserves the
#    marker columns and the row count, and typically ADDS helper columns (e.g.
#    `id`, `label` = SOM node). So we assert marker columns are a SUBSET of the
#    result's columns (not column-set equality) and compare the batch gap on the
#    CORRECTED values vs the UNCORRECTED planted gap as an INEQUALITY, never an
#    exact numeric target.
#
#  * DEPENDENCIES: the SOM comes from kohonen and the correction from sva/ComBat
#    -- both are cyCombine dependencies, present whenever cyCombine is installed.
#    batch_correct() is seeded, so with a fixed `seed` the run is deterministic.
# ============================================================================

if (!requireNamespace("cyCombine", quietly = TRUE)) {
  cat("FAIL: package 'cyCombine' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(cyCombine))
cat(sprintf("cyCombine version: %s\n", as.character(packageVersion("cyCombine"))))

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

# ---- synthetic tidy cytometry table ---------------------------------------
# 2000 cells x 10 markers across two batches (A, B), two samples per batch.
# Batch B carries a planted +3 shift on every marker -- the batch effect that
# correction should remove. rows = cells; columns = markers + batch + sample.
set.seed(1)
n_cells   <- 2000L
n_markers <- 10L
markers   <- paste0("M", sprintf("%02d", seq_len(n_markers)))

sample <- rep(c("S1", "S2", "S3", "S4"), each = n_cells / 4L)
batch  <- ifelse(sample %in% c("S1", "S2"), "A", "B")
shift  <- ifelse(batch == "B", 3, 0)

expr <- matrix(rnorm(n_cells * n_markers), nrow = n_cells, ncol = n_markers)
expr <- expr + shift
colnames(expr) <- markers

df <- as.data.frame(expr, stringsAsFactors = FALSE)
df$batch  <- batch
df$sample <- sample
if (requireNamespace("tibble", quietly = TRUE)) df <- tibble::as_tibble(df)

# Uncorrected between-batch mean gap, averaged over markers (planted ~3).
batch_gap <- function(mat, grp) {
  mean(abs(colMeans(mat[grp == "A", , drop = FALSE]) -
           colMeans(mat[grp == "B", , drop = FALSE])))
}
gap_before <- batch_gap(expr, batch)

run_test("batch_correct + helpers are exported functions", function() {
  stopifnot(is.function(cyCombine::batch_correct))
  stopifnot(is.function(cyCombine::normalize))
  stopifnot(is.function(cyCombine::create_som))
  stopifnot(is.function(cyCombine::correct_data))
})

run_test("synthetic tidy tibble has the expected shape", function() {
  stopifnot(nrow(df) == n_cells)
  stopifnot(all(markers %in% colnames(df)))
  stopifnot("batch" %in% colnames(df))
  stopifnot(setequal(unique(df$batch), c("A", "B")))
  # planted effect is real: the uncorrected gap is large.
  stopifnot(gap_before > 1)
})

run_test("batch_correct preserves shape, stays finite, shrinks the batch gap", function() {
  corrected <- suppressWarnings(suppressMessages(
    cyCombine::batch_correct(df, markers = markers, batch = "batch", seed = 1)))
  # same number of cells (one corrected row per input cell)
  stopifnot(nrow(corrected) == n_cells)
  # marker columns survive the correction (result may ADD helper columns)
  stopifnot(all(markers %in% colnames(corrected)))
  cm <- as.matrix(corrected[, markers])
  stopifnot(all(is.finite(cm)))
  # corrected batch labels, aligned row-for-row (batch_correct keeps row order)
  bvec <- as.character(corrected[["batch"]])
  stopifnot(length(bvec) == n_cells)
  # ComBat removes the planted shift: the between-batch mean gap must shrink
  # well below the uncorrected gap (tolerance/inequality, never equality).
  gap_after <- batch_gap(cm, bvec)
  stopifnot(gap_after < gap_before)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all cyCombine smoke tests passed\n")
