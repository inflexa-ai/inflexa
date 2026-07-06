#!/usr/bin/env Rscript
# Smoke test for the R `babelgene` package.
#
# Fully self-contained: no input files, NO network. babelgene is a DATA
# package -- it ships pre-computed human<->model-organism ortholog tables, so
# every lookup is deterministic and offline. Exercises the ortholog-mapping
# API and exits 0 only if every check passes, so it can be used as a pass/fail
# library validator:
#
#   Rscript babelgene.R
#
# Because the bundled data is fixed, checks are structural/exact (column
# presence, row counts, a known TP53 -> Trp53 mapping).
#
# API TO RE-CHECK ONCE INSTALLED: the exact orthologs() output column names.
# This asserts `human_symbol` (the queried human gene) and `symbol` (the model
# organism ortholog). If those names differ in the installed version, update
# the column assertions below.

if (!requireNamespace("babelgene", quietly = TRUE)) {
  cat("FAIL: package 'babelgene' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(babelgene))
cat(sprintf("babelgene version: %s\n", as.character(packageVersion("babelgene"))))

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

run_test("orthologs maps human genes to mouse orthologs", function() {
  # human = TRUE: the input genes are HUMAN symbols; `symbol` holds the mouse
  # ortholog. TP53 -> Trp53 and BRCA1 -> Brca1 are stable, canonical mappings.
  res <- babelgene::orthologs(genes = c("TP53", "BRCA1"),
                              species = "mouse", human = TRUE)
  stopifnot(is.data.frame(res), nrow(res) > 0L)
  stopifnot("human_symbol" %in% names(res))
  stopifnot("symbol" %in% names(res))
  # every returned human_symbol comes from the query set
  stopifnot(all(res$human_symbol %in% c("TP53", "BRCA1")))
  # TP53's mouse ortholog symbol is Trp53
  tp53_rows <- res[res$human_symbol == "TP53", , drop = FALSE]
  stopifnot(nrow(tp53_rows) > 0L)
  stopifnot("Trp53" %in% tp53_rows$symbol)
})

run_test("orthologs recovers the BRCA1 -> Brca1 mapping", function() {
  res <- babelgene::orthologs(genes = "BRCA1", species = "mouse", human = TRUE)
  stopifnot(is.data.frame(res), nrow(res) > 0L)
  stopifnot(all(res$human_symbol == "BRCA1"))
  stopifnot("Brca1" %in% res$symbol)
})

run_test("species() returns the supported-species table", function() {
  sp <- babelgene::species()
  stopifnot(is.data.frame(sp), nrow(sp) > 0L)
  # mouse must be listed. Column names vary across versions, so scan every
  # character column for the scientific name rather than assuming a column.
  has_mouse <- any(vapply(sp, function(col) {
    is.character(col) && any(grepl("musculus", col, ignore.case = TRUE))
  }, logical(1)))
  stopifnot(has_mouse)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all babelgene smoke tests passed\n")
