#!/usr/bin/env Rscript
# Smoke test for the R `matrixStats` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# matrixStats itself. Each check builds a fixed, seeded matrix and asserts
# that the matrixStats routine agrees with its base-R equivalent within
# tolerance. Exits 0 only if every check passes, so it can be used as a
# pass/fail library validator:
#
#   Rscript matrixStats.R

if (!requireNamespace("matrixStats", quietly = TRUE)) {
  cat("FAIL: package 'matrixStats' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(matrixStats))
cat(sprintf("matrixStats version: %s\n", as.character(packageVersion("matrixStats"))))

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

# A fresh, deterministic matrix per test keeps the checks order-independent.
make_x <- function() {
  set.seed(1)
  matrix(rnorm(50 * 4), 50, 4)
}

run_test("rowMedians matches base median", function() {
  x <- make_x()
  stopifnot(isTRUE(all.equal(matrixStats::rowMedians(x), apply(x, 1, median), tolerance = 1e-9)))
})

run_test("colVars and colSds match base", function() {
  x <- make_x()
  stopifnot(isTRUE(all.equal(matrixStats::colVars(x), apply(x, 2, var), tolerance = 1e-9)))
  stopifnot(isTRUE(all.equal(matrixStats::colSds(x), apply(x, 2, sd), tolerance = 1e-9)))
})

run_test("rowSums2 and colSums2 match base", function() {
  x <- make_x()
  stopifnot(isTRUE(all.equal(matrixStats::rowSums2(x), rowSums(x), tolerance = 1e-9)))
  stopifnot(isTRUE(all.equal(matrixStats::colSums2(x), colSums(x), tolerance = 1e-9)))
})

run_test("colMaxs and colMins match base", function() {
  x <- make_x()
  stopifnot(isTRUE(all.equal(matrixStats::colMaxs(x), apply(x, 2, max), tolerance = 1e-9)))
  stopifnot(isTRUE(all.equal(matrixStats::colMins(x), apply(x, 2, min), tolerance = 1e-9)))
})

run_test("colQuantiles shape and endpoints", function() {
  x <- make_x()
  q <- matrixStats::colQuantiles(x, probs = c(0, 0.5, 1))
  stopifnot(is.matrix(q), nrow(q) == 4L, ncol(q) == 3L)
  stopifnot(isTRUE(all.equal(unname(q[, 1]), apply(x, 2, min), tolerance = 1e-9)))
  stopifnot(isTRUE(all.equal(unname(q[, 2]), apply(x, 2, median), tolerance = 1e-9)))
  stopifnot(isTRUE(all.equal(unname(q[, 3]), apply(x, 2, max), tolerance = 1e-9)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all matrixStats smoke tests passed\n")
