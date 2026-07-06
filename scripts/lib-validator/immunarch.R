#!/usr/bin/env Rscript
# Smoke test for the R `immunarch` package (immune repertoire / AIRR analysis).
#
# NOTE: immunarch is an R package (repo immunomind/immunarch), NOT a Python
# package. Despite appearing in a Python dependency list it has no PyPI
# distribution (the Python analogue is scirpy), so this validator is written as
# an R smoke test — like data.table.R — to exercise the REAL package.
#
# Install: install.packages("immunarch")  OR  remotes::install_github("immunomind/immunarch")
#
# Fully self-contained: no input files, no network. immunarch ships an example
# immune-repertoire dataset via data(immdata); this test loads it and exercises
# the core repertoire-statistics API. Exits 0 only if every check passes, so it
# can be used as a pass/fail library validator:
#
#   Rscript immunarch.R
#
# ============================ ASSUMPTIONS TO RE-CHECK =======================
# UNVERIFIABLE WITHOUT AN INSTALL — confirm the following once immunarch is
# available:
#   - immdata STRUCTURE. Assumed immdata$data is a NAMED LIST of per-sample
#     repertoire data.frames and immdata$meta is a metadata data.frame (one row
#     per sample). Re-confirm if the checks below fail.
#   - FUNCTION NAMES / METHOD STRINGS. Assumed repExplore(.data, "volume"),
#     repDiversity(.data, "chao1"), and repClonality(.data, "homeo") — each
#     taking the list of repertoires as the first arg and a method string as the
#     second, and returning a data.frame / immunr_* object with >= 1 row.
#     Re-confirm the method spellings ("volume"/"chao1"/"homeo") against the
#     installed help.
# ============================================================================

if (!requireNamespace("immunarch", quietly = TRUE)) {
  cat("FAIL: package 'immunarch' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(immunarch))
cat(sprintf("immunarch version: %s\n", as.character(packageVersion("immunarch"))))

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

run_test("bundled immdata loads with $data (list of data.frames) and $meta", function() {
  data(immdata)
  stopifnot(exists("immdata"))
  stopifnot(is.list(immdata$data), length(immdata$data) > 0L)
  stopifnot(all(vapply(immdata$data, is.data.frame, logical(1L))))
  stopifnot(is.data.frame(immdata$meta))
  stopifnot(nrow(immdata$meta) >= 1L)
})

run_test("repExplore volume returns a data.frame", function() {
  data(immdata)
  vol <- repExplore(immdata$data, "volume")
  stopifnot(is.data.frame(vol))
  stopifnot(nrow(vol) >= 1L)
})

run_test("repDiversity chao1", function() {
  data(immdata)
  div <- repDiversity(immdata$data, "chao1")
  stopifnot(!is.null(div))
  stopifnot(NROW(div) >= 1L)
})

run_test("repClonality homeo", function() {
  data(immdata)
  clon <- repClonality(immdata$data, "homeo")
  stopifnot(!is.null(clon))
  stopifnot(NROW(clon) >= 1L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all immunarch smoke tests passed\n")
