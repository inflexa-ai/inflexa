#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `S4Vectors` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# S4Vectors and the Bioconductor base packages it attaches (BiocGenerics).
# Builds small in-memory Rle / DataFrame / SimpleList / Hits objects and
# asserts their structure and exact values. Exits 0 only if every check passes,
# so it can be used as a pass/fail library validator:
#
#   Rscript S4Vectors.R

if (!requireNamespace("S4Vectors", quietly = TRUE)) {
  cat("FAIL: package 'S4Vectors' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(S4Vectors))
cat(sprintf("S4Vectors version: %s\n", as.character(packageVersion("S4Vectors"))))

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

run_test("Rle run-length encoding", function() {
  x <- Rle(c(1, 1, 2, 2, 2))
  stopifnot(length(x) == 5L)
  stopifnot(identical(runLength(x), c(2L, 3L)))
  stopifnot(identical(runValue(x), c(1, 2)))
  stopifnot(nrun(x) == 2L)
})

run_test("Rle decodes back to a plain vector", function() {
  x <- Rle(c(1, 1, 2, 2, 2))
  stopifnot(identical(as.vector(x), c(1, 1, 2, 2, 2)))
  stopifnot(identical(as.numeric(x), c(1, 1, 2, 2, 2)))
})

run_test("DataFrame construction and column access", function() {
  df <- DataFrame(a = 1:3, b = letters[1:3])
  stopifnot(inherits(df, "DataFrame"))
  stopifnot(nrow(df) == 3L, ncol(df) == 2L)
  stopifnot(identical(colnames(df), c("a", "b")))
  stopifnot(identical(df$a, 1:3))
  stopifnot(identical(df$b, c("a", "b", "c")))
  stopifnot(identical(df[["a"]], 1:3))
})

run_test("DataFrame row subsetting", function() {
  df <- DataFrame(a = 1:3, b = letters[1:3])
  sub <- df[1:2, ]
  stopifnot(nrow(sub) == 2L, identical(sub$a, 1:2))
  stopifnot(identical(df[, "a"], 1:3))
})

run_test("SimpleList holds named elements", function() {
  sl <- SimpleList(a = 1:3, b = letters[1:2])
  stopifnot(inherits(sl, "SimpleList"))
  stopifnot(length(sl) == 2L)
  stopifnot(identical(names(sl), c("a", "b")))
  stopifnot(identical(sl$a, 1:3))
  stopifnot(identical(sl[["b"]], c("a", "b")))
})

run_test("Hits and queryHits/subjectHits", function() {
  h <- Hits(from = c(1L, 1L, 2L), to = c(1L, 2L, 3L), nLnode = 2L, nRnode = 3L)
  stopifnot(length(h) == 3L)
  stopifnot(identical(queryHits(h), c(1L, 1L, 2L)))
  stopifnot(identical(subjectHits(h), c(1L, 2L, 3L)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all S4Vectors smoke tests passed\n")
