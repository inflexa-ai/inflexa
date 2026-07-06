#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `HDF5Array` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# HDF5Array and the packages it attaches (DelayedArray, rhdf5). The one bit of
# I/O is a private, per-test temporary `.h5` file that this script creates AND
# removes via on.exit(unlink(...)) — no pre-existing/external file is read and
# nothing is left behind. Exercises the HDF5 write/read roundtrip through the
# bundled rhdf5 backend and asserts the realized values match the source
# matrix. Exits 0 only if every check passes, so it can be used as a pass/fail
# library validator:
#
#   Rscript HDF5Array.R

if (!requireNamespace("HDF5Array", quietly = TRUE)) {
  cat("FAIL: package 'HDF5Array' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(HDF5Array))
cat(sprintf("HDF5Array version: %s\n", as.character(packageVersion("HDF5Array"))))

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

run_test("writeHDF5Array returns an HDF5-backed DelayedArray", function() {
  m <- matrix(1:12, nrow = 3, ncol = 4)
  p <- tempfile(fileext = ".h5")
  on.exit(unlink(p), add = TRUE)
  ha <- writeHDF5Array(m, filepath = p, name = "m")
  stopifnot(is(ha, "HDF5Array"))
  stopifnot(is(ha, "DelayedArray"))
  stopifnot(identical(dim(ha), c(3L, 4L)))
})

run_test("HDF5 write/read roundtrip preserves values", function() {
  m <- matrix(1:12, nrow = 3, ncol = 4)
  p <- tempfile(fileext = ".h5")
  on.exit(unlink(p), add = TRUE)
  writeHDF5Array(m, filepath = p, name = "m")
  back <- HDF5Array(p, "m")
  stopifnot(is(back, "HDF5Array"))
  stopifnot(identical(dim(back), c(3L, 4L)))
  stopifnot(identical(as.matrix(back), m))
})

run_test("realized values match the source at write time", function() {
  m <- matrix(1:12, nrow = 3, ncol = 4)
  p <- tempfile(fileext = ".h5")
  on.exit(unlink(p), add = TRUE)
  ha <- writeHDF5Array(m, filepath = p, name = "m")
  stopifnot(identical(as.matrix(ha), m))
})

run_test("delayed arithmetic on an HDF5-backed array", function() {
  m <- matrix(1:12, nrow = 3, ncol = 4)
  p <- tempfile(fileext = ".h5")
  on.exit(unlink(p), add = TRUE)
  ha <- writeHDF5Array(m, filepath = p, name = "m")
  stopifnot(identical(as.matrix(ha * 2L), m * 2L))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all HDF5Array smoke tests passed\n")
