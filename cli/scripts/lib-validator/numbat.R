#!/usr/bin/env Rscript
# Smoke test for the R `numbat` package.
#
# Fully self-contained and OFFLINE: no input files, no network. numbat calls
# haplotype-aware copy-number variations and reconstructs tumor phylogenies from
# single-cell data. Its full `run_numbat()` pipeline is deliberately NOT run: it
# REQUIRES allele counts (`df_allele`), reference expression profiles
# (`lambdas_ref`) and an external SNP phasing panel -- large inputs produced by
# an upstream preprocessing/phasing step -- plus it writes many output files.
# All of that is out of scope for an offline validator. Instead the test asserts
# the package loads and exposes its core surface: the `run_numbat()` entry
# point, the `Numbat` R6 class generator, and the get_bulk / aggregate_counts /
# run_bulk helpers; plus it builds (but does NOT analyze) a small synthetic gene
# x cell count matrix of the shape `count_mat` expects. Exits 0 only if every
# check passes, so it can be used as a pass/fail library validator:
#
#   Rscript numbat.R
#
# Install (GitHub-hosted):
#   remotes::install_github("kharchenkolab/numbat")
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# UNVERIFIABLE WITHOUT AN INSTALL -- numbat is NOT installed here, so confirm
# all of the following once a build is available:
#   - run_numbat() SIGNATURE. The formals check below asserts the documented
#     arguments (count_mat, lambdas_ref, df_allele, genome) are present. If a
#     version renames/removes any, update the check.
#   - `Numbat` R6 CLASS. Assumed to be an exported R6ClassGenerator with a
#     `$new()` constructor (the object wrapping a completed numbat result). If
#     numbat changes the class system or the export name, update the check.
#   - HELPER EXPORTS. get_bulk / aggregate_counts / run_bulk are checked SOFTLY
#     (a missing one only notes, never fails) because the exact helper names
#     drift between versions -- re-confirm the public helper set once installed.
#   - INPUT SHAPE. count_mat is a GENES x CELLS raw count matrix; the synthetic
#     matrix is built to that shape but is never passed to numbat.
# ============================================================================

if (!requireNamespace("numbat", quietly = TRUE)) {
  cat("FAIL: package 'numbat' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(numbat))
cat(sprintf("numbat version: %s\n", as.character(packageVersion("numbat"))))

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

# Synthetic gene x cell raw count matrix: 80 genes x 24 cells, integer Poisson
# draws with named rows/cols -- the shape numbat's `count_mat` expects (genes as
# rows, cells as columns). Built only for a cheap structural check; it is NEVER
# passed to run_numbat() (the full haplotype-aware pipeline needs allele +
# expression + phasing inputs and writes output files, out of scope offline --
# see the header note).
set.seed(42)
n_genes <- 80L
n_cells <- 24L
count_mat <- matrix(
  rpois(n_genes * n_cells, lambda = 4),
  nrow = n_genes, ncol = n_cells,
  dimnames = list(sprintf("GENE%03d", seq_len(n_genes)),
                  paste0("cell", seq_len(n_cells)))
)

run_test("run_numbat entry point is an exported function", function() {
  stopifnot(is.function(run_numbat))
})

run_test("run_numbat() exposes its documented arguments", function() {
  args <- names(formals(run_numbat))
  # Core documented arguments (see the SIGNATURE note in the header block).
  # Subset check: extra args in a newer version are fine; a rename is the case
  # the header flags for re-confirmation.
  expected <- c("count_mat", "lambdas_ref", "df_allele", "genome")
  stopifnot(all(expected %in% args))
})

run_test("Numbat R6 class generator is exported", function() {
  # numbat depends on R6; the result wrapper is an R6ClassGenerator whose
  # $new() constructs the object around a completed numbat run.
  stopifnot(inherits(Numbat, "R6ClassGenerator"))
  stopifnot(is.function(Numbat$new))
})

run_test("core bulk/aggregation helpers are exported", function() {
  exports <- getNamespaceExports("numbat")
  # Softly checked (see HELPER EXPORTS note): helper names drift between
  # versions, so a missing one only notes and must not false-fail a healthy
  # install. get0() returns NULL rather than erroring when a name is absent.
  for (fn in c("get_bulk", "aggregate_counts", "run_bulk")) {
    present <- fn %in% exports &&
      is.function(get0(fn, envir = asNamespace("numbat")))
    if (!present) {
      cat(sprintf(
        "  note numbat helper '%s' not exported (verify helper set once installed)\n",
        fn
      ))
    }
  }
})

run_test("synthetic count matrix has the numbat-expected shape", function() {
  # genes x cells, non-negative integer counts, named rows/cols -- what
  # `count_mat` needs. This never touches run_numbat(); it only guards the
  # construction above.
  stopifnot(is.matrix(count_mat))
  stopifnot(nrow(count_mat) == n_genes, ncol(count_mat) == n_cells)
  stopifnot(!is.null(rownames(count_mat)), !is.null(colnames(count_mat)))
  stopifnot(all(count_mat >= 0), all(count_mat == round(count_mat)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all numbat smoke tests passed\n")
