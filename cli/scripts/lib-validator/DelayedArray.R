#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `DelayedArray` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# DelayedArray and the Bioconductor/CRAN base packages it attaches (Matrix,
# BiocGenerics, MatrixGenerics, S4Vectors, IRanges, S4Arrays, SparseArray).
# Wraps a synthetic in-memory matrix in a DelayedArray, then asserts that the
# delayed ops realize to the same values as the equivalent base-matrix
# computation (elementwise arithmetic, row/col sums, subsetting). Exits 0 only
# if every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript DelayedArray.R

if (!requireNamespace("DelayedArray", quietly = TRUE)) {
  cat("FAIL: package 'DelayedArray' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(DelayedArray))
cat(sprintf("DelayedArray version: %s\n", as.character(packageVersion("DelayedArray"))))

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

run_test("DelayedArray construction dims", function() {
  m <- matrix(1:12, nrow = 3, ncol = 4)
  da <- DelayedArray(m)
  stopifnot(is(da, "DelayedArray"))
  stopifnot(identical(dim(da), c(3L, 4L)))
})

run_test("elementwise arithmetic realizes correctly", function() {
  m <- matrix(1:12, nrow = 3, ncol = 4)
  da <- DelayedArray(m)
  stopifnot(identical(as.matrix(da * 2L), m * 2L))
  stopifnot(identical(as.matrix(da + 1L), m + 1L))
})

run_test("rowSums / colSums match base", function() {
  m <- matrix(1:12, nrow = 3, ncol = 4)
  da <- DelayedArray(m)
  stopifnot(isTRUE(all.equal(rowSums(da), rowSums(m))))
  stopifnot(isTRUE(all.equal(colSums(da), colSums(m))))
})

run_test("subsetting realizes the expected block", function() {
  m <- matrix(1:12, nrow = 3, ncol = 4)
  da <- DelayedArray(m)
  stopifnot(identical(as.matrix(da[1:2, 1:2]), m[1:2, 1:2]))
  stopifnot(identical(as.matrix(da[2:3, , drop = FALSE]), m[2:3, , drop = FALSE]))
})

run_test("single-element access realizes a scalar", function() {
  m <- matrix(1:12, nrow = 3, ncol = 4)
  da <- DelayedArray(m)
  stopifnot(as.vector(da[1, 1]) == 1L)
  stopifnot(as.vector(da[3, 4]) == 12L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all DelayedArray smoke tests passed\n")
