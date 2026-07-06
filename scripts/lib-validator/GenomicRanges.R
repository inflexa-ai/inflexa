#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `GenomicRanges` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# GenomicRanges and the Bioconductor base packages it attaches (BiocGenerics,
# S4Vectors, IRanges, GenomeInfoDb). Builds small in-memory GRanges /
# GRangesList objects and asserts exact results for the accessors and core
# range operations (shift, flank, findOverlaps). Exits 0 only if every check
# passes, so it can be used as a pass/fail library validator:
#
#   Rscript GenomicRanges.R

if (!requireNamespace("GenomicRanges", quietly = TRUE)) {
  cat("FAIL: package 'GenomicRanges' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(GenomicRanges))
cat(sprintf("GenomicRanges version: %s\n", as.character(packageVersion("GenomicRanges"))))

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

run_test("GRanges construction and range accessors", function() {
  gr <- GRanges("chr1", IRanges(1:3, width = 10), strand = "+")
  stopifnot(length(gr) == 3L)
  stopifnot(identical(start(gr), c(1L, 2L, 3L)))
  stopifnot(identical(end(gr), c(10L, 11L, 12L)))
  stopifnot(identical(width(gr), c(10L, 10L, 10L)))
})

run_test("seqnames and strand", function() {
  gr <- GRanges("chr1", IRanges(1:3, width = 10), strand = "+")
  stopifnot(identical(as.character(seqnames(gr)), rep("chr1", 3)))
  stopifnot(identical(as.character(strand(gr)), rep("+", 3)))
})

run_test("GRangesList groups GRanges", function() {
  gr <- GRanges("chr1", IRanges(1:3, width = 10), strand = "+")
  grl <- GRangesList(a = gr, b = gr[1:2])
  stopifnot(length(grl) == 2L)
  stopifnot(identical(names(grl), c("a", "b")))
  stopifnot(identical(unname(lengths(grl)), c(3L, 2L)))
})

run_test("shift moves ranges by the offset", function() {
  gr <- GRanges("chr1", IRanges(1:3, width = 10), strand = "+")
  s <- shift(gr, 5)
  stopifnot(identical(start(s), c(6L, 7L, 8L)))
  stopifnot(identical(end(s), c(15L, 16L, 17L)))
})

run_test("flank yields upstream ranges on + strand", function() {
  gr <- GRanges("chr1", IRanges(1:3, width = 10), strand = "+")
  fl <- flank(gr, 3)
  stopifnot(identical(width(fl), c(3L, 3L, 3L)))
  stopifnot(identical(start(fl), c(-2L, -1L, 0L)))
  stopifnot(identical(end(fl), c(0L, 1L, 2L)))
})

run_test("findOverlaps / countOverlaps across GRanges", function() {
  q <- GRanges("chr1", IRanges(c(1, 20), width = 5))
  s <- GRanges("chr1", IRanges(c(3, 100), width = 5))
  ov <- findOverlaps(q, s)
  stopifnot(length(ov) == 1L)
  stopifnot(identical(queryHits(ov), 1L), identical(subjectHits(ov), 1L))
  stopifnot(identical(countOverlaps(q, s), c(1L, 0L)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all GenomicRanges smoke tests passed\n")
