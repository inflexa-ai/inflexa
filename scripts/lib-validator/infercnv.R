#!/usr/bin/env Rscript
# Smoke test for the R `infercnv` package.
#
# Fully self-contained: no input files, no network. Builds a small synthetic
# scRNA-seq counts matrix (genes x cells) with a fixed seed, plus the two
# in-memory metadata frames infercnv needs -- a per-cell group annotation
# (with a reference group) and a per-gene genomic-order table -- and constructs
# an infercnv object. Only the OBJECT-CONSTRUCTION surface is exercised: the
# heavy `infercnv::run()` HMM/Bayesian step is deliberately NOT called (it is
# extremely slow and pulls in rjags/JAGS). Checks are structural (S4 class,
# populated slots, aligned dimensions) -- never numeric. Exits 0 only if every
# check passes, so it can be used as a pass/fail library validator:
#
#   Rscript infercnv.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# UNVERIFIABLE WITHOUT AN INSTALL -- confirm all of the following once infercnv
# is available:
#   - CreateInfercnvObject() ARG NAMES. This test relies on the documented
#     in-memory path where `raw_counts_matrix` takes a matrix and BOTH
#     `annotations_file` and `gene_order_file` accept in-memory data.frames
#     (not only file paths). Arg spelling: raw_counts_matrix, annotations_file,
#     gene_order_file, ref_group_names.
#   - The annotations data.frame shape: rownames = cell ids, first column = the
#     group label; the gene_order data.frame shape: rownames = gene ids, three
#     columns interpreted as (chr, start, stop).
#   - Retained dims. CreateInfercnvObject filters cells by total counts
#     (min_max_counts_per_cell default c(100, +Inf)) and drops genes on excluded
#     chromosomes (chr_exclude default chrX/chrY/chrM). The synthetic data is
#     built to survive both (chr1/chr2 only, ~300 counts/cell), so all 60 genes
#     and 20 cells are EXPECTED to remain -- but the exact filtering behaviour
#     must be re-confirmed against an installed build.
#   - rjags / JAGS DEPENDENCY. infercnv Imports rjags, which links the external
#     libjags library at load time. On a machine without libjags, loading
#     infercnv (and hence the requireNamespace guard below) can itself fail --
#     an install-only miss and a missing-libjags miss both fire the guard.
# ============================================================================

if (!requireNamespace("infercnv", quietly = TRUE)) {
  cat("FAIL: package 'infercnv' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(infercnv))
cat(sprintf("infercnv version: %s\n", as.character(packageVersion("infercnv"))))

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

# Synthetic design: 60 genes x 20 cells. Genes live only on chr1/chr2 so none
# are dropped by the default chr_exclude; Poisson(mean=5) gives ~300 counts per
# cell, comfortably above the default min-counts filter (100). Ten reference
# ("normal") cells and ten observation ("tumor") cells.
set.seed(42)
n_genes <- 60L
n_cells <- 20L
genes <- paste0("gene", seq_len(n_genes))
cells <- paste0("cell", seq_len(n_cells))

counts <- matrix(
  rpois(n_genes * n_cells, lambda = 5),
  nrow = n_genes, ncol = n_cells,
  dimnames = list(genes, cells)
)

# gene_order: rownames = gene ids; three columns read as chr/start/stop. Half
# the genes on chr1, half on chr2, each with a monotonically increasing start.
gene_order_df <- data.frame(
  chr = rep(c("chr1", "chr2"), each = n_genes / 2L),
  start = rep(seq_len(n_genes / 2L) * 1000L, times = 2L),
  stop = rep(seq_len(n_genes / 2L) * 1000L, times = 2L) + 500L,
  row.names = genes
)

# annotations: rownames = cell ids; first column = group. "normal" is the
# reference group, "tumor" the observation group.
annot_df <- data.frame(
  group = rep(c("normal", "tumor"), each = n_cells / 2L),
  row.names = cells
)

# Build once; object construction is the whole surface under test. infercnv
# chatters through a logging framework, so silence warnings/messages here.
make_obj <- function() {
  suppressWarnings(suppressMessages(
    CreateInfercnvObject(
      raw_counts_matrix = counts,
      annotations_file = annot_df,
      gene_order_file = gene_order_df,
      ref_group_names = c("normal")
    )
  ))
}

run_test("CreateInfercnvObject returns an infercnv S4 object", function() {
  obj <- make_obj()
  stopifnot(inherits(obj, "infercnv"))
  stopifnot(isVirtualClass("infercnv") == FALSE)
})

run_test("count.data slot is populated with the expected dimensions", function() {
  obj <- make_obj()
  cd <- obj@count.data
  stopifnot(!is.null(cd))
  # dense matrix or a Matrix-package sparse matrix, depending on infercnv version
  stopifnot(is.matrix(cd) || inherits(cd, "Matrix"))
  stopifnot(nrow(cd) > 0L, ncol(cd) > 0L)
  # All synthetic cells clear the count filter and all genes survive chr_exclude,
  # so nothing should be dropped. (Re-check: filtering behaviour is version-
  # dependent -- see the ASSUMPTIONS block above.)
  stopifnot(ncol(cd) == n_cells)
  stopifnot(nrow(cd) == n_genes)
  stopifnot(all(colnames(cd) %in% cells))
  stopifnot(all(rownames(cd) %in% genes))
})

run_test("gene_order slot is populated and aligned with count.data", function() {
  obj <- make_obj()
  go <- obj@gene_order
  stopifnot(is.data.frame(go))
  # infercnv renames the three columns to chr/start/stop internally.
  stopifnot(all(c("chr", "start", "stop") %in% colnames(go)))
  # count.data and gene_order describe the same genes, in the same order.
  stopifnot(nrow(go) == nrow(obj@count.data))
  stopifnot(identical(rownames(go), rownames(obj@count.data)))
})

run_test("reference and observation groups are recorded", function() {
  obj <- make_obj()
  ref_idx <- obj@reference_grouped_cell_indices
  obs_idx <- obj@observation_grouped_cell_indices
  stopifnot(is.list(ref_idx), is.list(obs_idx))
  stopifnot("normal" %in% names(ref_idx))
  stopifnot("tumor" %in% names(obs_idx))
  # Every reference index points at a real column of the count matrix.
  ref_cols <- ref_idx[["normal"]]
  stopifnot(length(ref_cols) > 0L)
  stopifnot(all(ref_cols >= 1L & ref_cols <= ncol(obj@count.data)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all infercnv smoke tests passed\n")
