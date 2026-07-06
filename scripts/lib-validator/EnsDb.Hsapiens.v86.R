#!/usr/bin/env Rscript
# Smoke test for the R `EnsDb.Hsapiens.v86` (Bioconductor) data package.
#
# Fully self-contained: no input files, NO network. EnsDb.Hsapiens.v86 is a
# DATA package -- it ships the Ensembl v86 human annotation as a local SQLite
# database, so every query is deterministic and offline once installed. It
# attaches ensembldb (a Depends) which supplies the query API. Exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript EnsDb.Hsapiens.v86.R
#
# ============================ API TO RE-CHECK ===============================
# FLAG the following once installed:
#   * KEYTYPE NAME: this looks up genes by name using keytype "GENENAME"
#     (EnsDb also exposes "SYMBOL"). The script auto-selects whichever the
#     installed db advertises via keytypes(), but CONFIRM the intended one.
#   * organism(edb) is asserted to be exactly "Homo sapiens".
#   * HARD-CODED ENSEMBL ID: BRCA1 is asserted to resolve to gene id
#     "ENSG00000012048". This is the well-known BRCA1 Ensembl gene id, but it
#     is a specific literal -- RE-CHECK it. The shape check (^ENSG[0-9]+$) is
#     the robust primary assertion; the exact id is the secondary one.
# ============================================================================

if (!requireNamespace("EnsDb.Hsapiens.v86", quietly = TRUE)) {
  cat("FAIL: package 'EnsDb.Hsapiens.v86' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(EnsDb.Hsapiens.v86))
cat(sprintf("EnsDb.Hsapiens.v86 version: %s\n", as.character(packageVersion("EnsDb.Hsapiens.v86"))))

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

# The package exports an EnsDb object bound to its own name.
edb <- EnsDb.Hsapiens.v86

run_test("package object is an EnsDb", function() {
  stopifnot(is(edb, "EnsDb"))
})

run_test("organism is Homo sapiens", function() {
  stopifnot(identical(organism(edb), "Homo sapiens"))
})

run_test("genes() returns a non-empty GRanges", function() {
  g <- genes(edb)
  stopifnot(is(g, "GRanges"))
  stopifnot(length(g) > 0L)
})

run_test("BRCA1 resolves to an Ensembl gene id via select()", function() {
  # Pick the gene-name keytype the installed db advertises (GENENAME preferred,
  # SYMBOL as a fallback) -- see API TO RE-CHECK note in the header.
  kt <- keytypes(edb)
  gene_kt <- if ("GENENAME" %in% kt) {
    "GENENAME"
  } else if ("SYMBOL" %in% kt) {
    "SYMBOL"
  } else {
    stop("EnsDb exposes neither a GENENAME nor a SYMBOL keytype")
  }
  res <- select(edb, keys = "BRCA1", keytype = gene_kt, columns = c("GENEID"))
  stopifnot(is.data.frame(res), nrow(res) > 0L)
  stopifnot("GENEID" %in% colnames(res))
  ids <- res$GENEID
  # ROBUST primary assertion: at least one non-empty ENSG-shaped id.
  stopifnot(any(grepl("^ENSG[0-9]+$", ids)))
  # SECONDARY assertion: the specific, well-known BRCA1 gene id (FLAGGED above).
  stopifnot("ENSG00000012048" %in% ids)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all EnsDb.Hsapiens.v86 smoke tests passed\n")
