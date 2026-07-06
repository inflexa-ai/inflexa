#!/usr/bin/env Rscript
# Smoke test for the R `ComplexHeatmap` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# ComplexHeatmap and its implied deps. All data is a small synthetic Gaussian
# matrix built with a fixed seed; checks are structural (object class of the
# BUILT heatmap / annotation / list) rather than numeric-equality on anything
# random. Crucially it exercises only heatmap CONSTRUCTION -- building a Heatmap
# stores its layout parameters and does NOT draw to a graphics device, so no
# device is opened (draw() is never called). Exits 0 only if every check passes,
# so it can be used as a pass/fail library validator:
#
#   Rscript ComplexHeatmap.R
#
# NOTE (needs re-check once installed): ComplexHeatmap objects are S4; the class
# checks use inherits() on the concrete classes Heatmap / HeatmapAnnotation /
# HeatmapList. draw()/rendering is intentionally NOT exercised (it requires a
# live graphics device) -- re-confirm these class names once a build is
# available.

if (!requireNamespace("ComplexHeatmap", quietly = TRUE)) {
  cat("FAIL: package 'ComplexHeatmap' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(ComplexHeatmap))
cat(sprintf("ComplexHeatmap version: %s\n", as.character(packageVersion("ComplexHeatmap"))))

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

# Synthetic matrix: 10 x 10, i.i.d. normal.
set.seed(1)
m <- matrix(rnorm(100), nrow = 10, ncol = 10)

run_test("Heatmap() builds a Heatmap object without drawing", function() {
  ht <- suppressWarnings(suppressMessages(Heatmap(m)))
  stopifnot(inherits(ht, "Heatmap"))
})

run_test("HeatmapAnnotation() builds an annotation object", function() {
  anno <- suppressWarnings(suppressMessages(HeatmapAnnotation(foo = 1:10)))
  stopifnot(inherits(anno, "HeatmapAnnotation"))
})

run_test("Heatmap + Heatmap composes into a HeatmapList", function() {
  hl <- suppressWarnings(suppressMessages(Heatmap(m) + Heatmap(m)))
  stopifnot(inherits(hl, "HeatmapList"))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all ComplexHeatmap smoke tests passed\n")
