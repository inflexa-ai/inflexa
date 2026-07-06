#!/usr/bin/env Rscript
# Smoke test for the R `lme4` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# lme4 itself (and the dependencies it implies). Uses the bundled
# `sleepstudy` dataset plus data simulated with fixed seeds; model-fit
# checks are structural / tolerance-based, never exact floating-point
# equality. Exercises the core API surface and exits 0 only if every
# check passes, so it can be used as a pass/fail library validator:
#
#   Rscript lme4.R

if (!requireNamespace("lme4", quietly = TRUE)) {
  cat("FAIL: package 'lme4' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(lme4))
cat(sprintf("lme4 version: %s\n", as.character(packageVersion("lme4"))))

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

# Bundled dataset: 18 subjects x 10 days of reaction times.
data(sleepstudy, package = "lme4")

# suppressMessages/suppressWarnings silence benign optimizer/convergence
# chatter only -- real errors still propagate to run_test's tryCatch.
fit_sleepstudy_lmm <- function() {
  suppressMessages(suppressWarnings(
    lmer(Reaction ~ Days + (Days | Subject), data = sleepstudy)
  ))
}

# Simulated logistic GLMM: 24 groups x 15 obs, random intercepts (sd 0.8),
# true fixed effects intercept -0.4 and slope +1.2.
simulate_glmm_data <- function() {
  set.seed(42)
  n_grp <- 24L
  n_per <- 15L
  g <- factor(rep(seq_len(n_grp), each = n_per))
  x <- rnorm(n_grp * n_per)
  b <- rnorm(n_grp, sd = 0.8)
  eta <- -0.4 + 1.2 * x + b[as.integer(g)]
  data.frame(y = rbinom(length(eta), 1L, plogis(eta)), x = x, g = g)
}

fit_sim_glmm <- function(d) {
  suppressMessages(suppressWarnings(
    glmer(y ~ x + (1 | g), data = d, family = binomial)
  ))
}

run_test("lmer: model class and fixed-effect recovery", function() {
  fit <- fit_sleepstudy_lmm()
  stopifnot(inherits(fit, "merMod"), inherits(fit, "lmerMod"))
  fe <- fixef(fit)
  stopifnot(length(fe) == 2L)
  stopifnot(identical(names(fe), c("(Intercept)", "Days")))
  stopifnot(all(is.finite(fe)))
  # Days slope is positive and near the well-known ~10.47 ms/day estimate.
  stopifnot(fe[["Days"]] > 0)
  stopifnot(abs(fe[["Days"]] - 10.47) < 3)
})

run_test("lmer: log-likelihood and residual scale are finite", function() {
  fit <- fit_sleepstudy_lmm()
  ll <- as.numeric(logLik(fit))
  stopifnot(length(ll) == 1L, is.finite(ll))
  stopifnot(is.finite(sigma(fit)), sigma(fit) > 0)
})

run_test("lmer: fitted values and predictions", function() {
  fit <- fit_sleepstudy_lmm()
  fv <- fitted(fit)
  stopifnot(length(fv) == nrow(sleepstudy), all(is.finite(fv)))
  pr <- predict(fit, newdata = sleepstudy[1:5, ])
  stopifnot(length(pr) == 5L, all(is.finite(pr)))
})

run_test("lmer: random-effect structure (VarCorr, ranef)", function() {
  fit <- fit_sleepstudy_lmm()
  vc <- VarCorr(fit)
  stopifnot(!is.null(vc))
  vcd <- as.data.frame(vc)
  stopifnot(nrow(vcd) >= 3L, all(is.finite(vcd$vcov)))
  # Both random-effect standard deviations are strictly positive.
  sd_subj <- attr(vc$Subject, "stddev")
  stopifnot(length(sd_subj) == 2L, all(sd_subj > 0))
  re <- ranef(fit)
  stopifnot(!is.null(re$Subject))
  stopifnot(nrow(re$Subject) == nlevels(sleepstudy$Subject))
  stopifnot(ncol(re$Subject) == 2L)
})

run_test("glmer: binomial GLMM recovers the simulated slope", function() {
  d <- simulate_glmm_data()
  fit <- fit_sim_glmm(d)
  stopifnot(inherits(fit, "merMod"), inherits(fit, "glmerMod"))
  fe <- fixef(fit)
  stopifnot(length(fe) == 2L, all(is.finite(fe)))
  # True slope is +1.2; require the right sign and a generous tolerance.
  stopifnot(fe[["x"]] > 0)
  stopifnot(abs(fe[["x"]] - 1.2) < 0.8)
  stopifnot(is.finite(as.numeric(logLik(fit))))
  stopifnot(is.finite(deviance(fit)))
})

run_test("glmer: fitted probabilities and per-group effects", function() {
  d <- simulate_glmm_data()
  fit <- fit_sim_glmm(d)
  p <- fitted(fit)
  stopifnot(length(p) == nrow(d), all(is.finite(p)))
  stopifnot(all(p >= 0 & p <= 1))
  re <- ranef(fit)
  stopifnot(nrow(re$g) == nlevels(d$g))
  stopifnot(all(is.finite(re$g[["(Intercept)"]])))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all lme4 smoke tests passed\n")
