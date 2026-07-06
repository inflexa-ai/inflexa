#!/usr/bin/env Rscript
# Smoke test for the R `ontologyIndex` package.
#
# Fully self-contained: no input files, NO network. ontologyIndex ships small
# example ontologies as package data, so every check runs offline against
# bundled objects. Exercises the ontology-traversal API and exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript ontologyIndex.R
#
# ============================ API UNCERTAINTY ================================
# RE-CHECK once installed:
#
# 1. DATASET NAME: this uses the bundled `hpo` example ontology (ontologyIndex
#    ships `hpo` and `go`). If data("hpo") is unavailable, adjust to the actual
#    bundled dataset name.
#
# 2. VALIDATION FN: the consistency checker is called `check_ontology` in some
#    versions and `check` in others -- this auto-detects whichever the
#    namespace exports. If neither exists the API changed; investigate.
#
# 3. TERM IDS: rather than hardcoding term accessions, tests pick ids FROM the
#    loaded ontology (roots, hpo$id[10]). One optional check uses HP:0000118
#    only IF present. So the checks hold regardless of the bundled HPO release.
# ============================================================================
#
# The bundled ontology is fixed, so checks are structural (class, field
# presence, ancestor/descendant closure containing the query term).

if (!requireNamespace("ontologyIndex", quietly = TRUE)) {
  cat("FAIL: package 'ontologyIndex' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(ontologyIndex))
cat(sprintf("ontologyIndex version: %s\n",
            as.character(packageVersion("ontologyIndex"))))

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

# Shared ontology, populated by the first test and reused by the rest.
onto <- NULL

run_test("bundled hpo example is a valid ontology_index", function() {
  # load into this closure's environment, not the global env
  data("hpo", package = "ontologyIndex", envir = environment())
  stopifnot(exists("hpo"))
  stopifnot(inherits(hpo, "ontology_index"))
  # an ontology_index carries these core fields
  stopifnot(all(c("id", "name", "parents", "children", "ancestors") %in% names(hpo)))
  stopifnot(length(hpo$id) > 0L)
  onto <<- hpo
})

run_test("get_ancestors returns a closure containing the term itself", function() {
  stopifnot(!is.null(onto))
  # pick a real term from the ontology rather than hardcoding an accession
  term <- onto$id[[10]]
  anc <- ontologyIndex::get_ancestors(onto, term)
  stopifnot(is.character(anc), length(anc) >= 1L)
  # a term is its own ancestor in ontologyIndex's closure convention
  stopifnot(term %in% anc)
})

run_test("get_descendants from a root spans many terms", function() {
  stopifnot(!is.null(onto))
  # a root has no parents; its descendant closure covers a large subtree
  root_ids <- onto$id[vapply(onto$parents, length, integer(1)) == 0L]
  stopifnot(length(root_ids) >= 1L)
  root <- root_ids[[1]]
  desc <- ontologyIndex::get_descendants(onto, roots = root)
  stopifnot(is.character(desc))
  stopifnot(root %in% desc)
  stopifnot(length(desc) > 1L)
})

run_test("optional HP:0000118 ancestor closure (if present)", function() {
  stopifnot(!is.null(onto))
  # "Phenotypic abnormality" -- assert only when the bundled release has it
  if ("HP:0000118" %in% onto$id) {
    anc <- ontologyIndex::get_ancestors(onto, "HP:0000118")
    stopifnot("HP:0000118" %in% anc)
  }
})

run_test("consistency checker validates the ontology", function() {
  stopifnot(!is.null(onto))
  ns <- asNamespace("ontologyIndex")
  checker <- if (exists("check_ontology", envir = ns, inherits = FALSE)) {
    get("check_ontology", envir = ns)
  } else if (exists("check", envir = ns, inherits = FALSE)) {
    get("check", envir = ns)
  } else {
    stop("no `check_ontology`/`check` function found in ontologyIndex")
  }
  # a consistent ontology returns cleanly; an inconsistent one errors
  checker(onto)
  invisible(TRUE)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all ontologyIndex smoke tests passed\n")
