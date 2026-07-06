#!/usr/bin/env Rscript
# Smoke test for the R `biomaRt` (Bioconductor) package.
#
# Fully self-contained: no input files, no packages beyond biomaRt + its deps.
# Exits 0 only if every check passes, so it can be used as a pass/fail library
# validator:
#
#   Rscript biomaRt.R
#
# ============================ NETWORK / SCOPE ================================
# biomaRt's PRIMARY function -- querying Ensembl BioMart -- is
# NETWORK-DEPENDENT: useMart()/useEnsembl() open a connection to a BioMart web
# service and getBM()/getLDS() issue live queries over HTTP. Those BioMart
# queries are OUT OF SCOPE for an offline smoke test and are NOT exercised
# here. This test only validates the OFFLINE surface: that the package loads
# and its core connection / query functions are present as callable functions.
# ============================================================================

if (!requireNamespace("biomaRt", quietly = TRUE)) {
  cat("FAIL: package 'biomaRt' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(biomaRt))
cat(sprintf("biomaRt version: %s\n", as.character(packageVersion("biomaRt"))))

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

run_test("mart-connection functions are exported", function() {
  # NOTE: existence only -- calling any of these contacts a BioMart server,
  # which is deliberately out of scope for this offline test.
  stopifnot(is.function(biomaRt::useMart))
  stopifnot(is.function(biomaRt::useEnsembl))
  stopifnot(is.function(biomaRt::listMarts))
})

run_test("query functions are exported", function() {
  # getBM() retrieves attributes from a mart; getLDS() links two datasets --
  # both issue live network queries, so we only assert they exist.
  stopifnot(is.function(biomaRt::getBM))
  stopifnot(is.function(biomaRt::getLDS))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all biomaRt smoke tests passed\n")
