#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `xcms` package.
#
# Fully self-contained: no input files, NO network, no packages beyond xcms
# itself. xcms's real work -- LC-MS chromatographic peak detection -- needs raw
# mzML/CDF data (shipped via the faahKO / msdata companion packages, which are
# NOT assumed installed here), so this validator is deliberately MODEST: it
# confirms the package loads, its core detection functions and result classes
# exist, and the fully offline-constructible CentWaveParam builds and reports
# its parameters. Exits 0 only if every check passes:
#
#   Rscript xcms.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# xcms is NOT installed in this environment, so the bodies below are written
# correct-by-review and could NOT be executed. Re-confirm once a build exists:
#   - FLAG: the end-to-end LC-MS workflow (findChromPeaks on a real file, peak
#     grouping, retention-time alignment) is OUT OF SCOPE offline -- it requires
#     raw spectra. Only function/class existence + parameter-object shape here.
#   - CentWaveParam(ppm=, peakwidth=) constructs offline and its ppm()/peakwidth()
#     accessors report the supplied values (this is a genuine offline check).
#   - Result container: newer xcms uses XcmsExperiment, legacy uses XCMSnExp;
#     we accept EITHER being defined. xcmsSet is the legacy S4 entry point.
# ============================================================================

if (!requireNamespace("xcms", quietly = TRUE)) {
  cat("FAIL: package 'xcms' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(xcms))
cat(sprintf("xcms version: %s\n", as.character(packageVersion("xcms"))))

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

run_test("core peak-detection functions exist", function() {
  stopifnot(is.function(findChromPeaks))
  # Legacy S4 entry point, still exported for backwards compatibility.
  stopifnot(is.function(xcmsSet))
})

run_test("a result container class is defined", function() {
  # Newer xcms uses XcmsExperiment; XCMSnExp is the legacy on-disk container.
  # Depending on the installed version, at least one must be defined.
  defined <- vapply(
    c("XCMSnExp", "XcmsExperiment"),
    function(cl) !is.null(methods::getClassDef(cl)),
    logical(1)
  )
  stopifnot(any(defined))
})

run_test("CentWaveParam constructs offline and reports its parameters", function() {
  p <- CentWaveParam(ppm = 25, peakwidth = c(20, 50))
  stopifnot(inherits(p, "CentWaveParam"))
  stopifnot(ppm(p) == 25)
  stopifnot(identical(peakwidth(p), c(20, 50)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all xcms smoke tests passed\n")
