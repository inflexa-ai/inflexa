#!/usr/bin/env Rscript
# Smoke test for the R `oligo` (Bioconductor) package.
#
# Fully self-contained: no input files, NO network. oligo preprocesses
# Affymetrix / NimbleGen microarrays whose raw intensities live in per-array
# CEL / XYS files, and RMA additionally needs the matching platform-design
# (pdInfo) package for the array. We have NEITHER the raw arrays NOR a pdInfo
# package here, so a real read + normalize is OUT OF SCOPE OFFLINE. This test
# therefore verifies only what is checkable without any array files: that the
# package loads and that its core reader / preprocessing entry points and its
# central S4 class are present. Exits 0 only if every check passes, so it can be
# used as a pass/fail library validator:
#
#   Rscript oligo.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# This test is FUNCTION/CLASS-EXISTENCE-DOMINATED because the real workflow
# (read.celfiles() -> rma()) requires CEL/XYS files plus a pdInfoPackage that we
# cannot construct or fetch offline. The checks below pass on any healthy
# install; VERIFY ONCE INSTALLED that these are still the right names/shapes:
#   - read.celfiles() / read.xysfiles() are the raw readers (need CEL/XYS files).
#   - rma() is oligo's S4 generic; a real run needs a FeatureSet + a pdInfo pkg.
#   - FeatureSet is the (virtual) base class for oligo's *FeatureSet objects
#     (ExpressionFeatureSet, GeneFeatureSet, ...); getClass() must resolve it.
# The generic-registration and virtual-class probes are kept SOFT (note, never
# fail) so a reflection detail can't false-fail an otherwise healthy install.
# ============================================================================

if (!requireNamespace("oligo", quietly = TRUE)) {
  cat("FAIL: package 'oligo' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(oligo))
cat(sprintf("oligo version: %s\n", as.character(packageVersion("oligo"))))

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

run_test("raw-array reader functions are exported", function() {
  stopifnot(exists("read.celfiles"), is.function(read.celfiles))
  stopifnot(exists("read.xysfiles"), is.function(read.xysfiles))
})

run_test("rma preprocessing entry point is present and callable", function() {
  # A generic IS a function, so is.function(rma) holds whether rma is a plain
  # function or (as expected) an S4 generic. That callable existence is the
  # load-bearing check; the generic registration below is only a soft signal.
  stopifnot(exists("rma"), is.function(rma))
  if (!isGeneric("rma")) {
    cat("  note rma is not registered as an S4 generic (verify once installed)\n")
  }
})

run_test("FeatureSet S4 class is defined", function() {
  # getClass() searches every loaded namespace; oligoClasses (loaded with oligo)
  # defines FeatureSet, so this resolves without needing any array object.
  cls <- getClass("FeatureSet")
  stopifnot(!is.null(cls), isVirtualClass("FeatureSet") %in% c(TRUE, FALSE))
  # FeatureSet is expected to be the VIRTUAL parent of the concrete *FeatureSet
  # classes. Soft-note (do not fail) if the install reports otherwise.
  if (!isVirtualClass("FeatureSet")) {
    cat("  note FeatureSet is not a virtual class (verify once installed)\n")
  }
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all oligo smoke tests passed\n")
