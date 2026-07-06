#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `KEGGREST` package.
#
# Fully self-contained: no input files, no network, no packages beyond KEGGREST
# itself.
#
# NOTE ON SCOPE: KEGGREST is a thin client for the KEGG REST web API — every
# data-returning function (keggGet, keggList, keggFind, ...) performs a live
# HTTP request to https://rest.kegg.jp. That network-dependent behavior is
# intentionally OUT OF SCOPE for an offline smoke test: an offline validator
# cannot and must not call it. This test therefore only verifies that the
# package loads and that its public query functions exist with the expected
# signatures. Exits 0 only if every check passes, so it can be used as a
# pass/fail library validator:
#
#   Rscript KEGGREST.R

if (!requireNamespace("KEGGREST", quietly = TRUE)) {
  cat("FAIL: package 'KEGGREST' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(KEGGREST))
cat(sprintf("KEGGREST version: %s\n", as.character(packageVersion("KEGGREST"))))

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

run_test("core REST query functions are exported", function() {
  stopifnot(is.function(KEGGREST::keggGet))
  stopifnot(is.function(KEGGREST::keggList))
  stopifnot(is.function(KEGGREST::keggFind))
  stopifnot(is.function(KEGGREST::keggConv))
  stopifnot(is.function(KEGGREST::keggLink))
})

run_test("info helper is exported", function() {
  stopifnot(is.function(KEGGREST::keggInfo))
})

run_test("keggGet has a dbentries argument", function() {
  stopifnot("dbentries" %in% names(formals(KEGGREST::keggGet)))
})

run_test("keggList has a database argument", function() {
  stopifnot("database" %in% names(formals(KEGGREST::keggList)))
})

run_test("keggConv/keggLink take target and source", function() {
  stopifnot(all(c("target", "source") %in% names(formals(KEGGREST::keggConv))))
  stopifnot(all(c("target", "source") %in% names(formals(KEGGREST::keggLink))))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all KEGGREST smoke tests passed\n")
