#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `MSstatsTMT` package.
#
# Fully self-contained: no input files, NO network, no packages beyond MSstatsTMT
# itself (TMT-labelled proteomics statistics, built on MSstats). All data is the
# package's OWN bundled example loaded via data(); no external files are read.
# The full TMT pipeline (converter -> proteinSummarization -> groupComparisonTMT)
# is HEAVY and input-format sensitive, so this validator is deliberately MODEST:
# it confirms the package loads, its core functions exist, and a bundled example
# input table loads with a sane shape. Exits 0 only if every check passes:
#
#   Rscript MSstatsTMT.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# MSstatsTMT is NOT installed in this environment, so the bodies below are
# written correct-by-review and could NOT be executed. Re-confirm once a build
# exists:
#   - FLAG (converter / input format): the real workflow starts from a
#     search-engine export run through a converter such as PDtoMSstatsTMTFormat
#     (Proteome Discoverer) / MaxQtoMSstatsTMTFormat. Converter arg names and the
#     required raw/annotation columns are NOT exercised here.
#   - FLAG (example object name): the bundled MSstats-TMT-format table is loaded
#     as data(input.pd). Re-verify the exact dataset name and its columns
#     (ProteinName, PeptideSequence, Channel, Run, Mixture, Condition,
#     BioReplicate, Intensity, ...) against the installed version.
#   - proteinSummarization() and groupComparisonTMT() are asserted by existence
#     only; their summarization / comparison output is NOT checked offline.
# ============================================================================

if (!requireNamespace("MSstatsTMT", quietly = TRUE)) {
  cat("FAIL: package 'MSstatsTMT' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(MSstatsTMT))
cat(sprintf("MSstatsTMT version: %s\n", as.character(packageVersion("MSstatsTMT"))))

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

run_test("core TMT functions exist", function() {
  stopifnot(is.function(proteinSummarization))
  stopifnot(is.function(groupComparisonTMT))
  # A search-engine converter into MSstatsTMT format.
  stopifnot(is.function(PDtoMSstatsTMTFormat))
})

run_test("bundled PD example input loads", function() {
  data("input.pd", package = "MSstatsTMT", envir = environment())
  stopifnot(is.data.frame(input.pd))
  stopifnot(nrow(input.pd) > 0L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all MSstatsTMT smoke tests passed\n")
