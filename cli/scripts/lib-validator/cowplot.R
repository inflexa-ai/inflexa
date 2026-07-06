#!/usr/bin/env Rscript
# Smoke test for the R `cowplot` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# cowplot itself (ggplot2 is its core dependency, used to build the panels).
# Exercises the core API surface by INSPECTING the composed grid/theme objects
# -- it never opens an interactive device -- and exits 0 only if every check
# passes, so it can be used as a pass/fail library validator:
#
#   Rscript cowplot.R

if (!requireNamespace("cowplot", quietly = TRUE)) {
  cat("FAIL: package 'cowplot' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(cowplot))
suppressPackageStartupMessages(library(ggplot2))
cat(sprintf("cowplot version: %s\n", as.character(packageVersion("cowplot"))))

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

run_test("plot_grid returns a ggplot/gg object", function() {
  p1 <- ggplot(mtcars, aes(mpg, wt)) + geom_point()
  p2 <- ggplot(mtcars, aes(hp, qsec)) + geom_point()
  g <- plot_grid(p1, p2, ncol = 2)
  # cowplot draws its grid onto a ggdraw canvas, so the result is a ggplot.
  stopifnot(inherits(g, "gg"))
  stopifnot(inherits(g, "ggplot"))
})

run_test("theme_cowplot is a ggplot theme", function() {
  th <- theme_cowplot()
  stopifnot(inherits(th, "theme"))
  stopifnot(inherits(th, "gg"))
})

run_test("get_legend extracts a legend grob", function() {
  p <- ggplot(mtcars, aes(mpg, wt, colour = factor(cyl))) + geom_point()
  leg <- get_legend(p)
  # The legend comes back as a grid grob/gtable, not NULL.
  stopifnot(!is.null(leg))
  stopifnot(inherits(leg, "gtable") || inherits(leg, "grob"))
})

run_test("ggdraw yields a drawable ggplot canvas", function() {
  canvas <- ggdraw()
  stopifnot(inherits(canvas, "ggplot"))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all cowplot smoke tests passed\n")
