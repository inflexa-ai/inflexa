#!/usr/bin/env Rscript
# Smoke test for the R `mgcv` package.
#
# Fully self-contained: no input files, no network, no packages beyond mgcv
# itself (and its implied deps). Data is simulated with a fixed seed (either by
# hand or via `mgcv::gamSim`). Exercises the core generalized-additive-model
# API and exits 0 only if every check passes, so it can be used as a pass/fail
# library validator:
#
#   Rscript mgcv.R
#
# Modeling outputs are floating-point, so checks assert structural/robust
# properties (classes, lengths, finiteness, goodness-of-fit ranges) rather than
# exact coefficient equality on the fitted smooths.

if (!requireNamespace("mgcv", quietly = TRUE)) {
  cat("FAIL: package 'mgcv' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(mgcv))
cat(sprintf("mgcv version: %s\n", as.character(packageVersion("mgcv"))))

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

run_test("gam smooth recovers a sine signal (simulated)", function() {
  set.seed(42)
  n <- 200L
  x <- sort(runif(n))
  y <- sin(2 * pi * x) + rnorm(n, sd = 0.2)
  fit <- gam(y ~ s(x))
  stopifnot(inherits(fit, "gam"))
  s <- summary(fit)
  stopifnot(is.finite(s$r.sq))
  # a low-noise sine is captured well by a spline smooth
  stopifnot(s$r.sq > 0.5)
  # a genuinely nonlinear smooth was fit -> effective df above the linear (1)
  stopifnot(sum(fit$edf) > 1)
})

run_test("predict from a fitted gam", function() {
  set.seed(42)
  n <- 200L
  x <- sort(runif(n))
  y <- sin(2 * pi * x) + rnorm(n, sd = 0.2)
  fit <- gam(y ~ s(x))
  p <- predict(fit)
  stopifnot(length(p) == n, all(is.finite(p)))
  # prediction on fresh data returns one finite value per new row
  nd <- data.frame(x = c(0.1, 0.25, 0.5, 0.75, 0.9))
  pn <- predict(fit, newdata = nd)
  stopifnot(length(pn) == nrow(nd), all(is.finite(pn)))
})

run_test("parametric gam term runs", function() {
  set.seed(11)
  n <- 150L
  x <- runif(n)
  y <- 2 + 3 * x + rnorm(n, sd = 0.1)
  fit <- gam(y ~ x)
  stopifnot(inherits(fit, "gam"))
  cf <- coef(fit)
  stopifnot(length(cf) == 2L, all(is.finite(cf)))
  # strong positive linear trend -> positive slope
  stopifnot(cf["x"] > 0)
})

run_test("gam with multiple smooths on gamSim data", function() {
  set.seed(7)
  sim <- gamSim(1, n = 400, verbose = FALSE)
  fit <- gam(y ~ s(x0) + s(x1) + s(x2) + s(x3), data = sim)
  stopifnot(inherits(fit, "gam"))
  s <- summary(fit)
  stopifnot(is.finite(s$r.sq), is.finite(s$dev.expl))
  # the gamSim(1) surface is well explained by four additive smooths
  stopifnot(s$r.sq > 0.5, s$dev.expl > 0.5)
  # one smooth term per s(...) in the formula
  stopifnot(length(fit$smooth) == 4L)
})

run_test("gam summary exposes the expected components", function() {
  set.seed(7)
  sim <- gamSim(1, n = 200, verbose = FALSE)
  fit <- gam(y ~ s(x0) + s(x2), data = sim)
  s <- summary(fit)
  stopifnot(!is.null(s$p.table), !is.null(s$s.table))
  # p.table has the parametric intercept row; s.table has one row per smooth
  stopifnot(nrow(s$p.table) >= 1L)
  stopifnot(nrow(s$s.table) == 2L)
  # smooth-term p-values are valid probabilities
  spv <- s$s.table[, "p-value"]
  stopifnot(all(is.finite(spv)), all(spv >= 0), all(spv <= 1))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all mgcv smoke tests passed\n")
