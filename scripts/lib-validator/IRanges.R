#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `IRanges` package.
#
# Fully self-contained: no input files, no network, no packages beyond IRanges
# and the Bioconductor base packages it attaches (BiocGenerics, S4Vectors).
# Builds small in-memory IRanges objects and asserts exact integer results for
# the construction accessors and the core range algebra (reduce, disjoin,
# shift, findOverlaps/countOverlaps). Exits 0 only if every check passes, so it
# can be used as a pass/fail library validator:
#
#   Rscript IRanges.R

if (!requireNamespace("IRanges", quietly = TRUE)) {
  cat("FAIL: package 'IRanges' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(IRanges))
cat(sprintf("IRanges version: %s\n", as.character(packageVersion("IRanges"))))

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

run_test("IRanges construction and accessors", function() {
  ir <- IRanges(start = c(1, 10, 20), end = c(5, 15, 25))
  stopifnot(length(ir) == 3L)
  stopifnot(identical(start(ir), c(1L, 10L, 20L)))
  stopifnot(identical(end(ir), c(5L, 15L, 25L)))
  stopifnot(identical(width(ir), c(5L, 6L, 6L)))
})

run_test("shift moves ranges by the offset", function() {
  ir <- IRanges(start = c(1, 10, 20), end = c(5, 15, 25))
  s <- shift(ir, 5)
  stopifnot(identical(start(s), c(6L, 15L, 25L)))
  stopifnot(identical(end(s), c(10L, 20L, 30L)))
  stopifnot(identical(width(s), c(5L, 6L, 6L)))
})

run_test("reduce merges overlapping ranges", function() {
  ir <- IRanges(start = c(1, 3, 10), end = c(5, 8, 15))
  red <- reduce(ir)
  stopifnot(length(red) == 2L)
  stopifnot(identical(start(red), c(1L, 10L)))
  stopifnot(identical(end(red), c(8L, 15L)))
})

run_test("disjoin splits into non-overlapping pieces", function() {
  ir <- IRanges(start = c(1, 3, 10), end = c(5, 8, 15))
  dj <- disjoin(ir)
  stopifnot(length(dj) == 4L)
  stopifnot(identical(start(dj), c(1L, 3L, 6L, 10L)))
  stopifnot(identical(end(dj), c(2L, 5L, 8L, 15L)))
})

run_test("findOverlaps / countOverlaps", function() {
  q <- IRanges(start = c(1, 10), end = c(5, 15))
  s <- IRanges(start = c(3, 12, 20), end = c(8, 18, 25))
  ov <- findOverlaps(q, s)
  stopifnot(length(ov) == 2L)
  stopifnot(identical(queryHits(ov), c(1L, 2L)))
  stopifnot(identical(subjectHits(ov), c(1L, 2L)))
  stopifnot(identical(countOverlaps(q, s), c(1L, 1L)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all IRanges smoke tests passed\n")
