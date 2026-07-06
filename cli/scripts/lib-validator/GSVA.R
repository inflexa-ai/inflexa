#!/usr/bin/env Rscript
# Smoke test for the R `GSVA` (Bioconductor) package.
#
# Fully self-contained: no input files, NO network. GSVA scores gene-set
# activity per sample from an expression matrix; this test SIMULATES a small
# expression matrix plus a user-supplied named list of gene sets, so nothing
# reaches an online annotation source. Exits 0 only if every check passes, so
# it can be used as a pass/fail library validator:
#
#   Rscript GSVA.R
#
# ============================ API UNCERTAINTY ================================
# RE-CHECK once installed -- the GSVA entry-point API changed at 1.50:
#
#   * CURRENT (GSVA >= 1.50): a PARAM-OBJECT API. You build a parameter object
#       par <- gsvaParam(exprData, geneSets)   # (also ssgseaParam / plageParam)
#     and then call the generic
#       es  <- gsva(par)
#     This script is written for that API.
#
#   * LEGACY (GSVA < 1.50): gsva() was called directly on the data --
#       es <- gsva(exprData, geneSets, method = "gsva")
#     If the installed version predates 1.50, `gsvaParam` will be missing and
#     the first test errors; switch to the legacy signature above.
#
# Also verify: the S4 class name is assumed to be "gsvaParam", and gsva() on a
# plain matrix is assumed to RETURN a plain matrix (rows = gene sets, cols =
# samples). Both hold for current GSVA; re-check if the shape assertions fail.
# ============================================================================

if (!requireNamespace("GSVA", quietly = TRUE)) {
  cat("FAIL: package 'GSVA' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(GSVA))
cat(sprintf("GSVA version: %s\n", as.character(packageVersion("GSVA"))))

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

# Deterministic synthetic inputs: a 100-gene x 6-sample expression matrix with
# rownames "g1".."g100" and a named list of three gene sets over those genes.
set.seed(42)
n_genes <- 100L
n_samples <- 6L
gene_ids <- paste0("g", seq_len(n_genes))
sample_ids <- paste0("s", seq_len(n_samples))
expr <- matrix(
  rnorm(n_genes * n_samples),
  nrow = n_genes,
  ncol = n_samples,
  dimnames = list(gene_ids, sample_ids)
)
gene_sets <- list(
  setA = gene_ids[1:20],
  setB = gene_ids[30:50],
  setC = gene_ids[60:80]
)

run_test("gsvaParam constructs a parameter object (>= 1.50 API)", function() {
  par <- GSVA::gsvaParam(expr, gene_sets)
  # S4 param object; class name assumed "gsvaParam" (see API UNCERTAINTY).
  stopifnot(methods::is(par, "gsvaParam"))
})

run_test("gsva(param) returns a (nsets x nsamples) matrix", function() {
  par <- GSVA::gsvaParam(expr, gene_sets)
  es <- suppressWarnings(suppressMessages(GSVA::gsva(par)))
  stopifnot(is.matrix(es))
  stopifnot(nrow(es) == length(gene_sets), ncol(es) == ncol(expr))
})

run_test("enrichment scores are finite numerics", function() {
  par <- GSVA::gsvaParam(expr, gene_sets)
  es <- suppressWarnings(suppressMessages(GSVA::gsva(par)))
  stopifnot(is.numeric(es))
  stopifnot(all(is.finite(es)))
})

run_test("scores carry the gene-set and sample dimnames", function() {
  par <- GSVA::gsvaParam(expr, gene_sets)
  es <- suppressWarnings(suppressMessages(GSVA::gsva(par)))
  # rows may be reordered by size filtering; compare as sets. Sample columns
  # are preserved in input order.
  stopifnot(setequal(rownames(es), names(gene_sets)))
  stopifnot(identical(colnames(es), colnames(expr)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all GSVA smoke tests passed\n")
