#!/usr/bin/env Rscript
# Smoke test for the R `MendelianRandomization` package.
#
# Fully self-contained: no input files, no network. Simulates summary-level
# two-sample MR data (per-SNP exposure and outcome associations with standard
# errors) for a known causal effect with a fixed seed, then runs the standard
# estimators. Checks are structural / tolerance-based: the IVW point estimate
# must recover the simulated effect within a generous band, standard errors are
# finite-positive, p-values live in [0, 1]. Exits 0 only if every check passes,
# so it can be used as a pass/fail library validator:
#
#   Rscript MendelianRandomization.R
#
# NOTE (needs re-check once installed): MendelianRandomization's result objects
# are S4 classes (MRInput / IVW / Egger / MRAll), so estimates are read via
# `@` slot access -- NOT `$` (which errors on S4). Slot names (Estimate,
# StdError, Pvalue, Intercept, Values) were taken from the documented API and
# each is guarded by a `slotNames()` membership check before it is read, so a
# renamed slot fails that one test cleanly rather than crashing. Re-confirm the
# slot names and the exact class of `mr_ivw` output (IVW vs WeightedIVW) once a
# build is available.

if (!requireNamespace("MendelianRandomization", quietly = TRUE)) {
  cat("FAIL: package 'MendelianRandomization' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(MendelianRandomization))
cat(sprintf(
  "MendelianRandomization version: %s\n",
  as.character(packageVersion("MendelianRandomization"))
))

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

# Simulate 20 independent instruments for a true causal effect theta = 0.3.
# Genetic-exposure associations bx are moderate; outcome associations by follow
# the causal model by = theta * bx + small balanced pleiotropy noise. Standard
# errors are drawn from a tight uniform band so the instruments are "strong".
set.seed(1)
n_snps <- 20L
theta <- 0.3
bx <- runif(n_snps, 0.10, 0.50)
bxse <- runif(n_snps, 0.02, 0.05)
by <- theta * bx + rnorm(n_snps, 0, 0.02)
byse <- runif(n_snps, 0.02, 0.05)

run_test("mr_input builds an MRInput object", function() {
  input <- mr_input(bx = bx, bxse = bxse, by = by, byse = byse)
  stopifnot(inherits(input, "MRInput"))
})

run_test("mr_ivw recovers the causal effect", function() {
  input <- mr_input(bx = bx, bxse = bxse, by = by, byse = byse)
  res <- mr_ivw(input)
  stopifnot(inherits(res, "IVW") || inherits(res, "WeightedIVW"))
  stopifnot(all(c("Estimate", "StdError", "Pvalue") %in% slotNames(res)))
  est <- res@Estimate
  se <- res@StdError
  pv <- res@Pvalue
  stopifnot(is.finite(est), abs(est - theta) < 0.2) # generous recovery band
  stopifnot(is.finite(se), se > 0)
  stopifnot(is.finite(pv), pv >= 0, pv <= 1)
})

run_test("mr_egger returns an Egger fit with an intercept", function() {
  input <- mr_input(bx = bx, bxse = bxse, by = by, byse = byse)
  res <- mr_egger(input)
  stopifnot(inherits(res, "Egger"))
  stopifnot(all(c("Estimate", "Intercept") %in% slotNames(res)))
  stopifnot(is.finite(res@Estimate), is.finite(res@Intercept))
})

run_test("mr_allmethods runs and returns a table", function() {
  input <- mr_input(bx = bx, bxse = bxse, by = by, byse = byse)
  res <- mr_allmethods(input, method = "main")
  stopifnot(inherits(res, "MRAll"))
  stopifnot("Values" %in% slotNames(res))
  vals <- res@Values
  stopifnot(is.data.frame(vals), nrow(vals) > 0L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all MendelianRandomization smoke tests passed\n")
