#!/usr/bin/env Rscript
# Smoke test for the R `AnnotationHub` (Bioconductor) package.
#
# Fully self-contained: no input files, no packages beyond AnnotationHub + its
# deps. Exits 0 only if every check passes, so it can be used as a pass/fail
# library validator:
#
#   Rscript AnnotationHub.R
#
# ============================ NETWORK / SCOPE ================================
# AnnotationHub's PRIMARY function -- discovering and downloading annotation
# resources -- is NETWORK-DEPENDENT: constructing a live hub with
# AnnotationHub() contacts the Bioconductor hub server (and caches downloads).
# Those hub queries are OUT OF SCOPE for an offline smoke test and are NOT
# exercised here. This test only validates the OFFLINE surface: that the
# package loads and its core constructor / query generic / metadata accessor
# are present as callable functions.
# ============================================================================

if (!requireNamespace("AnnotationHub", quietly = TRUE)) {
  cat("FAIL: package 'AnnotationHub' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(AnnotationHub))
cat(sprintf("AnnotationHub version: %s\n", as.character(packageVersion("AnnotationHub"))))

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

run_test("AnnotationHub constructor is an exported function", function() {
  # NOTE: only checks the constructor EXISTS -- calling AnnotationHub() would
  # contact the network, which is deliberately out of scope here.
  stopifnot(is.function(AnnotationHub::AnnotationHub))
})

run_test("query generic for searching a hub is exported", function() {
  # query() filters an in-memory hub by keywords; the generic itself is offline.
  stopifnot(is.function(AnnotationHub::query))
})

run_test("hub resource metadata is accessed via S4Vectors::mcols", function() {
  # Hub metadata (title, species, provider, ...) is surfaced as mcols() on hub
  # objects. S4Vectors is a hard dependency of AnnotationHub, so it is present.
  stopifnot(requireNamespace("S4Vectors", quietly = TRUE))
  stopifnot(is.function(S4Vectors::mcols))
})

run_test("hub configuration is readable via getAnnotationHubOption", function() {
  # getAnnotationHubOption() reads local option state only (no network); we
  # assert the accessor exists rather than depending on any configured value.
  stopifnot(is.function(AnnotationHub::getAnnotationHubOption))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all AnnotationHub smoke tests passed\n")
