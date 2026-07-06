#!/usr/bin/env Rscript
# Smoke test for the R `xCell2` package (cell-type enrichment / deconvolution;
# the successor to xCell).
#
# Install: remotes::install_github("AlmogAngel/xCell2")
#
# Fully self-contained: no input files, no network, no packages beyond xCell2
# itself. This test is DELIBERATELY MODEST. xCell2's core analysis entry point,
# xCell2Analysis(mix, xcell2object = ...), requires a TRAINED reference object
# produced by xCell2Train() over a real reference expression matrix with
# realistic gene symbols and a matching cell-type label table -- none of which
# can be constructed cheaply offline. So this script only verifies that the
# package LOADS and that its core API surface is exported and callable
# (is.function on the analysis + train entry points, plus a non-empty formals
# sanity check). It never runs an actual enrichment. Exits 0 only if every
# check passes, so it can be used as a pass/fail library validator:
#
#   Rscript xCell2.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# HEAVILY UNVERIFIABLE WITHOUT AN INSTALL -- confirm all of the following once
# xCell2 is available. This test intentionally does NOT exercise them:
#   - THE ANALYSIS PATH IS NOT TESTED. xCell2Analysis() needs a trained
#     `xcell2object` (built by xCell2Train) AND a mixture expression matrix whose
#     rownames are realistic human gene SYMBOLS overlapping the reference's
#     signature genes. Random/synthetic symbols will not enrich, and training a
#     reference offline requires a bundled reference dataset. Both are out of
#     scope here -- re-run a real xCell2Train() -> xCell2Analysis() end-to-end
#     once installed.
#   - FUNCTION NAMES / EXPORTS. Assumes the exported API is `xCell2Analysis`
#     (the analysis entry point) and `xCell2Train` (the reference builder). If
#     the package renames or splits these, the is.function guards below fail --
#     re-confirm the exported symbol names against the installed NAMESPACE.
#   - ARG NAMES (NOT ASSERTED HERE). The documented arg spelling is
#     xCell2Analysis(mix, xcell2object = ...) and xCell2Train(ref, labels, ...);
#     this script only checks that formals() is non-empty, NOT the exact names,
#     because they are version-dependent. Re-verify the argument names.
#   - ADDITIONAL EXPORTS. xCell2 may export further helpers (e.g. a lineage
#     resolver such as xCell2GetLineage); these are NOT asserted here to avoid
#     false failures, but are worth exercising once installed.
# ============================================================================

if (!requireNamespace("xCell2", quietly = TRUE)) {
  cat("FAIL: package 'xCell2' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(xCell2))
cat(sprintf("xCell2 version: %s\n", as.character(packageVersion("xCell2"))))

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

run_test("xCell2Analysis is an exported function", function() {
  stopifnot(exists("xCell2Analysis"))
  stopifnot(is.function(xCell2Analysis))
})

run_test("xCell2Train (reference builder) is an exported function", function() {
  stopifnot(exists("xCell2Train"))
  stopifnot(is.function(xCell2Train))
})

run_test("core functions accept arguments (non-empty formals)", function() {
  # Only a shape check -- the exact arg NAMES are version-dependent and are
  # deliberately not asserted here (see the ASSUMPTIONS block above). Any real
  # analysis/train function takes at least one argument.
  stopifnot(length(formals(args(xCell2Analysis))) >= 1L)
  stopifnot(length(formals(args(xCell2Train))) >= 1L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all xCell2 smoke tests passed\n")
