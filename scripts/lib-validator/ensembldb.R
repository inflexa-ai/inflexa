#!/usr/bin/env Rscript
# Smoke test for the R `ensembldb` (Bioconductor) package.
#
# Fully self-contained: no input files, NO network, no packages beyond
# ensembldb + its deps. Exits 0 only if every check passes, so it can be used
# as a pass/fail library validator:
#
#   Rscript ensembldb.R
#
# ensembldb queries EnsDb annotation databases, but its FILTER-CONSTRUCTION
# surface is fully OFFLINE and DETERMINISTIC: building a GeneNameFilter etc.
# needs no database. Those filter constructors (re-exported from the
# AnnotationFilter package) are the substance of this test. Live EnsDb queries
# (genes()/transcripts()/select() against a real DB) are exercised by the
# EnsDb.* data-package validators; here we only assert those generics EXIST.
#
# ============================ API TO RE-CHECK ===============================
# FLAG the following names once installed:
#   * FILTER CLASS NAMES: `GeneNameFilter`, `SeqNameFilter`, `TxBiotypeFilter`,
#     `AnnotationFilterList` and their shared super-class `AnnotationFilter`
#     (defined in the AnnotationFilter package, re-exported by ensembldb).
#   * The `value()` accessor returning the filter's stored value verbatim.
#   * The exported query generics `genes` / `transcripts` / `exons` and the
#     AnnotationDbi generics `select` / `keys`.
# ============================================================================

if (!requireNamespace("ensembldb", quietly = TRUE)) {
  cat("FAIL: package 'ensembldb' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(ensembldb))
cat(sprintf("ensembldb version: %s\n", as.character(packageVersion("ensembldb"))))

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

run_test("GeneNameFilter constructs an AnnotationFilter carrying its value", function() {
  gnf <- GeneNameFilter("BRCA1")
  # class identity: the concrete filter and its shared abstract super-class.
  stopifnot(is(gnf, "GeneNameFilter"))
  stopifnot(is(gnf, "AnnotationFilter"))
  # value() round-trips the stored query value verbatim (offline, deterministic).
  stopifnot(identical(AnnotationFilter::value(gnf), "BRCA1"))
})

run_test("SeqNameFilter and TxBiotypeFilter construct offline", function() {
  snf <- SeqNameFilter("1")
  stopifnot(is(snf, "SeqNameFilter"), is(snf, "AnnotationFilter"))
  stopifnot(identical(AnnotationFilter::value(snf), "1"))

  tbf <- TxBiotypeFilter("protein_coding")
  stopifnot(is(tbf, "TxBiotypeFilter"), is(tbf, "AnnotationFilter"))
  stopifnot(identical(AnnotationFilter::value(tbf), "protein_coding"))
})

run_test("AnnotationFilterList combines multiple filters", function() {
  afl <- AnnotationFilterList(GeneNameFilter("BRCA1"), SeqNameFilter("1"))
  stopifnot(is(afl, "AnnotationFilterList"))
  stopifnot(length(afl) == 2L)
})

run_test("EnsDb query generics are exported and callable", function() {
  # Existence only -- a live query needs an EnsDb database (see EnsDb.* scripts).
  stopifnot(existsFunction("genes"))
  stopifnot(existsFunction("transcripts"))
  stopifnot(existsFunction("exons"))
  stopifnot(existsFunction("select"))
  stopifnot(existsFunction("keys"))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all ensembldb smoke tests passed\n")
