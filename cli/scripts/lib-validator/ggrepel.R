#!/usr/bin/env Rscript
# Smoke test for the R `ggrepel` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# ggrepel and its hard dependency ggplot2. ggrepel adds repelling text/label
# geoms to ggplot2, so every check builds a plot object and inspects its
# structure -- no graphics device is ever opened. Exits 0 only if every check
# passes, so it can be used as a pass/fail library validator:
#
#   Rscript ggrepel.R
#
# Checks are STRUCTURAL (layer classes, required aesthetics, built layer data)
# rather than pixel/geometry assertions: the actual label repelling happens in
# the grid draw step at render time, which we deliberately never trigger.

if (!requireNamespace("ggrepel", quietly = TRUE)) {
  cat("FAIL: package 'ggrepel' is not installed\n")
  quit(save = "no", status = 1)
}

# ggplot2 is a hard dependency of ggrepel (Imports), so it is guaranteed to be
# present whenever ggrepel is; attach it for ggplot()/aes()/geom_point().
suppressPackageStartupMessages({
  library(ggrepel)
  library(ggplot2)
})
cat(sprintf("ggrepel version: %s\n", as.character(packageVersion("ggrepel"))))

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

# Shared fixture: a tiny labelled scatter. Deterministic, no randomness needed.
df <- data.frame(
  x = c(1, 2, 3, 4, 5),
  y = c(2, 1, 4, 3, 5),
  lab = c("alpha", "beta", "gamma", "delta", "epsilon")
)

run_test("geom_text_repel builds a repel layer", function() {
  p <- ggplot(df, aes(x = x, y = y)) +
    geom_point() +
    geom_text_repel(aes(label = lab))
  stopifnot(inherits(p, "ggplot"))
  stopifnot(length(p$layers) == 2L)
  # the second layer's geom is ggrepel's GeomTextRepel (subclass of GeomText)
  stopifnot(inherits(p$layers[[2]]$geom, "GeomTextRepel"))
})

run_test("geom_label_repel builds a repel layer", function() {
  p <- ggplot(df, aes(x = x, y = y)) +
    geom_label_repel(aes(label = lab))
  stopifnot(inherits(p, "ggplot"))
  stopifnot(length(p$layers) == 1L)
  stopifnot(inherits(p$layers[[1]]$geom, "GeomLabelRepel"))
})

run_test("repel geom requires a label aesthetic", function() {
  p <- ggplot(df, aes(x = x, y = y)) +
    geom_text_repel(aes(label = lab))
  # GeomTextRepel$required_aes == c("x", "y", "label")
  req <- p$layers[[1]]$geom$required_aes
  stopifnot(is.character(req))
  stopifnot(all(c("x", "y", "label") %in% req))
})

run_test("ggplot_build computes layer data without a device", function() {
  p <- ggplot(df, aes(x = x, y = y)) +
    geom_point() +
    geom_text_repel(aes(label = lab))
  b <- ggplot_build(p)
  # b$data is one built data.frame per layer, regardless of ggplot2 version
  stopifnot(is.list(b$data), length(b$data) == 2L)
  built <- b$data[[2]] # the repel layer
  stopifnot(is.data.frame(built))
  stopifnot(nrow(built) == nrow(df))
  # the label column survives the build; labels match the source data
  stopifnot("label" %in% names(built))
  stopifnot(setequal(as.character(built$label), df$lab))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all ggrepel smoke tests passed\n")
