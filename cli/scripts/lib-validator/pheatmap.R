#!/usr/bin/env Rscript
# Smoke test for the R `pheatmap` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# pheatmap itself (plus its implied deps). Exercises the core API surface by
# INSPECTING the returned gtable/clustering objects -- `silent = TRUE` returns
# the layout WITHOUT drawing -- and exits 0 only if every check passes, so it
# can be used as a pass/fail library validator:
#
#   Rscript pheatmap.R

if (!requireNamespace("pheatmap", quietly = TRUE)) {
  cat("FAIL: package 'pheatmap' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(pheatmap))
cat(sprintf("pheatmap version: %s\n", as.character(packageVersion("pheatmap"))))

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

run_test("silent build returns a gtable + dendrograms", function() {
  set.seed(1)
  m <- matrix(rnorm(25), 5, 5)
  # silent = TRUE builds the grid layout but does NOT draw to a device.
  res <- pheatmap::pheatmap(m, silent = TRUE)
  stopifnot(!is.null(res$tree_row), !is.null(res$tree_col), !is.null(res$gtable))
  stopifnot(inherits(res$gtable, "gtable"))
})

run_test("row clustering is an hclust with 5 leaves", function() {
  set.seed(1)
  m <- matrix(rnorm(25), 5, 5)
  res <- pheatmap::pheatmap(m, silent = TRUE)
  stopifnot(inherits(res$tree_row, "hclust"))
  stopifnot(length(res$tree_row$order) == 5L)
  stopifnot(inherits(res$tree_col, "hclust"))
  stopifnot(length(res$tree_col$order) == 5L)
})

run_test("clustering can be disabled", function() {
  set.seed(1)
  m <- matrix(rnorm(25), 5, 5)
  res <- pheatmap::pheatmap(m, cluster_rows = FALSE, cluster_cols = FALSE,
                            silent = TRUE)
  # With clustering off the trees are absent but the gtable is still produced.
  stopifnot(inherits(res$gtable, "gtable"))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all pheatmap smoke tests passed\n")
