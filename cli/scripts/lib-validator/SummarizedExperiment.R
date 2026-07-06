#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `SummarizedExperiment` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# SummarizedExperiment and the Bioconductor base packages it attaches
# (GenomicRanges, S4Vectors, MatrixGenerics, Biobase, ...). Builds a small
# in-memory SummarizedExperiment from a synthetic assay matrix plus colData and
# asserts its dimensions, assay roundtrip, column-metadata access, and
# subsetting. Exits 0 only if every check passes, so it can be used as a
# pass/fail library validator:
#
#   Rscript SummarizedExperiment.R

if (!requireNamespace("SummarizedExperiment", quietly = TRUE)) {
  cat("FAIL: package 'SummarizedExperiment' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(SummarizedExperiment))
cat(sprintf("SummarizedExperiment version: %s\n", as.character(packageVersion("SummarizedExperiment"))))

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

make_se <- function() {
  SummarizedExperiment(
    assays = list(counts = matrix(1:12, nrow = 3, ncol = 4)),
    colData = DataFrame(cond = factor(c("a", "a", "b", "b")))
  )
}

run_test("SummarizedExperiment construction dims", function() {
  se <- make_se()
  stopifnot(is(se, "SummarizedExperiment"))
  stopifnot(identical(dim(se), c(3L, 4L)))
  stopifnot(nrow(se) == 3L, ncol(se) == 4L)
})

run_test("assay names and matrix roundtrip", function() {
  se <- make_se()
  stopifnot(identical(assayNames(se), "counts"))
  stopifnot(identical(assay(se, "counts"), matrix(1:12, nrow = 3, ncol = 4)))
  stopifnot(identical(assay(se), matrix(1:12, nrow = 3, ncol = 4)))
})

run_test("colData column access", function() {
  se <- make_se()
  cond <- colData(se)$cond
  stopifnot(is.factor(cond))
  stopifnot(identical(as.character(cond), c("a", "a", "b", "b")))
})

run_test("row subsetting keeps assay layout", function() {
  se <- make_se()
  sub <- se[1:2, 1:2]
  stopifnot(identical(dim(sub), c(2L, 2L)))
  stopifnot(identical(assay(sub, "counts"), matrix(1:12, nrow = 3, ncol = 4)[1:2, 1:2]))
})

run_test("column subsetting narrows colData", function() {
  se <- make_se()
  sub <- se[, 1:2]
  stopifnot(ncol(sub) == 2L)
  stopifnot(identical(as.character(colData(sub)$cond), c("a", "a")))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all SummarizedExperiment smoke tests passed\n")
