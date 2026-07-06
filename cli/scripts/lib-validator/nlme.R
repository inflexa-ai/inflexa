#!/usr/bin/env Rscript
# Smoke test for the R `nlme` package.
#
# Fully self-contained: no input files, no network, no packages beyond nlme
# itself (and its implied deps). Data is either bundled with the package
# (`Orthodont`, `Loblolly`) or simulated with a fixed seed. Exercises the core
# mixed-effects modeling API and exits 0 only if every check passes, so it can
# be used as a pass/fail library validator:
#
#   Rscript nlme.R
#
# Modeling outputs are floating-point, so checks assert structural/robust
# properties (classes, lengths, finiteness, sign of effects) and recover known
# effects only within a generous tolerance -- never exact coefficient equality.

if (!requireNamespace("nlme", quietly = TRUE)) {
  cat("FAIL: package 'nlme' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(nlme))
cat(sprintf("nlme version: %s\n", as.character(packageVersion("nlme"))))

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

run_test("lme random-intercept model on Orthodont", function() {
  fit <- lme(distance ~ age, random = ~1 | Subject, data = Orthodont)
  stopifnot(inherits(fit, "lme"))
  fe <- fixef(fit)
  stopifnot(length(fe) == 2L, identical(names(fe), c("(Intercept)", "age")))
  stopifnot(all(is.finite(fe)))
  # dental distance increases with age -> positive slope
  stopifnot(fe["age"] > 0)
  stopifnot(is.finite(as.numeric(logLik(fit))))
  stopifnot(length(fitted(fit)) == nrow(Orthodont))
  stopifnot(length(resid(fit)) == nrow(Orthodont))
})

run_test("lme fitted + residuals reconstruct the response", function() {
  fit <- lme(distance ~ age, random = ~1 | Subject, data = Orthodont)
  recon <- fitted(fit) + resid(fit)
  # identity fitted + residual == observed, up to floating-point noise.
  # compare raw numeric values -- the grouped-data response carries a `label`
  # attribute that would trip all.equal's attribute comparison.
  diff <- as.numeric(recon) - as.numeric(Orthodont$distance)
  stopifnot(max(abs(diff)) < 1e-6)
})

run_test("lme recovers a known fixed effect (simulated)", function() {
  set.seed(77)
  ng <- 30L # groups
  ni <- 8L  # observations per group
  b0 <- 5
  b1 <- 2.5
  grp <- factor(rep(seq_len(ng), each = ni))
  re <- rnorm(ng, sd = 1.5)[grp]
  x <- rnorm(ng * ni)
  y <- b0 + b1 * x + re + rnorm(ng * ni, sd = 0.5)
  d <- data.frame(y = y, x = x, grp = grp)
  fit <- lme(y ~ x, random = ~1 | grp, data = d)
  fe <- fixef(fit)
  stopifnot(all(is.finite(fe)))
  # generous tolerances -- floating-point fit on simulated data
  stopifnot(abs(fe["x"] - b1) < 0.3)
  stopifnot(abs(fe["(Intercept)"] - b0) < 1.0)
})

run_test("gls fit on Orthodont", function() {
  fit <- gls(distance ~ age, data = Orthodont)
  stopifnot(inherits(fit, "gls"))
  cf <- coef(fit)
  stopifnot(length(cf) == 2L, all(is.finite(cf)))
  stopifnot(cf["age"] > 0)
  stopifnot(is.finite(as.numeric(logLik(fit))))
  stopifnot(length(fitted(fit)) == nrow(Orthodont))
})

run_test("nlme nonlinear growth model on Loblolly", function() {
  # self-starting logistic growth of pine height vs age, with a random
  # asymptote per seed source. suppressWarnings guards benign convergence
  # chatter, NOT genuine errors (a non-convergence error still propagates).
  fit <- suppressWarnings(nlme(
    height ~ SSlogis(age, Asym, xmid, scal),
    data = Loblolly,
    fixed = Asym + xmid + scal ~ 1,
    random = Asym ~ 1 | Seed,
    start = c(Asym = 103, xmid = 6, scal = 3)
  ))
  stopifnot(inherits(fit, "nlme"))
  fe <- fixef(fit)
  stopifnot(length(fe) == 3L)
  stopifnot(identical(names(fe), c("Asym", "xmid", "scal")))
  stopifnot(all(is.finite(fe)))
  # the asymptotic height is a positive, physically plausible value
  stopifnot(fe["Asym"] > 0)
  stopifnot(is.finite(as.numeric(logLik(fit))))
})

run_test("corAR1 correlation structure fits", function() {
  # lightly exercise a variance/correlation structure: an AR(1) within-subject
  # correlation on the ordered Orthodont measurements.
  fit <- gls(distance ~ age, data = Orthodont,
             correlation = corAR1(form = ~1 | Subject))
  stopifnot(inherits(fit, "gls"))
  stopifnot(is.finite(as.numeric(logLik(fit))))
  # the estimated AR(1) parameter is a valid correlation in (-1, 1)
  phi <- coef(fit$modelStruct$corStruct, unconstrained = FALSE)
  stopifnot(is.finite(phi), phi > -1, phi < 1)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all nlme smoke tests passed\n")
