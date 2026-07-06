#!/usr/bin/env Rscript
# Smoke test for the R `energy` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# energy itself. Uses fixed seeds and range/tolerance assertions (never
# exact p-values) and exits 0 only if every check passes, so it can be
# used as a pass/fail library validator:
#
#   Rscript energy.R

if (!requireNamespace("energy", quietly = TRUE)) {
  cat("FAIL: package 'energy' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(energy))
cat(sprintf("energy version: %s\n", as.character(packageVersion("energy"))))

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

run_test("dcor: perfect dependence is 1, independence is small", function() {
  set.seed(1)
  x <- rnorm(50)
  y <- rnorm(50)
  stopifnot(isTRUE(all.equal(dcor(x, x), 1, tolerance = 1e-8)))
  # A noiseless linear map is total dependence: dcor stays 1.
  stopifnot(isTRUE(all.equal(dcor(x, 2 * x + 3), 1, tolerance = 1e-8)))
  d <- dcor(x, y)
  stopifnot(is.finite(d), d >= 0, d < 0.4)
})

run_test("dcov.test returns a sane htest", function() {
  set.seed(2)
  x <- rnorm(30)
  y <- rnorm(30)
  t <- dcov.test(x, y, R = 199)
  stopifnot(inherits(t, "htest"))
  stopifnot(is.finite(as.numeric(t$statistic)))
  stopifnot(t$p.value >= 0, t$p.value <= 1)
})

run_test("edist on two separated samples", function() {
  set.seed(3)
  m <- rbind(matrix(rnorm(40), 20, 2), matrix(rnorm(40, mean = 3), 20, 2))
  e <- edist(m, c(20, 20))
  stopifnot(inherits(e, "dist"))
  ev <- as.numeric(e)
  stopifnot(length(ev) == 1L, is.finite(ev), ev > 0)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all energy smoke tests passed\n")
