#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `BiocParallel` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# BiocParallel itself. Uses SerialParam() ONLY: it runs everything in-process
# with no forked/socket workers, so results are deterministic and there is no
# reliance on the host's parallel backend. Exercises the core apply family
# (bplapply, bpmapply, bpvec) and asserts exact values. Exits 0 only if every
# check passes, so it can be used as a pass/fail library validator:
#
#   Rscript BiocParallel.R

if (!requireNamespace("BiocParallel", quietly = TRUE)) {
  cat("FAIL: package 'BiocParallel' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(BiocParallel))
cat(sprintf("BiocParallel version: %s\n", as.character(packageVersion("BiocParallel"))))

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

run_test("SerialParam is a param object with one worker", function() {
  p <- SerialParam()
  stopifnot(is(p, "SerialParam"), is(p, "BiocParallelParam"))
  stopifnot(bpnworkers(p) == 1L)
})

run_test("bplapply maps over a vector", function() {
  res <- bplapply(1:5, function(i) i^2, BPPARAM = SerialParam())
  stopifnot(is.list(res), length(res) == 5L)
  stopifnot(identical(res, list(1, 4, 9, 16, 25)))
})

run_test("bpmapply zips multiple vectors", function() {
  res <- bpmapply(function(a, b) a + b, 1:3, 4:6, BPPARAM = SerialParam())
  stopifnot(identical(res, c(5L, 7L, 9L)))
})

run_test("bpvec applies over vector chunks", function() {
  res <- bpvec(1:10, function(x) x * 2L, BPPARAM = SerialParam())
  stopifnot(identical(res, (1:10) * 2L))
})

run_test("bplapply preserves names", function() {
  res <- bplapply(c(a = 2L, b = 3L), function(i) i + 1L, BPPARAM = SerialParam())
  stopifnot(identical(names(res), c("a", "b")))
  stopifnot(identical(res[["a"]], 3L), identical(res[["b"]], 4L))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all BiocParallel smoke tests passed\n")
