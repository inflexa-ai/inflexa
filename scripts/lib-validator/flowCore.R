#!/usr/bin/env Rscript
# Smoke test for the R `flowCore` package.
#
# Fully self-contained: no input files, NO network, no packages beyond flowCore
# itself (a Bioconductor package). All data is a small synthetic expression
# matrix built with a fixed seed and wrapped in flowCore's core data structures
# (flowFrame / flowSet); checks are structural (class, dimensions, marker names,
# matrix round-trip) plus a transform-changes-values check, never numeric
# equality on anything random. Exercises the core data-structure + transform API
# and exits 0 only if every check passes, so it can be used as a pass/fail
# library validator:
#
#   Rscript flowCore.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# The load-bearing assertions are STRUCTURAL and should hold on any healthy
# flowCore install. Points to re-confirm once a build is available:
#   - flowFrame(mat) constructs directly from a matrix with column dimnames
#     becoming the parameter (marker) names; nrow/ncol/colnames/exprs accessors
#     behave as asserted.
#   - flowSet(list(a=ff, b=ff2)) builds a 2-frame set; fsApply(fs, nrow) returns
#     one row-count per frame.
#   - arcsinhTransform()/logicleTransform() return transform functions that can
#     be applied via transform(ff, transformList(...)) and shift the values.
# ============================================================================

if (!requireNamespace("flowCore", quietly = TRUE)) {
  cat("FAIL: package 'flowCore' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(flowCore))
cat(sprintf("flowCore version: %s\n", as.character(packageVersion("flowCore"))))

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

# Synthetic expression: 1000 events x 5 markers, Gaussian around 5 (kept
# positive-ish so the arcsinh/logicle transforms are exercised on realistic
# cytometry-like intensities). Column names become the flowFrame parameters.
set.seed(1)
mat <- matrix(rnorm(1000 * 5, 5), ncol = 5, dimnames = list(NULL, paste0("M", 1:5)))

run_test("flowFrame builds from a matrix with correct shape + names", function() {
  ff <- flowFrame(mat)
  stopifnot(inherits(ff, "flowFrame"))
  stopifnot(nrow(ff) == 1000L, ncol(ff) == 5L)
  stopifnot(identical(colnames(ff), paste0("M", 1:5)))
})

run_test("exprs() round-trips the input matrix within storage precision", function() {
  ff <- flowFrame(mat)
  back <- exprs(ff)
  stopifnot(is.matrix(back), nrow(back) == 1000L, ncol(back) == 5L)
  # exprs() returns the channel names as a *named* character vector (the names
  # are the $Pn keyword ids), so compare unnamed.
  stopifnot(identical(unname(colnames(back)), colnames(mat)))
  # flowFrame stores intensities in single precision (FCS $DATATYPE F), so the
  # readback differs from the double-precision input by ~1e-7 — assert equality
  # within that storage tolerance, not bit-exact identity.
  stopifnot(isTRUE(all.equal(unname(back), unname(mat),
                             tolerance = 1e-4, check.attributes = FALSE)))
})

run_test("flowSet composes two frames and fsApply maps over them", function() {
  ff <- flowFrame(mat)
  # A second, distinct frame so the set genuinely holds two members.
  set.seed(2)
  mat2 <- matrix(rnorm(500 * 5, 5), ncol = 5, dimnames = list(NULL, paste0("M", 1:5)))
  ff2 <- flowFrame(mat2)
  fs <- flowSet(list(a = ff, b = ff2))
  stopifnot(inherits(fs, "flowSet"))
  stopifnot(length(fs) == 2L)
  # fsApply returns one value per frame; here the per-frame event counts.
  counts <- fsApply(fs, nrow)
  stopifnot(sort(as.integer(counts)) == c(500L, 1000L))
})

run_test("arcsinhTransform applies and changes the values", function() {
  ff <- flowFrame(mat)
  tf <- arcsinhTransform(transformationId = "asinh", a = 1, b = 1, c = 0)
  stopifnot(is.function(tf))
  tl <- transformList(colnames(ff), tf)
  ff_t <- transform(ff, tl)
  stopifnot(inherits(ff_t, "flowFrame"))
  after <- exprs(ff_t)
  stopifnot(nrow(after) == 1000L, ncol(after) == 5L)
  # The transform is monotone but nonlinear, so it must shift essentially every
  # value; require the columnwise means to differ appreciably from the input.
  stopifnot(all(abs(colMeans(after) - colMeans(mat)) > 1e-6))
})

run_test("logicleTransform applies and changes the values", function() {
  ff <- flowFrame(mat)
  lt <- logicleTransform()
  stopifnot(is.function(lt))
  tl <- transformList(colnames(ff), lt)
  ff_t <- transform(ff, tl)
  after <- exprs(ff_t)
  stopifnot(nrow(after) == 1000L, ncol(after) == 5L)
  stopifnot(all(abs(colMeans(after) - colMeans(mat)) > 1e-6))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all flowCore smoke tests passed\n")
