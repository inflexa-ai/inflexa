#!/usr/bin/env Rscript
# Smoke test for the R `affy` (Bioconductor) package.
#
# Fully self-contained: no input files, NO network. affy reads Affymetrix
# 3'-IVT arrays from per-array CEL files and needs the matching chip-definition
# (CDF) environment package to map probes to probesets. We have NEITHER the raw
# CEL files NOR a CDF package here, so a real ReadAffy() -> rma() is OUT OF SCOPE
# OFFLINE. This test therefore verifies only what is checkable without any array
# files: that the package loads and that its core reader / preprocessing entry
# points and central S4 classes are present. Exits 0 only if every check passes,
# so it can be used as a pass/fail library validator:
#
#   Rscript affy.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# This test is FUNCTION/CLASS-EXISTENCE-DOMINATED because the real workflow needs
# CEL files plus a CDF environment package that we cannot construct or fetch
# offline. Constructing a bare AffyBatch is deliberately NOT attempted: a valid
# object still points at a cdfName whose CDF env must be resolvable for any
# downstream method, so class existence + FLAG is the honest offline check. The
# assertions below pass on any healthy install; VERIFY ONCE INSTALLED:
#   - ReadAffy() is the CEL reader; rma()/expresso()/justRMA() are the summarizers
#     (all need CEL files + a CDF env package).
#   - AffyBatch is a concrete (non-virtual) class extending Biobase's eSet.
#   - ProbeSet is affy's per-probeset PM/MM container class.
# ============================================================================

if (!requireNamespace("affy", quietly = TRUE)) {
  cat("FAIL: package 'affy' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(affy))
cat(sprintf("affy version: %s\n", as.character(packageVersion("affy"))))

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

run_test("core reader / preprocessing functions are exported", function() {
  stopifnot(exists("ReadAffy"), is.function(ReadAffy))
  stopifnot(exists("rma"), is.function(rma))
  stopifnot(exists("expresso"), is.function(expresso))
})

run_test("justRMA one-shot entry point is present", function() {
  stopifnot(exists("justRMA"), is.function(justRMA))
})

run_test("AffyBatch S4 class is defined and non-virtual", function() {
  cls <- getClass("AffyBatch")
  stopifnot(!is.null(cls))
  # AffyBatch is instantiable (holds CEL intensities); it must not be virtual.
  stopifnot(!isVirtualClass("AffyBatch"))
})

run_test("AffyBatch extends Biobase eSet", function() {
  # Structural inheritance is fixed by the class definition, so it is safe to
  # assert hard (no array data needed): AffyBatch -> eSet -> VersionedBiobase.
  stopifnot(extends("AffyBatch", "eSet"))
})

run_test("ProbeSet S4 class is defined", function() {
  stopifnot(!is.null(getClass("ProbeSet")))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all affy smoke tests passed\n")
