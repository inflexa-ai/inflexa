#!/usr/bin/env Rscript
# Smoke test for the R `AnnotationDbi` (Bioconductor) package.
#
# Fully self-contained: no input files, no network, no packages beyond
# AnnotationDbi + its deps. Exits 0 only if every check passes, so it can be
# used as a pass/fail library validator:
#
#   Rscript AnnotationDbi.R
#
# ============================ SCOPE =========================================
# AnnotationDbi is an INTERFACE package: it defines the SQLite-backed
# annotation query API (select/keys/columns/keytypes/mapIds) but ships NO
# annotation database of its own. A real select()/mapIds() query needs a
# concrete AnnotationDbi object -- e.g. an org.*.eg.db package -- so the
# END-TO-END behaviour of these generics is exercised in the org.*.eg.db
# validator scripts (which carry an actual SQLite DB), NOT here.
#
# This test validates the OFFLINE, data-free surface: that the core mapping
# GENERICS are present and registered as S4 generics.
# ============================================================================

if (!requireNamespace("AnnotationDbi", quietly = TRUE)) {
  cat("FAIL: package 'AnnotationDbi' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(AnnotationDbi))
cat(sprintf("AnnotationDbi version: %s\n", as.character(packageVersion("AnnotationDbi"))))

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

run_test("core mapping functions are exported by AnnotationDbi", function() {
  # These five are the public annotation query surface. `::` resolves the
  # exported generic function objects directly.
  stopifnot(is.function(AnnotationDbi::select))
  stopifnot(is.function(AnnotationDbi::keys))
  stopifnot(is.function(AnnotationDbi::columns))
  stopifnot(is.function(AnnotationDbi::keytypes))
  stopifnot(is.function(AnnotationDbi::mapIds))
})

run_test("mapping functions are registered as S4 generics", function() {
  # Each is an S4 generic dispatching on the annotation object; after
  # library(AnnotationDbi) they are visible on the search path.
  stopifnot(isGeneric("select"))
  stopifnot(isGeneric("keys"))
  stopifnot(isGeneric("columns"))
  stopifnot(isGeneric("keytypes"))
  stopifnot(isGeneric("mapIds"))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all AnnotationDbi smoke tests passed\n")
