#!/usr/bin/env Rscript
# Smoke test for the R `ProjecTILs` package.
#
# Fully self-contained: no input files, no network. ProjecTILs projects a query
# single-cell dataset onto a curated reference atlas of T-cell states --
# Run.ProjecTILs(query, ref = ...) embeds a Seurat query into a reference map,
# and ProjecTILs.classifier(query, ref = ...) labels cells against it. That
# end-to-end path is OUT OF SCOPE offline: it needs a reference atlas (normally
# fetched by load.reference.map(), which DOWNLOADS the map) plus a Seurat query,
# and Seurat is not installed here. This test therefore stays deliberately
# MODEST -- it asserts the package loads and that its core exported entry points
# exist as functions. Checks are structural (function presence) only -- never
# numeric. Exits 0 only if every check passes, so it can be used as a pass/fail
# library validator:
#
#   Rscript ProjecTILs.R
#
# Install: remotes::install_github("carmonalab/ProjecTILs")
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# UNVERIFIABLE WITHOUT AN INSTALL (ProjecTILs and its Seurat dependency are both
# absent here) -- confirm every item below once ProjecTILs is available:
#   - REFERENCE-ATLAS DEPENDENCY. Run.ProjecTILs() / ProjecTILs.classifier()
#     both require a reference map object (ref = ...). A real reference is
#     normally obtained via load.reference.map(), which DOWNLOADS the atlas --
#     out of scope for an offline validator, so projection/classification are
#     NOT exercised; only is.function(...) is checked on the entry points.
#   - Run.ProjecTILs() / ProjecTILs.classifier() ARGUMENTS. Assumed calls are
#     Run.ProjecTILs(query = <Seurat obj>, ref = <reference map>) and
#     ProjecTILs.classifier(query = <Seurat obj>, ref = <reference map>).
#     Re-confirm the argument names and return shapes once installed.
#   - make.reference() builds a custom reference from a Seurat object; existence
#     is checked, but it is NOT called (needs a Seurat object).
#   - load.reference.map() is deliberately NOT called (it downloads a reference).
# ============================================================================

if (!requireNamespace("ProjecTILs", quietly = TRUE)) {
  cat("FAIL: package 'ProjecTILs' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(ProjecTILs))
cat(sprintf("ProjecTILs version: %s\n", as.character(packageVersion("ProjecTILs"))))

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

run_test("core projection entry points are exported functions", function() {
  stopifnot(is.function(Run.ProjecTILs))
  stopifnot(is.function(ProjecTILs.classifier))
})

run_test("reference construction helper is an exported function", function() {
  stopifnot(is.function(make.reference))
})

run_test("reference loader is exported (not invoked -- it downloads the atlas)", function() {
  # Existence only; load.reference.map() would hit the network, so it is never
  # called (see the RE-CHECK note in the header block above).
  stopifnot(is.function(load.reference.map))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all ProjecTILs smoke tests passed\n")
