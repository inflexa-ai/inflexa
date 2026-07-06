#!/usr/bin/env Rscript
# Smoke test for the R `Maaslin2` package (multivariable association between
# microbiome features and sample metadata).
#
# Fully self-contained: no input files, no network, no packages beyond Maaslin2
# itself. Abundance and metadata tables are simulated with a fixed seed; the
# only filesystem use is a temp output directory, created under tempdir() and
# removed on exit. Checks are structural (the results data.frame shape and
# required columns), never exact floating-point equality. Exits 0 only if every
# check passes, so it can be used as a pass/fail library validator:
#
#   Rscript Maaslin2.R
#
# FLAG (unverified on this machine -- Maaslin2 is NOT installed here):
#   * ARG NAMES: input_data / input_metadata / output / fixed_effects and the
#     plot_heatmap = FALSE / plot_scatter = FALSE toggles are taken from the
#     documented Maaslin2() signature and should be re-checked.
#   * ORIENTATION: Maaslin2 expects samples in ROWS -- both input_data
#     (samples x features) and input_metadata (samples x covariates) are keyed
#     by the same sample row names.
#   * The results table lives at fit$results with columns
#     metadata/feature/coef/pval/qval.

if (!requireNamespace("Maaslin2", quietly = TRUE)) {
  cat("FAIL: package 'Maaslin2' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(Maaslin2))
cat(sprintf("Maaslin2 version: %s\n", as.character(packageVersion("Maaslin2"))))

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

# Fixture: 30 samples x 20 features of Poisson abundances (samples in rows),
# plus a metadata frame with a two-level "group" covariate keyed by the same
# sample names. A +30 shift on the first 4 features in group "b" plants a
# recoverable association.
set.seed(1)
n_samp <- 30L
n_feat <- 20L
samp_ids <- sprintf("s%02d", seq_len(n_samp))
feat_ids <- sprintf("f%02d", seq_len(n_feat))
abund_mat <- matrix(
  rpois(n_samp * n_feat, lambda = 20),
  nrow = n_samp,
  ncol = n_feat,
  dimnames = list(samp_ids, feat_ids)
)
group <- rep(c("a", "b"), length.out = n_samp)
abund_mat[group == "b", 1:4] <- abund_mat[group == "b", 1:4] + 30L
abund <- as.data.frame(abund_mat)
meta <- data.frame(group = group, row.names = samp_ids, stringsAsFactors = FALSE)

# Maaslin2() writes a full set of TSVs/plots to `output`; keep it inside
# tempdir() and remove it afterwards. capture.output + suppressMessages silence
# the fitting log; genuine errors still propagate to run_test's tryCatch.
run_maaslin <- function() {
  out <- tempfile("maaslin2-smoke-", tmpdir = tempdir())
  on.exit(unlink(out, recursive = TRUE), add = TRUE)
  fit <- NULL
  invisible(capture.output(suppressMessages(
    fit <- Maaslin2::Maaslin2(
      input_data = abund,
      input_metadata = meta,
      output = out,
      fixed_effects = c("group"),
      plot_heatmap = FALSE,
      plot_scatter = FALSE
    )
  )))
  fit
}

run_test("Maaslin2: fit object exposes a results data.frame", function() {
  fit <- run_maaslin()
  stopifnot(is.list(fit))
  stopifnot("results" %in% names(fit))
  stopifnot(is.data.frame(fit$results))
  stopifnot(nrow(fit$results) >= 1L)
})

run_test("Maaslin2: results table has the association columns", function() {
  fit <- run_maaslin()
  res <- fit$results
  stopifnot(all(c("metadata", "feature", "coef", "pval", "qval") %in% colnames(res)))
})

run_test("Maaslin2: p/q values are bounded and finite", function() {
  fit <- run_maaslin()
  res <- fit$results
  stopifnot(all(is.finite(res$pval)), all(res$pval >= 0), all(res$pval <= 1))
  stopifnot(all(is.finite(res$qval)), all(res$qval >= 0), all(res$qval <= 1))
  # Every association is against the single tested covariate.
  stopifnot(all(res$metadata == "group"))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all Maaslin2 smoke tests passed\n")
