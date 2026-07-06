#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `CAMERA` package.
#
# Fully self-contained: no input files, NO network, no packages beyond CAMERA
# itself. CAMERA annotates xcms peak-detection results (isotopes, adducts, pseudo
# -spectra), so its real work needs an upstream xcmsSet / XCMSnExp -- itself
# derived from raw LC-MS files -- which is OUT OF SCOPE offline. This validator
# is therefore deliberately MODEST: it confirms the package loads, its annotation
# container class is defined, and its core annotation functions exist. Exits 0
# only if every check passes:
#
#   Rscript CAMERA.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# CAMERA is NOT installed in this environment, so the bodies below are written
# correct-by-review and could NOT be executed. Re-confirm once a build exists:
#   - FLAG: real annotation (groupFWHM/groupCorr/findIsotopes/findAdducts run on
#     an xsAnnotate built from an xcmsSet) is OUT OF SCOPE offline -- it needs an
#     xcms result. Only class + function existence is asserted here.
#   - getClass("xsAnnotate") is defined; the annotation functions are exported
#     under the names asserted below.
# ============================================================================

if (!requireNamespace("CAMERA", quietly = TRUE)) {
  cat("FAIL: package 'CAMERA' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(CAMERA))
cat(sprintf("CAMERA version: %s\n", as.character(packageVersion("CAMERA"))))

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

run_test("annotation container class is defined", function() {
  stopifnot(!is.null(methods::getClassDef("xsAnnotate")))
})

run_test("core annotation functions exist", function() {
  stopifnot(is.function(annotate))
  stopifnot(is.function(groupFWHM))
  stopifnot(is.function(groupCorr))
  stopifnot(is.function(findIsotopes))
  stopifnot(is.function(findAdducts))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all CAMERA smoke tests passed\n")
