#!/usr/bin/env Rscript
# Smoke test for the R `ggplot2` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# ggplot2 itself (plus its implied deps). Exercises the core API surface by
# INSPECTING plot objects and their computed layer data -- it never opens an
# interactive device -- and exits 0 only if every check passes, so it can be
# used as a pass/fail library validator:
#
#   Rscript ggplot2.R

if (!requireNamespace("ggplot2", quietly = TRUE)) {
  cat("FAIL: package 'ggplot2' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(ggplot2))
cat(sprintf("ggplot2 version: %s\n", as.character(packageVersion("ggplot2"))))

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

run_test("build a plot object", function() {
  p <- ggplot(mtcars, aes(mpg, wt)) + geom_point()
  stopifnot(inherits(p, "ggplot"))
  stopifnot(length(p$layers) == 1L)
})

run_test("computed point-layer data", function() {
  p <- ggplot(mtcars, aes(mpg, wt)) + geom_point()
  # ggplot_build / layer_data expose the COMPUTED aesthetics without rendering.
  ld <- layer_data(p, 1)
  stopifnot(is.data.frame(ld), nrow(ld) == nrow(mtcars))
  stopifnot(all(c("x", "y") %in% names(ld)))
  stopifnot(all(is.finite(ld$x)), all(is.finite(ld$y)))
  stopifnot(identical(ld$x, mtcars$mpg), identical(ld$y, mtcars$wt))
})

run_test("default labels resolve from aes mapping", function() {
  p <- ggplot(mtcars, aes(mpg, wt)) + geom_point()
  # In ggplot2 4.x the default (mapping-derived) labels are resolved lazily:
  # p$labels$x is NULL until set explicitly, so use get_labs() to read them.
  labs_resolved <- get_labs(p)
  stopifnot(identical(labs_resolved$x, "mpg"))
  stopifnot(identical(labs_resolved$y, "wt"))
})

run_test("labs() roundtrip sets explicit labels", function() {
  p <- ggplot(mtcars, aes(mpg, wt)) + geom_point() +
    labs(x = "Miles per gallon", y = "Weight")
  stopifnot(identical(p$labels$x, "Miles per gallon"))
  stopifnot(identical(p$labels$y, "Weight"))
})

run_test("stat_smooth computes a fitted line", function() {
  p <- ggplot(mtcars, aes(mpg, wt)) + geom_point() +
    stat_smooth(method = "lm", formula = y ~ x, se = FALSE)
  smooth <- layer_data(p, 2)
  stopifnot(is.data.frame(smooth), nrow(smooth) > 0L)
  stopifnot(all(c("x", "y") %in% names(smooth)))
  stopifnot(all(is.finite(smooth$x)), all(is.finite(smooth$y)))
  # A negative mpg~wt slope: the fitted y at min x exceeds y at max x.
  stopifnot(smooth$y[which.min(smooth$x)] > smooth$y[which.max(smooth$x)])
})

run_test("geom_histogram bins the data", function() {
  p <- ggplot(mtcars, aes(mpg)) + geom_histogram(bins = 10)
  hist <- layer_data(p, 1)
  stopifnot(all(c("count", "x", "xmin", "xmax") %in% names(hist)))
  stopifnot(all(is.finite(hist$count)))
  # Every observation lands in exactly one bin.
  stopifnot(sum(hist$count) == nrow(mtcars))
})

run_test("scale_color_manual maps discrete colours", function() {
  p <- ggplot(mtcars, aes(mpg, wt, colour = factor(cyl))) + geom_point() +
    scale_color_manual(values = c("4" = "red", "6" = "green", "8" = "blue"))
  ld <- layer_data(p, 1)
  stopifnot("colour" %in% names(ld))
  stopifnot(setequal(unique(ld$colour), c("red", "green", "blue")))
})

run_test("aesthetic mapping is captured", function() {
  p <- ggplot(mtcars, aes(mpg, wt)) + geom_point()
  stopifnot(all(c("x", "y") %in% names(p$mapping)))
})

run_test("render to a null pdf device", function() {
  # Prefer object inspection above; this exercises the full render path once,
  # writing to a throwaway pdf so no interactive device is needed.
  p <- ggplot(mtcars, aes(mpg, wt)) + geom_point()
  path <- tempfile("ggplot-smoke-", fileext = ".pdf")
  grDevices::pdf(path)
  on.exit({ grDevices::dev.off(); unlink(path) }, add = TRUE)
  print(p)
  stopifnot(file.exists(path))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all ggplot2 smoke tests passed\n")
