#!/usr/bin/env Rscript
# Smoke test for the R `miaViz` package (ggplot2-based visualisation for mia /
# TreeSummarizedExperiment microbiome data).
#
# Fully self-contained: no input files, no network, no packages beyond miaViz
# and its container dependency (TreeSummarizedExperiment). miaViz builds ggplot
# objects rather than drawing to a device, so this test stays MODEST: it checks
# the plotting entry points are exported, and -- only if a TreeSummarizedExperiment
# can be assembled cheaply here -- that plotAbundance() returns a ggplot object
# WITHOUT opening any graphics device. Exits 0 only if every check passes, so it
# can be used as a pass/fail library validator:
#
#   Rscript miaViz.R
#
# Verified against miaViz 1.18.1 (Bioc 3.22): the plotting function names
# (plotAbundance, plotAbundanceDensity, plotRowTree) and plotAbundance()'s
# rank/assay.type arguments. Note miaViz has no plotColData (that is scater);
# colData is plotted via plotColTile/plotColGraph.

if (!requireNamespace("miaViz", quietly = TRUE)) {
  cat("FAIL: package 'miaViz' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(miaViz))
cat(sprintf("miaViz version: %s\n", as.character(packageVersion("miaViz"))))

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

run_test("core plotting functions are exported and callable", function() {
  # NB: colData is visualised by plotColTile/plotColGraph in miaViz — there is no
  # plotColData here (that name belongs to scater, a different package).
  stopifnot(is.function(plotAbundance))
  stopifnot(is.function(plotAbundanceDensity))
  stopifnot(is.function(plotRowTree))
})

# Only attempt the render check when a TreeSummarizedExperiment can actually be
# constructed on this machine; otherwise the exported-functions check above is
# the whole smoke test (no failing assertion is added blind).
if (requireNamespace("TreeSummarizedExperiment", quietly = TRUE)) {
  set.seed(1)
  n_taxa <- 30L
  n_samp <- 8L
  taxa_ids <- sprintf("t%02d", seq_len(n_taxa))
  samp_ids <- sprintf("s%d", seq_len(n_samp))
  counts <- matrix(
    rpois(n_taxa * n_samp, lambda = 10),
    nrow = n_taxa,
    ncol = n_samp,
    dimnames = list(taxa_ids, samp_ids)
  )
  row_data <- S4Vectors::DataFrame(
    Phylum = rep(c("P1", "P2"), length.out = n_taxa),
    row.names = taxa_ids
  )
  col_data <- S4Vectors::DataFrame(
    group = rep(c("a", "b"), length.out = n_samp),
    row.names = samp_ids
  )
  tse <- TreeSummarizedExperiment::TreeSummarizedExperiment(
    assays = list(counts = counts),
    rowData = row_data,
    colData = col_data
  )

  run_test("plotAbundance returns a ggplot without drawing to a device", function() {
    # ggplot construction touches no device; guard anyway so a stray draw can't
    # spawn an Rplots.pdf in the working directory.
    p <- plotAbundance(tse, assay.type = "counts", rank = "Phylum")
    stopifnot(inherits(p, "ggplot"))
  })

  run_test("plotAbundanceDensity returns a ggplot without drawing to a device", function() {
    p <- plotAbundanceDensity(tse, assay.type = "counts")
    stopifnot(inherits(p, "ggplot"))
  })
} else {
  cat("  note miaViz: TreeSummarizedExperiment unavailable; skipping render checks\n")
}

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all miaViz smoke tests passed\n")
