#!/usr/bin/env Rscript
# Smoke test for the R `patchwork` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# patchwork itself (ggplot2 is its core dependency, used to build the panels).
# Exercises the core API surface by INSPECTING the composed plot objects -- it
# never opens an interactive device -- and exits 0 only if every check passes,
# so it can be used as a pass/fail library validator:
#
#   Rscript patchwork.R

if (!requireNamespace("patchwork", quietly = TRUE)) {
  cat("FAIL: package 'patchwork' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(patchwork))
suppressPackageStartupMessages(library(ggplot2))
cat(sprintf("patchwork version: %s\n", as.character(packageVersion("patchwork"))))

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

make_plots <- function() {
  list(
    p1 = ggplot(mtcars, aes(mpg, wt)) + geom_point(),
    p2 = ggplot(mtcars, aes(hp, qsec)) + geom_point()
  )
}

run_test("side-by-side (|) composes a patchwork", function() {
  pl <- make_plots()
  combined <- pl$p1 | pl$p2
  stopifnot(inherits(combined, "patchwork"))
  # A patchwork is still a ggplot -- it can be treated as one downstream.
  stopifnot(inherits(combined, "ggplot"))
})

run_test("addition (+) composes a patchwork", function() {
  pl <- make_plots()
  combined <- pl$p1 + pl$p2
  stopifnot(inherits(combined, "patchwork"))
  stopifnot(length(combined$patches$plots) == 1L)
})

run_test("plot_layout returns a patchwork", function() {
  pl <- make_plots()
  combined <- (pl$p1 + pl$p2) + plot_layout(ncol = 1)
  stopifnot(inherits(combined, "patchwork"))
})

run_test("plot_annotation returns a patchwork", function() {
  pl <- make_plots()
  combined <- (pl$p1 | pl$p2) + plot_annotation(title = "smoke test")
  stopifnot(inherits(combined, "patchwork"))
})

run_test("stacking (/) composes a patchwork", function() {
  pl <- make_plots()
  stacked <- pl$p1 / pl$p2
  stopifnot(inherits(stacked, "patchwork"))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all patchwork smoke tests passed\n")
