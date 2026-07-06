#!/usr/bin/env Rscript
# Smoke test for the R `org.Dr.eg.db` package.
#
# Fully self-contained: no input files, NO network. org.Dr.eg.db is an OrgDb
# annotation DATA package that vendors a zebrafish gene-annotation SQLite
# database locally; once installed every query below runs fully OFFLINE.
# Exercises the AnnotationDbi query API against the bundled DB and exits 0 only
# if every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript org.Dr.eg.db.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# The load-bearing assertions are STRUCTURAL (columns/keytypes present, keys
# nonempty) and the SYMBOL->ENTREZID->SYMBOL round-trip (a self-consistency
# check that needs no hardcoded id). These pass on any healthy install.
#
# No Entrez id is hardcoded here -- the round-trip alone proves DB integrity.
# VERIFY ONCE INSTALLED:
#   - zebrafish gene symbols are lowercase; "tp53" is present in the DB.
#   - organism string expected "Danio rerio".
# ============================================================================

if (!requireNamespace("org.Dr.eg.db", quietly = TRUE)) {
  cat("FAIL: package 'org.Dr.eg.db' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(org.Dr.eg.db))
cat(sprintf("org.Dr.eg.db version: %s\n", as.character(packageVersion("org.Dr.eg.db"))))

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

# The OrgDb object is exported under the same name as the package.
gene <- "tp53"
organism <- "Danio rerio"

run_test("OrgDb object is exported and well-typed", function() {
  orgdb <- org.Dr.eg.db
  stopifnot(inherits(orgdb, "OrgDb"))
})

run_test("columns and keytypes expose the core annotation fields", function() {
  orgdb <- org.Dr.eg.db
  cols <- AnnotationDbi::columns(orgdb)
  stopifnot(all(c("SYMBOL", "ENTREZID", "ENSEMBL") %in% cols))
  kts <- AnnotationDbi::keytypes(orgdb)
  stopifnot(all(c("SYMBOL", "ENTREZID") %in% kts))
})

run_test("keys(keytype=SYMBOL) returns a nonempty character vector", function() {
  orgdb <- org.Dr.eg.db
  ks <- AnnotationDbi::keys(orgdb, keytype = "SYMBOL")
  stopifnot(is.character(ks), length(ks) > 0L)
})

run_test("SYMBOL -> ENTREZID -> SYMBOL round-trips (DB integrity)", function() {
  orgdb <- org.Dr.eg.db
  id <- suppressMessages(AnnotationDbi::mapIds(
    orgdb, keys = gene, column = "ENTREZID", keytype = "SYMBOL"))
  stopifnot(is.character(id), length(id) == 1L, !is.na(id), grepl("^[0-9]+$", id))
  sym <- suppressMessages(AnnotationDbi::mapIds(
    orgdb, keys = id, column = "SYMBOL", keytype = "ENTREZID"))
  stopifnot(is.character(sym), length(sym) == 1L, !is.na(sym), identical(unname(sym), gene))
})

run_test("select() returns a data.frame with requested columns and rows", function() {
  orgdb <- org.Dr.eg.db
  df <- suppressMessages(AnnotationDbi::select(
    orgdb, keys = gene, keytype = "SYMBOL", columns = c("ENTREZID", "ENSEMBL")))
  stopifnot(is.data.frame(df), nrow(df) >= 1L)
  stopifnot(all(c("ENTREZID", "ENSEMBL") %in% names(df)))
})

run_test("species metadata matches the organism", function() {
  orgdb <- org.Dr.eg.db
  sp <- AnnotationDbi::species(orgdb)
  stopifnot(identical(sp, organism))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all org.Dr.eg.db smoke tests passed\n")
