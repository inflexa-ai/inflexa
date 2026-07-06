#!/usr/bin/env Rscript
# Smoke test for the R `ComplexUpset` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# ComplexUpset itself (it builds on ggplot2/patchwork, its core dependencies).
# Exercises the core API surface by INSPECTING the built plot object and the
# intersection data structure -- it never opens an interactive device -- and
# exits 0 only if every check passes, so it can be used as a pass/fail library
# validator:
#
#   Rscript ComplexUpset.R

if (!requireNamespace("ComplexUpset", quietly = TRUE)) {
  cat("FAIL: package 'ComplexUpset' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(ComplexUpset))
suppressPackageStartupMessages(library(ggplot2))
cat(sprintf("ComplexUpset version: %s\n", as.character(packageVersion("ComplexUpset"))))

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

membership_df <- function() {
  set.seed(7)
  n <- 20L
  data.frame(
    A = sample(c(TRUE, FALSE), n, replace = TRUE),
    B = sample(c(TRUE, FALSE), n, replace = TRUE),
    C = sample(c(TRUE, FALSE), n, replace = TRUE)
  )
}

run_test("upset builds a ggplot object", function() {
  df <- membership_df()
  plt <- ComplexUpset::upset(df, intersect = c("A", "B", "C"))
  # ComplexUpset composes its panels with patchwork, so the result is a ggplot.
  stopifnot(inherits(plt, "ggplot"))
})

run_test("upset_data returns the intersection structure", function() {
  df <- membership_df()
  ud <- ComplexUpset::upset_data(df, intersect = c("A", "B", "C"))
  stopifnot(is.list(ud), length(ud) > 0L)
  # The intersection membership matrix is carried on $with_sizes / $sizes.
  stopifnot(!is.null(ud$sizes) || !is.null(ud$with_sizes))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all ComplexUpset smoke tests passed\n")
