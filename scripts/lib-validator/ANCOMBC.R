#!/usr/bin/env Rscript
# Smoke test for the R `ANCOMBC` package (Analysis of Compositions of
# Microbiomes with Bias Correction).
#
# Fully self-contained: no input files, no network, no packages beyond ANCOMBC
# itself. ANCOMBC accepts input in three shapes -- a phyloseq object, a
# (Tree)SummarizedExperiment, or a generic feature matrix + sample-metadata
# data.frame -- and the last form needs none of those container packages, so
# the differential-abundance run below is exercised on a plain integer matrix
# with a fixed seed. All checks are structural / tolerance-based (a planted
# signal recovered by name, q-values bounded), never exact floating-point
# equality. Exits 0 only if every check passes, so it can be used as a
# pass/fail library validator:
#
#   Rscript ANCOMBC.R

if (!requireNamespace("ANCOMBC", quietly = TRUE)) {
  cat("FAIL: package 'ANCOMBC' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(ANCOMBC))
cat(sprintf("ANCOMBC version: %s\n", as.character(packageVersion("ANCOMBC"))))

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

# Fixture: a 20-taxon x 12-sample count matrix (taxa in rows), two groups of
# 6. Baseline counts are Poisson around a moderate mean; the first 5 taxa (the
# planted differentially-abundant set) get a strong +60 up-shift in group "b",
# so there is a known effect to recover. Taxon names are zero-padded so the
# result tables' taxon ordering is unambiguous. meta_data carries a sampleid
# column alongside the grouping variable: a single-column metadata frame is
# collapsed and ANCOMBC then reports the formula variable as missing.
set.seed(1)
n_taxa <- 20L
n_samp <- 12L
n_de <- 5L
counts <- matrix(
  rpois(n_taxa * n_samp, lambda = 20),
  nrow = n_taxa,
  ncol = n_samp,
  dimnames = list(sprintf("t%02d", seq_len(n_taxa)),
                  sprintf("s%02d", seq_len(n_samp)))
)
grp <- rep(c("a", "b"), each = n_samp / 2L)
counts[seq_len(n_de), grp == "b"] <- counts[seq_len(n_de), grp == "b"] + 60L
meta <- data.frame(
  sampleid = colnames(counts),
  group = grp,
  row.names = colnames(counts),
  stringsAsFactors = FALSE
)
planted <- sprintf("t%02d", seq_len(n_de))

# capture.output + suppressWarnings/Messages silence ANCOMBC's sanity-check
# and progress chatter (and the "< 3 categories" note for a two-group design);
# genuine errors still propagate to run_test's tryCatch.
run_ancombc <- function() {
  out <- NULL
  invisible(capture.output(suppressWarnings(suppressMessages(
    out <- ancombc(
      data = counts, taxa_are_rows = TRUE, meta_data = meta,
      formula = "group", group = "group", p_adj_method = "holm",
      prv_cut = 0.10, lib_cut = 0, struc_zero = FALSE, neg_lb = FALSE,
      tol = 1e-5, max_iter = 100, conserve = TRUE, alpha = 0.05,
      global = FALSE
    )
  ))))
  out
}

run_test("core API functions are exported and callable", function() {
  stopifnot(is.function(ancombc))
  stopifnot(is.function(ancombc2))
  stopifnot(is.function(ancom))
  stopifnot(is.function(secom_linear))
  stopifnot(is.function(secom_dist))
})

run_test("ancombc runs on a plain matrix + metadata and returns a result list", function() {
  out <- run_ancombc()
  stopifnot(is.list(out))
  stopifnot("res" %in% names(out))
  r <- out$res
  stopifnot(is.list(r))
  # ANCOM-BC primary result: one data.frame per statistic, all taxon-indexed.
  stopifnot(all(c("lfc", "se", "W", "p_val", "q_val", "diff_abn") %in% names(r)))
  for (comp in c("lfc", "se", "W", "p_val", "q_val", "diff_abn")) {
    stopifnot(is.data.frame(r[[comp]]))
  }
})

run_test("result tables are taxon-aligned with the group effect column", function() {
  r <- run_ancombc()$res
  # No prevalence/library filtering removes any taxon here (Poisson lambda 20
  # makes zero counts effectively impossible), so every taxon survives.
  nrows <- vapply(r[c("lfc", "se", "W", "p_val", "q_val", "diff_abn")], nrow, integer(1))
  stopifnot(length(unique(nrows)) == 1L, unname(nrows[1]) == n_taxa)
  stopifnot("taxon" %in% colnames(r$lfc))
  # Two-group design -> an intercept plus one "groupb" effect column.
  stopifnot("groupb" %in% colnames(r$lfc))
  stopifnot("groupb" %in% colnames(r$q_val))
  stopifnot("groupb" %in% colnames(r$diff_abn))
  stopifnot(is.logical(r$diff_abn$groupb))
})

run_test("q-values are bounded and the planted signal is recovered", function() {
  r <- run_ancombc()$res
  q <- r$q_val$groupb
  stopifnot(all(is.finite(q)), all(q >= 0), all(q <= 1))
  # The 5 planted taxa must all be flagged differentially abundant, and their
  # group effect must be clearly larger than the null taxa's. Match by taxon
  # name rather than assuming row order.
  flagged_planted <- r$diff_abn$groupb[match(planted, r$diff_abn$taxon)]
  stopifnot(all(flagged_planted))
  lfc_planted <- r$lfc$groupb[match(planted, r$lfc$taxon)]
  null_taxa <- setdiff(r$lfc$taxon, planted)
  lfc_null <- r$lfc$groupb[match(null_taxa, r$lfc$taxon)]
  stopifnot(median(lfc_planted) > 0.5)
  stopifnot(median(lfc_planted) > median(lfc_null))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all ANCOMBC smoke tests passed\n")
