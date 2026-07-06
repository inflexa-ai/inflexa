#!/usr/bin/env Rscript
# Smoke test for the R `plotly` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# plotly itself (plus its implied deps -- ggplot2 is one, used by ggplotly).
# Exercises the core API surface by INSPECTING the built plot structure -- it
# never opens a browser or interactive device -- and exits 0 only if every
# check passes, so it can be used as a pass/fail library validator:
#
#   Rscript plotly.R

if (!requireNamespace("plotly", quietly = TRUE)) {
  cat("FAIL: package 'plotly' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(plotly))
cat(sprintf("plotly version: %s\n", as.character(packageVersion("plotly"))))

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

run_test("build a plotly object", function() {
  p <- plotly::plot_ly(x = 1:3, y = c(2, 1, 3), type = "scatter", mode = "markers")
  stopifnot(inherits(p, "plotly"))
})

run_test("plotly_build roundtrips the data", function() {
  p <- plotly::plot_ly(x = 1:3, y = c(2, 1, 3), type = "scatter", mode = "markers")
  # plotly_build resolves the figure to its JSON-ish trace list without drawing.
  built <- plotly::plotly_build(p)
  stopifnot(length(built$x$data) >= 1L)
  trace <- built$x$data[[1]]
  stopifnot(identical(as.numeric(trace$x), c(1, 2, 3)))
  stopifnot(identical(as.numeric(trace$y), c(2, 1, 3)))
  stopifnot(identical(trace$type, "scatter"))
  stopifnot(identical(trace$mode, "markers"))
})

run_test("add_trace appends a second trace", function() {
  p <- plotly::plot_ly(x = 1:3, y = c(2, 1, 3), type = "scatter", mode = "markers")
  p <- plotly::add_trace(p, y = c(3, 2, 1), mode = "lines")
  built <- plotly::plotly_build(p)
  stopifnot(length(built$x$data) == 2L)
})

run_test("ggplotly converts a ggplot to plotly", function() {
  # ggplot2 is a plotly dependency; ggplotly is the bridge from a ggplot object.
  gg <- ggplot2::ggplot(mtcars, ggplot2::aes(mpg, wt)) + ggplot2::geom_point()
  pl <- plotly::ggplotly(gg)
  stopifnot(inherits(pl, "plotly"))
  built <- plotly::plotly_build(pl)
  stopifnot(length(built$x$data) >= 1L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all plotly smoke tests passed\n")
