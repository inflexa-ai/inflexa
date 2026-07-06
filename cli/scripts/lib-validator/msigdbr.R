#!/usr/bin/env Rscript
# Smoke test for the R `msigdbr` package.
#
# Fully self-contained: no input files, NO network. msigdbr is a DATA package
# that vendors the MSigDB gene sets locally. Exercises the gene-set retrieval
# API and exits 0 only if every check passes, so it can be used as a pass/fail
# library validator:
#
#   Rscript msigdbr.R
#
# ============================ API UNCERTAINTY ================================
# TWO things to RE-CHECK once installed:
#
# 1. ARG NAME: recent msigdbr (>= 10.0) RENAMED the collection argument from
#    `category` to `collection` (and `subcategory` -> `subcollection`). This
#    script auto-detects which name the installed version accepts via
#    formals(); if neither is present the API changed further -- investigate.
#
# 2. DATA COMPANION: msigdbr >= 10.0 moved the gene-set payload into a separate
#    `msigdbdf` package. If that companion is not installed, msigdbr() ERRORS
#    with an install hint at call time -- which would surface here as a test
#    FAILURE (not the not-installed guard). Older (7.x) msigdbr bundles the
#    data itself. Note this if test bodies fail once msigdbr is present.
# ============================================================================
#
# Gene-set contents are fixed, so checks are structural/known (column presence,
# the HALLMARK_ naming convention, a known hallmark set name).

if (!requireNamespace("msigdbr", quietly = TRUE)) {
  cat("FAIL: package 'msigdbr' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(msigdbr))
cat(sprintf("msigdbr version: %s\n", as.character(packageVersion("msigdbr"))))

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

# Fetch the Hallmark ("H") collection for human, tolerating either arg name.
fetch_hallmark <- function() {
  arg_names <- names(formals(msigdbr::msigdbr))
  if ("collection" %in% arg_names) {
    msigdbr::msigdbr(species = "Homo sapiens", collection = "H")
  } else if ("category" %in% arg_names) {
    # pre-10.0 API
    msigdbr::msigdbr(species = "Homo sapiens", category = "H")
  } else {
    stop("msigdbr() exposes neither a `collection` nor a `category` argument")
  }
}

run_test("hallmark collection retrieval yields gene-set rows", function() {
  gs <- fetch_hallmark()
  stopifnot(is.data.frame(gs), nrow(gs) > 0L)
  # gs_name and gene_symbol are stable across msigdbr versions
  stopifnot("gs_name" %in% names(gs))
  stopifnot("gene_symbol" %in% names(gs))
})

run_test("hallmark set names follow the HALLMARK_ convention", function() {
  gs <- fetch_hallmark()
  # every gene set in collection "H" is named HALLMARK_*
  stopifnot(all(grepl("^HALLMARK_", gs$gs_name)))
  # a specific, long-standing hallmark set is present
  stopifnot("HALLMARK_APOPTOSIS" %in% gs$gs_name)
  # the canonical hallmark collection has 50 sets; assert a robust lower bound
  # (exact 50 is expected but left loose in case MSigDB re-versions)
  stopifnot(length(unique(gs$gs_name)) >= 45L)
})

run_test("gene_symbol values are non-empty character strings", function() {
  gs <- fetch_hallmark()
  syms <- gs$gene_symbol
  stopifnot(is.character(syms))
  stopifnot(all(!is.na(syms)), all(nzchar(syms)))
})

run_test("msigdbr_species returns a species table including human", function() {
  sp <- msigdbr::msigdbr_species()
  stopifnot(is.data.frame(sp), nrow(sp) > 0L)
  # column names vary; scan every character column for the species name
  has_human <- any(vapply(sp, function(col) {
    is.character(col) && any(grepl("Homo sapiens", col, fixed = TRUE))
  }, logical(1)))
  stopifnot(has_human)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all msigdbr smoke tests passed\n")
