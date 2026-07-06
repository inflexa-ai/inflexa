#!/usr/bin/env Rscript
# Smoke test for the R `FlowSOM` package.
#
# Fully self-contained: no input files, NO network. Feeds a small synthetic
# marker matrix (built with a fixed seed) straight into the FlowSOM() one-shot
# wrapper and inspects the resulting self-organizing map + metaclustering.
# Checks are STRUCTURAL/tolerance (object shape, codebook dims, per-cell vs
# per-node assignment lengths) rather than numeric equality on the random SOM.
# Exits 0 only if every check passes, so it can be used as a pass/fail library
# validator:
#
#   Rscript FlowSOM.R
#
# ======================= ASSUMPTIONS TO RE-CHECK (FIDDLY) ====================
# Written from the FlowSOM source (SofieVG/FlowSOM) rather than a live install.
# The FlowSOM object shape changed across major versions -- RE-VERIFY:
#
#  * FlowSOM() one-shot: FlowSOM(input, colsToUse, nClus, xdim, ydim, seed, ...).
#    - v2.x returns the FlowSOM object DIRECTLY.
#    - v1.x returned list(FlowSOM = <obj>, metaclustering = <per-node factor>).
#    We UNWRAP either shape via `res$FlowSOM %||% res`.
#
#  * Field names (v2.x, verified against source):
#      fsom$map$codes   -- matrix, (xdim*ydim) SOM nodes x length(colsToUse)
#      fsom$map$mapping -- matrix, one row PER CELL: [node_id, distance]
#      fsom$metaclustering -- factor of length n_nodes (PER NODE, NOT per cell!)
#    So `fsom$metaclustering` is per-node; PER-CELL metaclusters come from
#    GetMetaclusters(fsom) (length == n cells). We assert both, deriving the
#    per-cell vector defensively if the accessor signature differs by version.
#
#  * A raw matrix is accepted as input (via ReadInput), so this test needs no
#    flowFrame and does not depend on flowCore being attached.
# ============================================================================

if (!requireNamespace("FlowSOM", quietly = TRUE)) {
  cat("FAIL: package 'FlowSOM' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(FlowSOM))
cat(sprintf("FlowSOM version: %s\n", as.character(packageVersion("FlowSOM"))))

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

# Synthetic input: 1000 cells x 5 markers of Gaussian intensities. A raw matrix
# with column names is a valid FlowSOM input. xdim*ydim = 25 SOM nodes.
set.seed(1)
mat <- matrix(rnorm(1000 * 5, 5), ncol = 5, dimnames = list(NULL, paste0("M", 1:5)))
n_cells <- nrow(mat)
n_nodes <- 25L
n_clus <- 5L

# Unwrap a v1.x list(FlowSOM=, metaclustering=) to the bare FlowSOM object.
unwrap <- function(res) if (!is.null(res$FlowSOM)) res$FlowSOM else res

run_test("FlowSOM builds a SOM codebook of the expected shape", function() {
  res <- suppressWarnings(FlowSOM(mat, colsToUse = 1:5, nClus = n_clus,
                                  xdim = 5, ydim = 5, seed = 1))
  fsom <- unwrap(res)
  stopifnot(is.list(fsom))
  stopifnot(!is.null(fsom$map), !is.null(fsom$map$codes))
  codes <- fsom$map$codes
  stopifnot(is.matrix(codes))
  stopifnot(nrow(codes) == n_nodes)  # xdim*ydim SOM nodes
  stopifnot(ncol(codes) == 5L)       # one column per marker in colsToUse
})

run_test("per-node metaclustering labels every SOM node", function() {
  res <- suppressWarnings(FlowSOM(mat, colsToUse = 1:5, nClus = n_clus,
                                  xdim = 5, ydim = 5, seed = 1))
  fsom <- unwrap(res)
  mcl <- fsom$metaclustering
  stopifnot(!is.null(mcl))
  # metaclustering is PER NODE (length n_nodes), each node -> one of nClus.
  stopifnot(length(mcl) == n_nodes)
  stopifnot(length(unique(as.integer(mcl))) <= n_clus)
})

run_test("per-cell node + metacluster assignments span all cells", function() {
  res <- suppressWarnings(FlowSOM(mat, colsToUse = 1:5, nClus = n_clus,
                                  xdim = 5, ydim = 5, seed = 1))
  fsom <- unwrap(res)
  # mapping has exactly one row per cell: [assigned node, distance].
  stopifnot(is.matrix(fsom$map$mapping))
  stopifnot(nrow(fsom$map$mapping) == n_cells)
  stopifnot(all(fsom$map$mapping[, 1] >= 1L),
            all(fsom$map$mapping[, 1] <= n_nodes))
  # Per-cell metaclusters via the accessor; fall back across version signatures,
  # ultimately deriving cell -> node -> node-metacluster by hand.
  mc <- tryCatch(
    FlowSOM::GetMetaclusters(res),
    error = function(e) tryCatch(
      FlowSOM::GetMetaclusters(fsom),
      error = function(e2) fsom$metaclustering[fsom$map$mapping[, 1]]))
  stopifnot(length(mc) == n_cells)
  stopifnot(length(unique(as.integer(mc))) <= n_clus)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all FlowSOM smoke tests passed\n")
