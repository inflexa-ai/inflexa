#!/usr/bin/env Rscript
# Smoke test for the R `DescTools` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# DescTools itself. Exercises pure helpers with deterministic expected
# values and exits 0 only if every check passes, so it can be used as a
# pass/fail library validator:
#
#   Rscript DescTools.R

if (!requireNamespace("DescTools", quietly = TRUE)) {
  cat("FAIL: package 'DescTools' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(DescTools))
cat(sprintf("DescTools version: %s\n", as.character(packageVersion("DescTools"))))

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

run_test("Mode of a small vector", function() {
  m <- Mode(c(1, 1, 2, 3))
  stopifnot(as.numeric(m) == 1)
  stopifnot(attr(m, "freq") == 2L)
})

run_test("Gini: equality and concentration", function() {
  stopifnot(isTRUE(all.equal(Gini(c(1, 1, 1, 1)), 0)))
  # Closed form for c(0, 0, 0, 10): sum|xi-xj| / (2 n^2 mu) = 60/80 = 0.75.
  stopifnot(isTRUE(all.equal(Gini(c(0, 0, 0, 10), unbiased = FALSE), 0.75, tolerance = 1e-8)))
  # The default (unbiased) estimator scales by n/(n-1); still heavily concentrated.
  stopifnot(Gini(c(0, 0, 0, 10)) > 0.7)
})

run_test("Winsorize clamps the tails", function() {
  w <- Winsorize(1:10, val = c(2, 9))
  stopifnot(isTRUE(all.equal(as.numeric(w), c(2, 2, 3, 4, 5, 6, 7, 8, 9, 9))))
})

run_test("%like% and %nin% operators", function() {
  stopifnot(identical(c("apple", "banana") %like% "%an%", c(FALSE, TRUE)))
  stopifnot(identical(c(1, 2) %nin% c(2, 3), c(TRUE, FALSE)))
})

run_test("AUC matches the trapezoid area", function() {
  # y = x on [0, 2]: area = 2. Constant y = 1 on [0, 1]: area = 1.
  stopifnot(isTRUE(all.equal(AUC(c(0, 1, 2), c(0, 1, 2)), 2)))
  stopifnot(isTRUE(all.equal(AUC(c(0, 1), c(1, 1)), 1)))
})

run_test("CramerV on contingency tables", function() {
  perfect <- matrix(c(10, 0, 0, 10), nrow = 2)
  stopifnot(isTRUE(all.equal(CramerV(perfect), 1)))
  independent <- matrix(c(5, 5, 5, 5), nrow = 2)
  stopifnot(isTRUE(all.equal(CramerV(independent), 0)))
})

run_test("Recode relabels factor levels", function() {
  r <- Recode(factor(c("a", "b", "c")), lo = c("a", "b"), hi = "c")
  stopifnot(identical(as.character(r), c("lo", "lo", "hi")))
  stopifnot(identical(levels(r), c("lo", "hi")))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all DescTools smoke tests passed\n")
