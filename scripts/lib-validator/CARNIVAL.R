#!/usr/bin/env Rscript
# Smoke test for the R `CARNIVAL` package (CAusal Reasoning for Network
# identification via Integer VALue programming).
#
# Fully self-contained: no input files, no network, no packages beyond CARNIVAL
# and a bundled ILP solver. CARNIVAL solves an integer linear program to infer
# signed causal networks, so a genuine run needs an ILP backend; the free,
# always-available fallback is lpSolve (vs. commercial cbc/CPLEX/Gurobi). This
# test stays deliberately MODEST -- it verifies the package loads, its entry
# point is callable, and the lpSolve fallback solver is present -- rather than
# blind-driving a full ILP optimisation. Exits 0 only if every check passes, so
# it can be used as a pass/fail library validator:
#
#   Rscript CARNIVAL.R
#
# FLAG (unverified on this machine -- CARNIVAL is NOT installed here, heavily
# flagged): the entry-point name runCARNIVAL, the lpSolve solver option, and
# the result-list field names (weightedSIF / nodesAttributes) are taken from
# the documented CARNIVAL API and MUST be re-checked against the installed
# version -- CARNIVAL's solver interface changed noticeably between v1 and v2.

if (!requireNamespace("CARNIVAL", quietly = TRUE)) {
  cat("FAIL: package 'CARNIVAL' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(CARNIVAL))
cat(sprintf("CARNIVAL version: %s\n", as.character(packageVersion("CARNIVAL"))))

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

run_test("core entry point runCARNIVAL is exported and callable", function() {
  stopifnot(exists("runCARNIVAL"))
  stopifnot(is.function(runCARNIVAL))
})

run_test("runCARNIVAL exposes a solver option", function() {
  # The solver is selected by a formal argument; assert it exists so a caller
  # can request the free lpSolve backend explicitly.
  fmls <- names(formals(runCARNIVAL))
  stopifnot("solver" %in% fmls || "solverPath" %in% fmls || "carnivalOptions" %in% fmls)
})

run_test("lpSolve fallback ILP solver is available", function() {
  # lpSolve is the free, no-license fallback backend CARNIVAL falls back to
  # when no commercial solver (CPLEX / cbc / Gurobi) is configured.
  stopifnot(requireNamespace("lpSolve", quietly = TRUE))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all CARNIVAL smoke tests passed\n")
