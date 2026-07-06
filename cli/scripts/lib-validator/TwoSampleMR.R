#!/usr/bin/env Rscript
# Smoke test for the R `TwoSampleMR` package.
#
# Install: remotes::install_github("MRCIEU/TwoSampleMR")
#
# Fully self-contained: no input files, no network. TwoSampleMR's data-retrieval
# functions (extract_instruments, extract_outcome_data, available_outcomes) hit
# the OpenGWAS API and require an auth token -- those are NETWORK-dependent and
# deliberately OUT OF SCOPE here. This test instead builds a harmonised
# summary-statistics data.frame locally (with a fixed seed and a planted causal
# effect) and exercises the offline harmonised-data -> estimator path. Checks are
# structural / tolerance-based: the IVW point estimate must recover the simulated
# effect within a generous band, standard errors are finite-positive, p-values
# live in [0, 1]. Exits 0 only if every check passes, so it can be used as a
# pass/fail library validator:
#
#   Rscript TwoSampleMR.R
#
# NOTE (needs re-check once installed): the offline API surface was written from
# the documented interface and NOT verified against an installed build.
# Re-confirm:
#   * The harmonised-data columns mr() requires: SNP, id.exposure, id.outcome,
#     exposure, outcome, mr_keep, beta.exposure/se.exposure, beta.outcome/
#     se.outcome and the effect_allele/other_allele pairs for both sides.
#   * mr(dat) returns a data.frame whose columns include method/nsnp/b/se/pval,
#     and that the IVW row is labelled "Inverse variance weighted".
#   * mr_ivw() / mr_egger_regression() take (b_exp, b_out, se_exp, se_out) vectors
#     and return a list keyed b/se/pval (parameters defaults to
#     default_parameters()).
# Simulated associations are floating point, so checks assert structural/robust
# properties -- never exact equality.

if (!requireNamespace("TwoSampleMR", quietly = TRUE)) {
  cat("FAIL: package 'TwoSampleMR' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(TwoSampleMR))
cat(sprintf("TwoSampleMR version: %s\n", as.character(packageVersion("TwoSampleMR"))))

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

# Simulate 30 independent instruments for a true causal effect theta = 0.3.
# Genetic-exposure associations beta.exposure are moderate and "strong" (tight
# standard errors); outcome associations follow the causal model
# beta.outcome = theta * beta.exposure + small balanced-pleiotropy noise. The
# result is assembled into the harmonised long-format frame mr() consumes:
# one row per SNP, mr_keep = TRUE, matched effect/other alleles on both sides.
set.seed(1)
n_snps <- 30L
theta <- 0.3
beta.exposure <- runif(n_snps, 0.10, 0.30)
se.exposure <- runif(n_snps, 0.02, 0.04)
beta.outcome <- theta * beta.exposure + rnorm(n_snps, 0, 0.005)
se.outcome <- runif(n_snps, 0.02, 0.04)

dat <- data.frame(
  SNP = paste0("rs", seq_len(n_snps)),
  exposure = "X",
  outcome = "Y",
  id.exposure = "exp",
  id.outcome = "out",
  effect_allele.exposure = "A",
  other_allele.exposure = "G",
  effect_allele.outcome = "A",
  other_allele.outcome = "G",
  beta.exposure = beta.exposure,
  se.exposure = se.exposure,
  beta.outcome = beta.outcome,
  se.outcome = se.outcome,
  mr_keep = TRUE,
  stringsAsFactors = FALSE
)

run_test("mr_method_list returns the available methods", function() {
  ml <- mr_method_list()
  stopifnot(is.data.frame(ml), nrow(ml) > 0L)
  stopifnot("obj" %in% names(ml))
  stopifnot("mr_ivw" %in% ml$obj)
})

run_test("mr_ivw on summary vectors recovers the effect", function() {
  res <- mr_ivw(dat$beta.exposure, dat$beta.outcome, dat$se.exposure, dat$se.outcome)
  stopifnot(is.list(res))
  stopifnot(all(c("b", "se", "pval") %in% names(res)))
  stopifnot(is.finite(res$b), abs(res$b - theta) < 0.2) # generous recovery band
  stopifnot(is.finite(res$se), res$se > 0)
  stopifnot(is.finite(res$pval), res$pval >= 0, res$pval <= 1)
})

run_test("mr_egger_regression returns a list with b/se/pval", function() {
  res <- mr_egger_regression(dat$beta.exposure, dat$beta.outcome, dat$se.exposure, dat$se.outcome)
  stopifnot(is.list(res))
  stopifnot(all(c("b", "se", "pval") %in% names(res)))
  stopifnot(is.finite(res$b), is.finite(res$se), res$se > 0)
  stopifnot(is.finite(res$pval), res$pval >= 0, res$pval <= 1)
})

run_test("mr() on the harmonised frame recovers the causal effect", function() {
  res <- mr(dat)
  stopifnot(is.data.frame(res), nrow(res) > 0L)
  stopifnot(all(c("method", "nsnp", "b", "se", "pval") %in% names(res)))
  ivw <- res[grepl("Inverse variance weighted", res$method), ]
  stopifnot(nrow(ivw) >= 1L)
  stopifnot(ivw$nsnp[1] == n_snps)
  stopifnot(is.finite(ivw$b[1]), abs(ivw$b[1] - theta) < 0.2)
  stopifnot(is.finite(ivw$pval[1]), ivw$pval[1] >= 0, ivw$pval[1] <= 1)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all TwoSampleMR smoke tests passed\n")
