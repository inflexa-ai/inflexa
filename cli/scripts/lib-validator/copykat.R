#!/usr/bin/env Rscript
# Smoke test for the R `copykat` package.
#
# Fully self-contained and OFFLINE: no input files, no network. copykat calls
# aneuploid (malignant) vs diploid (normal) cells from a genes x cells raw scRNA
# UMI count matrix. The full `copykat()` pipeline is deliberately NOT run: it
# REQUIRES a large gene-symbol-rownamed UMI matrix, is slow (per-chromosome
# segmentation + KS clustering), and WRITES result files (predictions, CNA
# matrix, heatmap) into the working directory -- all out of scope for an offline
# validator. Instead the test asserts the package loads and exposes its entry
# point, checks the documented `copykat()` argument names, and builds (but does
# NOT score) a small synthetic UMI matrix of the shape copykat expects. Exits 0
# only if every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript copykat.R
#
# Install (GitHub-hosted, not on CRAN/Bioconductor):
#   remotes::install_github("navinlabcode/copykat")
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# UNVERIFIABLE WITHOUT AN INSTALL -- copykat is NOT installed here, so confirm
# all of the following once a build is available:
#   - copykat() SIGNATURE. The formals check below asserts the documented
#     arguments (rawmat, id.type, ngene.chr, win.size, KS.cut, sam.name,
#     n.cores) are present. If a version renames/removes any, update the check.
#   - RETURN SHAPE. A real copykat() run returns a list with `prediction` (a
#     data.frame of aneuploid/diploid calls per cell) and `CNAmat` (the copy-
#     number matrix). This is NOT exercised here (the pipeline is not run);
#     re-confirm the list element names before relying on them.
#   - INPUT ORIENTATION. copykat expects GENES as rows (gene-symbol rownames)
#     and CELLS as columns of a raw UMI count matrix; id.type="S" selects gene
#     symbols. The synthetic matrix is built to that shape but never scored.
# ============================================================================

if (!requireNamespace("copykat", quietly = TRUE)) {
  cat("FAIL: package 'copykat' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(copykat))
cat(sprintf("copykat version: %s\n", as.character(packageVersion("copykat"))))

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

# Synthetic raw UMI matrix: 100 genes x 20 cells, integer Poisson draws with
# gene-symbol rownames -- the shape copykat's `rawmat` expects (genes as rows,
# cells as columns, id.type="S"). Built only to exercise a cheap structural
# check; it is NEVER passed to copykat() (the full pipeline is slow and writes
# output files, out of scope offline -- see the header note).
set.seed(42)
n_genes <- 100L
n_cells <- 20L
gene_symbols <- sprintf("GENE%03d", seq_len(n_genes))
cell_ids <- paste0("cell", seq_len(n_cells))
rawmat <- matrix(
  rpois(n_genes * n_cells, lambda = 5),
  nrow = n_genes, ncol = n_cells,
  dimnames = list(gene_symbols, cell_ids)
)

run_test("copykat entry point is an exported function", function() {
  stopifnot(is.function(copykat))
})

run_test("copykat() exposes its documented arguments", function() {
  args <- names(formals(copykat))
  # Core documented arguments (see the SIGNATURE note in the header block).
  # Subset check: extra args in a newer version are fine; a rename is the case
  # the header flags for re-confirmation.
  expected <- c("rawmat", "id.type", "ngene.chr", "win.size", "KS.cut",
                "sam.name", "n.cores")
  stopifnot(all(expected %in% args))
})

run_test("synthetic raw UMI matrix has the copykat-expected shape", function() {
  # genes x cells, non-negative integer counts, named rows/cols -- what `rawmat`
  # needs. This never touches copykat(); it only guards the construction above.
  stopifnot(is.matrix(rawmat))
  stopifnot(nrow(rawmat) == n_genes, ncol(rawmat) == n_cells)
  stopifnot(!is.null(rownames(rawmat)), !is.null(colnames(rawmat)))
  stopifnot(all(rawmat >= 0), all(rawmat == round(rawmat)))
  # id.type="S" resolves rownames as gene SYMBOLS -- they must be non-empty.
  stopifnot(all(nzchar(rownames(rawmat))))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all copykat smoke tests passed\n")
