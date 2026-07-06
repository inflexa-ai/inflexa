#!/usr/bin/env Rscript
# Smoke test for the R `corrplot` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# corrplot itself (plus its implied deps). corrplot always draws, so every
# call is routed to a throwaway pdf null device (opened on a tempfile, closed
# and unlinked on exit) -- no interactive device is ever opened. Exits 0 only
# if every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript corrplot.R

if (!requireNamespace("corrplot", quietly = TRUE)) {
  cat("FAIL: package 'corrplot' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(corrplot))
cat(sprintf("corrplot version: %s\n", as.character(packageVersion("corrplot"))))

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

run_test("corrplot returns the reordered correlation matrix", function() {
  set.seed(42)
  M <- cor(matrix(rnorm(100), 20, 5))
  path <- tempfile("corrplot-smoke-", fileext = ".pdf")
  grDevices::pdf(path)
  on.exit({ grDevices::dev.off(); unlink(path) }, add = TRUE)
  res <- corrplot::corrplot(M)
  # Older corrplot returns the (reordered) matrix; newer versions wrap it in a
  # list with a $corr element -- accept either so the check tracks the API.
  cm <- if (is.matrix(res)) res else res$corr
  stopifnot(is.matrix(cm), nrow(cm) == 5L, ncol(cm) == 5L)
  stopifnot(all(abs(diag(cm) - 1) < 1e-8))
})

run_test("corrplot.mixed runs on the null device", function() {
  set.seed(42)
  M <- cor(matrix(rnorm(100), 20, 5))
  path <- tempfile("corrplot-mixed-", fileext = ".pdf")
  grDevices::pdf(path)
  on.exit({ grDevices::dev.off(); unlink(path) }, add = TRUE)
  res <- corrplot::corrplot.mixed(M)
  cm <- if (is.matrix(res)) res else res$corr
  stopifnot(is.matrix(cm), nrow(cm) == 5L, ncol(cm) == 5L)
})

run_test("hclust reordering runs on the null device", function() {
  set.seed(42)
  M <- cor(matrix(rnorm(100), 20, 5))
  path <- tempfile("corrplot-order-", fileext = ".pdf")
  grDevices::pdf(path)
  on.exit({ grDevices::dev.off(); unlink(path) }, add = TRUE)
  res <- corrplot::corrplot(M, order = "hclust")
  cm <- if (is.matrix(res)) res else res$corr
  stopifnot(is.matrix(cm), nrow(cm) == 5L, ncol(cm) == 5L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all corrplot smoke tests passed\n")
