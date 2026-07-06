#!/usr/bin/env Rscript
# Smoke test for the R `phyloseq` package (microbiome census data containers +
# analysis).
#
# Fully self-contained: no input files, no network, no packages beyond phyloseq
# itself. A synthetic OTU table, sample data, and taxonomy table are assembled
# with a fixed seed into a phyloseq object; checks are structural (component
# dims, accessor round-trips, output classes) with tolerance/range assertions
# on the numeric diversity + distance outputs, never exact floating-point
# equality. Exits 0 only if every check passes, so it can be used as a
# pass/fail library validator:
#
#   Rscript phyloseq.R
#
# The phyloseq accessor names used here (otu_table, sample_data, tax_table,
# ntaxa, nsamples, estimate_richness, distance) are long-stable public API.

if (!requireNamespace("phyloseq", quietly = TRUE)) {
  cat("FAIL: package 'phyloseq' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(phyloseq))
cat(sprintf("phyloseq version: %s\n", as.character(packageVersion("phyloseq"))))

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

# Fixture: 50 taxa (rows) x 8 samples of Poisson counts, taxa-are-rows layout.
# Sample data carries a two-level grouping factor; the taxonomy table gives
# every taxon a single Kingdom rank. Assembled once and reused across tests.
set.seed(1)
n_taxa <- 50L
n_samp <- 8L
taxa_ids <- sprintf("t%02d", seq_len(n_taxa))
samp_ids <- sprintf("s%d", seq_len(n_samp))
otu_mat <- matrix(
  rpois(n_taxa * n_samp, lambda = 10),
  nrow = n_taxa,
  ncol = n_samp,
  dimnames = list(taxa_ids, samp_ids)
)

build_ps <- function() {
  otu <- phyloseq::otu_table(otu_mat, taxa_are_rows = TRUE)
  sd <- phyloseq::sample_data(
    data.frame(grp = rep(c("a", "b"), length.out = n_samp), row.names = samp_ids)
  )
  tax <- phyloseq::tax_table(
    matrix("k__x", nrow = n_taxa, ncol = 1,
           dimnames = list(taxa_ids, "Kingdom"))
  )
  phyloseq::phyloseq(otu, sd, tax)
}

run_test("phyloseq: assembles a container with expected dims", function() {
  ps <- build_ps()
  stopifnot(inherits(ps, "phyloseq"))
  stopifnot(phyloseq::ntaxa(ps) == n_taxa)
  stopifnot(phyloseq::nsamples(ps) == n_samp)
})

run_test("otu_table accessor round-trips the counts", function() {
  ps <- build_ps()
  back <- as(phyloseq::otu_table(ps), "matrix")
  stopifnot(identical(dim(back), c(n_taxa, n_samp)))
  stopifnot(all(back == otu_mat))
})

run_test("estimate_richness returns a per-sample data.frame", function() {
  ps <- build_ps()
  rich <- phyloseq::estimate_richness(ps, measures = c("Observed", "Shannon"))
  stopifnot(is.data.frame(rich))
  stopifnot(nrow(rich) == n_samp)
  stopifnot("Shannon" %in% colnames(rich))
  stopifnot(all(is.finite(rich$Shannon)), all(rich$Shannon >= 0))
  # Observed richness cannot exceed the number of taxa.
  stopifnot(all(rich$Observed >= 0), all(rich$Observed <= n_taxa))
})

run_test("bray-curtis distance is a valid dissimilarity over samples", function() {
  ps <- build_ps()
  d <- phyloseq::distance(ps, method = "bray")
  stopifnot(inherits(d, "dist"))
  stopifnot(attr(d, "Size") == n_samp)
  v <- as.numeric(d)
  stopifnot(all(is.finite(v)), all(v >= 0), all(v <= 1))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all phyloseq smoke tests passed\n")
