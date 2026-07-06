#!/usr/bin/env Rscript
# Smoke test for the R `rrvgo` (Bioconductor) package.
#
# Fully self-contained: no input files, NO network. rrvgo reduces redundancy in
# a set of GO terms by clustering a semantic-similarity matrix. Exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript rrvgo.R
#
# ============================ SCOPE & DATA DEPENDENCY ========================
# This test is DELIBERATELY MODEST -- function-existence + signature checks
# only -- because rrvgo's real workload CANNOT run offline here:
#
#   * calculateSimMatrix(x, orgdb, ont, ...) needs a GO semantic-similarity
#     database, which it builds from an OrgDb (e.g. org.Hs.eg.db) + GO.db via
#     GOSemSim::godata(). None of those annotation packages are assumed present.
#
#   * reduceSimMatrix(simMatrix, scores, threshold, orgdb, ...) REQUIRES an
#     `orgdb` argument even when `scores` are supplied -- it looks up per-term
#     annotation sizes through the OrgDb. So it too cannot run without GO.db +
#     an OrgDb, and is NOT invoked here.
#
# A full data-driven test therefore needs: GO.db, GOSemSim, and an OrgDb such as
# org.Hs.eg.db installed. Until then, these checks confirm the package loads and
# exposes its API with the expected argument names -- which is what proves an
# install is healthy. RE-CHECK the `orgdb`/`ont` formal names once installed.
# ============================================================================

if (!requireNamespace("rrvgo", quietly = TRUE)) {
  cat("FAIL: package 'rrvgo' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(rrvgo))
cat(sprintf("rrvgo version: %s\n", as.character(packageVersion("rrvgo"))))

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

run_test("calculateSimMatrix is exported and needs orgdb + ont", function() {
  stopifnot(is.function(rrvgo::calculateSimMatrix))
  fm <- names(formals(rrvgo::calculateSimMatrix))
  # its OrgDb + ontology args are why a full run cannot be offline here
  stopifnot("orgdb" %in% fm, "ont" %in% fm)
})

run_test("reduceSimMatrix is exported and requires orgdb", function() {
  stopifnot(is.function(rrvgo::reduceSimMatrix))
  fm <- names(formals(rrvgo::reduceSimMatrix))
  stopifnot("simMatrix" %in% fm, "scores" %in% fm, "orgdb" %in% fm)
})

run_test("visualization helpers are exported functions", function() {
  stopifnot(is.function(rrvgo::scatterPlot))
  stopifnot(is.function(rrvgo::treemapPlot))
  stopifnot(is.function(rrvgo::heatmapPlot))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all rrvgo smoke tests passed\n")
