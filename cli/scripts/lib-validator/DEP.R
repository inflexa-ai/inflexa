#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `DEP` package.
#
# Fully self-contained: no input files, NO network, no packages beyond DEP itself
# (a proteomics differential-enrichment package built on SummarizedExperiment).
# All data is DEP's OWN bundled example -- the UbiLength proteinGroups table and
# its experimental design -- loaded via data(); no external files are read. The
# heavy end-to-end DE model (test_diff/add_rejections) is left to function
# existence, while the make_unique -> make_se construction (which yields a real
# SummarizedExperiment) is exercised. Exits 0 only if every check passes:
#
#   Rscript DEP.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# DEP is NOT installed in this environment, so the bodies below are written
# correct-by-review and could NOT be executed. Re-confirm once a build exists:
#   - data(UbiLength) loads a proteinGroups data.frame with "Protein.IDs" /
#     "Gene.names" columns and several "LFQ.intensity.*" quantitative columns;
#     data(UbiLength_ExpDesign) loads its label/condition/replicate design.
#   - FLAG (arg names): make_unique(df, names_col, ids_col, delim=";") then
#     make_se(unique_df, <LFQ column indices>, expdesign) returns a
#     SummarizedExperiment with one column per LFQ sample.
#   - FLAG: the actual DE test (test_diff) and thresholding (add_rejections) are
#     left as function-existence only -- their statistical output is NOT checked.
# ============================================================================

if (!requireNamespace("DEP", quietly = TRUE)) {
  cat("FAIL: package 'DEP' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(DEP))
cat(sprintf("DEP version: %s\n", as.character(packageVersion("DEP"))))

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

run_test("core workflow functions exist", function() {
  stopifnot(is.function(make_unique))
  stopifnot(is.function(make_se))
  stopifnot(is.function(make_se_parse))
  stopifnot(is.function(test_diff))
  stopifnot(is.function(add_rejections))
  stopifnot(is.function(plot_volcano))
})

run_test("bundled example data loads (UbiLength)", function() {
  data("UbiLength", package = "DEP", envir = environment())
  stopifnot(is.data.frame(UbiLength))
  stopifnot(all(c("Protein.IDs", "Gene.names") %in% colnames(UbiLength)))
  # The LFQ intensity columns are the quantitative payload the workflow consumes.
  stopifnot(length(grep("^LFQ\\.", colnames(UbiLength))) > 0L)
})

run_test("make_unique + make_se build a SummarizedExperiment", function() {
  data("UbiLength", package = "DEP", envir = environment())
  data("UbiLength_ExpDesign", package = "DEP", envir = environment())
  du <- make_unique(UbiLength, "Gene.names", "Protein.IDs", delim = ";")
  lfq <- grep("^LFQ\\.", colnames(du))
  stopifnot(length(lfq) > 0L)
  se <- make_se(du, lfq, UbiLength_ExpDesign)
  stopifnot(inherits(se, "SummarizedExperiment"))
  # One assay column per LFQ sample; features carried across.
  stopifnot(ncol(se) == length(lfq))
  stopifnot(nrow(se) > 0L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all DEP smoke tests passed\n")
