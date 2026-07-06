#!/usr/bin/env Rscript
# Smoke test for the R `STACAS` package.
#
# Fully self-contained: no input files, no network. STACAS performs anchor-based
# integration of single-cell datasets (TILslope / semi-supervised) on Seurat
# objects -- Run.STACAS(object_list, ...) finds anchors, builds a sample tree,
# and integrates a LIST of >= 2 Seurat objects into one. That end-to-end path
# is OUT OF SCOPE offline: it needs multiple Seurat objects, and Seurat is not
# installed here. This test therefore stays deliberately MODEST -- it asserts
# the package loads and that its core exported entry points exist as functions.
# Checks are structural (function presence) only -- never numeric. Exits 0 only
# if every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript STACAS.R
#
# Install: remotes::install_github("carmonalab/STACAS")
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# UNVERIFIABLE WITHOUT AN INSTALL (STACAS and its Seurat dependency are both
# absent here) -- confirm every item below once STACAS is available:
#   - Run.STACAS() ARGUMENTS / PIPELINE. The assumed core call is
#     Run.STACAS(object_list = <list of >= 2 Seurat objects>, ...), returning an
#     integrated Seurat object. NOT exercised (needs Seurat objects); only
#     is.function(Run.STACAS) is checked. Re-confirm the argument names and the
#     FindAnchors.STACAS / SampleTree.STACAS / IntegrateData.STACAS staging once
#     installed.
#   - STANDARDIZATION HELPER NAME. This test asserts an exported gene-symbol
#     standardization helper named `StandardizeGeneSymbols`. If the installed
#     build names it differently, update the is.function() assertion below.
# ============================================================================

if (!requireNamespace("STACAS", quietly = TRUE)) {
  cat("FAIL: package 'STACAS' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(STACAS))
cat(sprintf("STACAS version: %s\n", as.character(packageVersion("STACAS"))))

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

run_test("core integration entry points are exported functions", function() {
  stopifnot(is.function(Run.STACAS))
  stopifnot(is.function(FindAnchors.STACAS))
})

run_test("anchor pipeline helpers are exported functions", function() {
  stopifnot(is.function(SampleTree.STACAS))
  stopifnot(is.function(IntegrateData.STACAS))
})

run_test("gene-symbol standardization helper is exported", function() {
  # Name unverified offline -- see the RE-CHECK note in the header block above.
  stopifnot(is.function(StandardizeGeneSymbols))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all STACAS smoke tests passed\n")
