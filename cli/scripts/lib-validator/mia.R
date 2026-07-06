#!/usr/bin/env Rscript
# Smoke test for the R `mia` package (Microbiome Analysis on the
# TreeSummarizedExperiment / SummarizedExperiment container).
#
# Fully self-contained: no input files, no network, no packages beyond mia and
# its container dependency (TreeSummarizedExperiment). A synthetic counts assay
# with taxonomy rowData and grouping colData is assembled with a fixed seed;
# checks are structural (new assays appear, a diversity column lands in
# colData, agglomeration reduces the feature count) with tolerance/range
# assertions on numeric outputs, never exact floating-point equality. Exits 0
# only if every check passes, so it can be used as a pass/fail library
# validator:
#
#   Rscript mia.R
#
# FLAG (unverified on this machine -- mia is NOT installed here): mia's function
# names have been RENAMED repeatedly across releases and MUST be re-checked --
#   * transformAssay() (older: transformCounts / transformSamples)
#   * addAlpha() (older: estimateDiversity / estimateAlpha)
#   * agglomerateByRank()
# and the TreeSummarizedExperiment() constructor + assay.type/name argument
# spellings likewise.

if (!requireNamespace("mia", quietly = TRUE)) {
  cat("FAIL: package 'mia' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(mia))
cat(sprintf("mia version: %s\n", as.character(packageVersion("mia"))))

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

# Fixture: 40 taxa x 12 samples of Poisson counts assembled into a
# TreeSummarizedExperiment. rowData carries a two-column taxonomy (Phylum,
# Genus) so agglomeration by rank has something to collapse; colData carries a
# two-level grouping factor. Genus is intentionally lower-cardinality than the
# raw taxa so agglomerateByRank reduces the feature count.
set.seed(1)
n_taxa <- 40L
n_samp <- 12L
taxa_ids <- sprintf("t%02d", seq_len(n_taxa))
samp_ids <- sprintf("s%02d", seq_len(n_samp))
counts <- matrix(
  rpois(n_taxa * n_samp, lambda = 10),
  nrow = n_taxa,
  ncol = n_samp,
  dimnames = list(taxa_ids, samp_ids)
)
row_data <- S4Vectors::DataFrame(
  Phylum = rep(c("P1", "P2"), length.out = n_taxa),
  Genus = rep(sprintf("G%02d", 1:8), length.out = n_taxa),
  row.names = taxa_ids
)
col_data <- S4Vectors::DataFrame(
  group = rep(c("a", "b"), length.out = n_samp),
  row.names = samp_ids
)

build_tse <- function() {
  TreeSummarizedExperiment::TreeSummarizedExperiment(
    assays = list(counts = counts),
    rowData = row_data,
    colData = col_data
  )
}

run_test("TreeSummarizedExperiment fixture builds with expected dims", function() {
  tse <- build_tse()
  stopifnot(inherits(tse, "TreeSummarizedExperiment"))
  stopifnot(nrow(tse) == n_taxa, ncol(tse) == n_samp)
  stopifnot("counts" %in% SummarizedExperiment::assayNames(tse))
})

run_test("transformAssay adds a relative-abundance assay", function() {
  tse <- build_tse()
  tse <- mia::transformAssay(tse, assay.type = "counts", method = "relabundance")
  stopifnot("relabundance" %in% SummarizedExperiment::assayNames(tse))
  ra <- SummarizedExperiment::assay(tse, "relabundance")
  stopifnot(identical(dim(ra), c(n_taxa, n_samp)))
  # Relative abundances are non-negative and each sample sums to ~1.
  stopifnot(all(ra >= 0))
  stopifnot(all(abs(colSums(ra) - 1) < 1e-8))
})

run_test("addAlpha lands a Shannon diversity column in colData", function() {
  tse <- build_tse()
  tse <- mia::addAlpha(tse, assay.type = "counts", index = "shannon")
  cd <- SummarizedExperiment::colData(tse)
  # The new column carries the index name (exact spelling may vary by version);
  # locate it by prefix rather than an exact match.
  div_col <- grep("shannon", colnames(cd), ignore.case = TRUE, value = TRUE)
  stopifnot(length(div_col) >= 1L)
  vals <- cd[[div_col[1]]]
  stopifnot(length(vals) == n_samp)
  stopifnot(all(is.finite(vals)), all(vals >= 0))
})

run_test("agglomerateByRank collapses features to the Genus rank", function() {
  tse <- build_tse()
  agg <- mia::agglomerateByRank(tse, rank = "Genus")
  stopifnot(inherits(agg, "TreeSummarizedExperiment"))
  # 8 distinct Genus labels -> at most 8 agglomerated features, fewer than the
  # 40 raw taxa.
  stopifnot(nrow(agg) <= 8L)
  stopifnot(nrow(agg) < n_taxa)
  stopifnot(ncol(agg) == n_samp)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all mia smoke tests passed\n")
