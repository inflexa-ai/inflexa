#!/usr/bin/env Rscript
# Smoke test for the R `diffcyt` package.
#
# Fully self-contained: no input files, NO network. diffcyt is a heavy CyTOF
# differential-discovery pipeline; this test stays MODEST. It (1) asserts the
# key pipeline entry points are exported functions, then (2) runs the early
# pipeline stages -- prepareData -> transformData -> generateClusters -- on a
# tiny synthetic two-sample dataset and checks the intermediate structure. It
# does NOT run the statistical tests (testDA/testDS). Checks are STRUCTURAL
# (class, dims relating cells/markers, per-cell cluster labels) rather than
# numeric equality on the random data. Exits 0 only if every check passes, so it
# can be used as a pass/fail library validator:
#
#   Rscript diffcyt.R
#
# ======================= ASSUMPTIONS TO RE-CHECK (FIDDLY) ====================
# Written from the diffcyt source (lmweber/diffcyt) rather than a live install.
# The prepareData input contract is easy to get wrong -- RE-VERIFY:
#
#  * prepareData(d_input, experiment_info, marker_info, ...):
#      - d_input: a flowSet OR a list of matrices (one per sample); each matrix
#        is CELLS x MARKERS with matching column names across samples.
#      - experiment_info: data.frame, one row per sample, MUST contain a
#        `sample_id` column (we also add `group_id`).
#      - marker_info: data.frame, one row per MARKER (== ncol of each matrix),
#        MUST contain `marker_name` and `marker_class`; marker_class is a factor
#        with levels "type"/"state"/"none". At least one "type" marker is
#        required for generateClusters (its default clusters on type markers).
#
#  * RETURNED d_se is a SummarizedExperiment with ROWS = cells (concatenated
#    across samples) and COLUMNS = markers. So nrow(d_se) == total cells,
#    ncol(d_se) == n markers. rowData holds per-cell sample_id/group_id.
#
#  * generateClusters(d_se, xdim, ydim, seed_clustering, ...): runs FlowSOM and
#    adds `rowData(d_se)$cluster_id` -- one label PER CELL, in 1..(xdim*ydim)
#    when meta_clustering = FALSE (the default). FlowSOM is a hard dep of
#    diffcyt, so it is present whenever diffcyt is installed.
#
# If the pipeline setup proves wrong on a real install, the function-existence
# test still exercises the package's exported surface; each run_test is isolated.
# ============================================================================

if (!requireNamespace("diffcyt", quietly = TRUE)) {
  cat("FAIL: package 'diffcyt' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(diffcyt))
cat(sprintf("diffcyt version: %s\n", as.character(packageVersion("diffcyt"))))

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

# ---- tiny synthetic two-sample experiment ---------------------------------
markers <- paste0("M", 1:5)
n_per_sample <- 500L
n_samples <- 2L
total_cells <- n_per_sample * n_samples
xdim <- 5L
ydim <- 5L
n_nodes <- xdim * ydim

make_sample <- function(n) {
  m <- matrix(rnorm(n * length(markers), 5), ncol = length(markers))
  colnames(m) <- markers
  m
}

set.seed(1)
d_input <- list(sample1 = make_sample(n_per_sample),
                sample2 = make_sample(n_per_sample))

experiment_info <- data.frame(
  sample_id = factor(c("sample1", "sample2")),
  group_id  = factor(c("group1", "group2")),
  stringsAsFactors = FALSE
)

marker_info <- data.frame(
  marker_name  = markers,
  marker_class = factor(c("type", "type", "type", "state", "state"),
                        levels = c("type", "state", "none")),
  stringsAsFactors = FALSE
)

run_test("core pipeline entry points are exported functions", function() {
  stopifnot(is.function(prepareData))
  stopifnot(is.function(transformData))
  stopifnot(is.function(generateClusters))
  stopifnot(is.function(calcCounts))
  stopifnot(is.function(calcMedians))
  stopifnot(is.function(testDA_edgeR))
  stopifnot(is.function(testDS_limma))
})

run_test("prepareData builds a cells-x-markers SummarizedExperiment", function() {
  d_se <- suppressMessages(suppressWarnings(
    prepareData(d_input, experiment_info, marker_info)))
  stopifnot(inherits(d_se, "SummarizedExperiment"))
  # rows == cells (concatenated across samples); cols == markers.
  stopifnot(nrow(d_se) == total_cells)
  stopifnot(ncol(d_se) == length(markers))
  # per-cell sample assignment lives in rowData.
  rd <- SummarizedExperiment::rowData(d_se)
  stopifnot("sample_id" %in% colnames(rd))
  stopifnot(length(rd$sample_id) == total_cells)
})

run_test("transformData preserves shape and generateClusters labels cells", function() {
  d_se <- suppressMessages(suppressWarnings(
    prepareData(d_input, experiment_info, marker_info)))
  d_se <- suppressMessages(suppressWarnings(transformData(d_se, cofactor = 5)))
  stopifnot(inherits(d_se, "SummarizedExperiment"))
  stopifnot(nrow(d_se) == total_cells, ncol(d_se) == length(markers))

  d_se <- suppressMessages(suppressWarnings(
    generateClusters(d_se, xdim = xdim, ydim = ydim, seed_clustering = 123)))
  cid <- SummarizedExperiment::rowData(d_se)$cluster_id
  stopifnot(!is.null(cid))
  # one cluster label per cell, within 1..(xdim*ydim) (no meta-clustering).
  stopifnot(length(cid) == total_cells)
  stopifnot(all(as.integer(cid) >= 1L), all(as.integer(cid) <= n_nodes))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all diffcyt smoke tests passed\n")
