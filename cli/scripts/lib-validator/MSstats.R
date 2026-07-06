#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `MSstats` package.
#
# Fully self-contained: no input files, NO network, no packages beyond MSstats
# itself (a proteomics statistical package for label-based / label-free MS). All
# data is MSstats's OWN bundled example (SRMRawData) loaded via data(); no
# external files are read. The full quantification pipeline (dataProcess ->
# groupComparison) is HEAVY (fits per-protein models) and its output shape has
# drifted across versions, so it is left to function existence while the bundled
# input table's structure is verified. Exits 0 only if every check passes:
#
#   Rscript MSstats.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# MSstats is NOT installed in this environment, so the bodies below are written
# correct-by-review and could NOT be executed. Re-confirm once a build exists:
#   - data(SRMRawData) loads a long-format data.frame with the MSstats columns
#     asserted below (ProteinName, PeptideSequence, Condition, BioReplicate,
#     Run, Intensity, ...).
#   - FLAG (output shape): dataProcess(SRMRawData) is NOT run here. Its result is
#     a list whose component names changed across versions -- newer MSstats emits
#     ProteinLevelData / FeatureLevelData, older emits RunlevelData. Re-verify
#     the exact component names before asserting on them.
#   - FLAG (contrast form): groupComparison(contrast.matrix, quant) needs a
#     contrast matrix whose columns match the conditions and returns a
#     $ComparisonResult table (log2FC / pvalue / adj.pvalue). Not exercised here.
# ============================================================================

if (!requireNamespace("MSstats", quietly = TRUE)) {
  cat("FAIL: package 'MSstats' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(MSstats))
cat(sprintf("MSstats version: %s\n", as.character(packageVersion("MSstats"))))

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

run_test("core quantification / comparison functions exist", function() {
  stopifnot(is.function(dataProcess))
  stopifnot(is.function(groupComparison))
  stopifnot(is.function(dataProcessPlots))
  stopifnot(is.function(groupComparisonPlots))
})

run_test("bundled SRM example data loads with MSstats columns", function() {
  data("SRMRawData", package = "MSstats", envir = environment())
  stopifnot(is.data.frame(SRMRawData))
  need <- c("ProteinName", "PeptideSequence", "Condition", "BioReplicate", "Run", "Intensity")
  stopifnot(all(need %in% colnames(SRMRawData)))
  stopifnot(nrow(SRMRawData) > 0L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all MSstats smoke tests passed\n")
