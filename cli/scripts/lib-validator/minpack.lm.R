#!/usr/bin/env Rscript
# Smoke test for the R `minpack.lm` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# minpack.lm itself (and the dependencies it implies). All data is
# simulated with a fixed seed; model-fit checks are structural /
# tolerance-based, never exact floating-point equality. Exercises the
# core API surface and exits 0 only if every check passes, so it can be
# used as a pass/fail library validator:
#
#   Rscript minpack.lm.R

if (!requireNamespace("minpack.lm", quietly = TRUE)) {
  cat("FAIL: package 'minpack.lm' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(minpack.lm))
cat(sprintf("minpack.lm version: %s\n", as.character(packageVersion("minpack.lm"))))

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

# Exponential growth y = a * exp(b * x) with true a = 2, b = 0.3 and
# gaussian noise (sd 0.15) on 60 points over [0, 5].
set.seed(99)
a_true <- 2
b_true <- 0.3
x <- seq(0, 5, length.out = 60L)
y <- a_true * exp(b_true * x) + rnorm(length(x), sd = 0.15)
d <- data.frame(x = x, y = y)

# Deliberately poor start (a = 1, b = 0.1) so the test exercises the
# Levenberg-Marquardt optimizer, not just a no-op refinement.
fit_exp <- function() {
  suppressWarnings(
    nlsLM(y ~ a * exp(b * x), data = d, start = list(a = 1, b = 0.1))
  )
}

run_test("nlsLM: fit class", function() {
  fit <- fit_exp()
  stopifnot(inherits(fit, "nls"))
})

run_test("nlsLM: recovers the true parameters", function() {
  fit <- fit_exp()
  cf <- coef(fit)
  stopifnot(length(cf) == 2L)
  stopifnot(all(c("a", "b") %in% names(cf)))
  stopifnot(all(is.finite(cf)))
  # Generous tolerance: standard errors here are an order of magnitude
  # smaller, so 0.15 leaves plenty of headroom across platforms.
  stopifnot(abs(cf[["a"]] - a_true) < 0.15)
  stopifnot(abs(cf[["b"]] - b_true) < 0.15)
})

run_test("nlsLM: fitted values and residuals", function() {
  fit <- fit_exp()
  fv <- fitted(fit)
  stopifnot(length(fv) == length(y), all(is.finite(fv)))
  res <- residuals(fit)
  stopifnot(length(res) == length(y), all(is.finite(res)))
  # Noise sd is 0.15 (variance ~0.0225); a sane fit keeps MSE well under 0.1.
  stopifnot(mean(res^2) < 0.1)
})

run_test("nlsLM: summary structure", function() {
  fit <- fit_exp()
  cm <- coef(summary(fit))
  stopifnot(is.matrix(cm))
  stopifnot(nrow(cm) == 2L, ncol(cm) == 4L)
  stopifnot(all(is.finite(cm)))
  # Std. errors (column 2) must be strictly positive.
  stopifnot(all(cm[, 2] > 0))
})

run_test("nlsLM: predictions on new data", function() {
  fit <- fit_exp()
  pr <- predict(fit, newdata = data.frame(x = c(0, 2.5, 5)))
  stopifnot(length(pr) == 3L, all(is.finite(pr)))
  # a > 0 and b > 0, so the fitted curve must be strictly increasing.
  stopifnot(all(diff(pr) > 0))
})

run_test("nls.lm: low-level residual-function interface", function() {
  resid_fn <- function(par, xx, obs) obs - par[["a"]] * exp(par[["b"]] * xx)
  out <- nls.lm(par = list(a = 1, b = 0.1), fn = resid_fn, xx = x, obs = y)
  stopifnot(inherits(out, "nls.lm"))
  stopifnot(is.finite(out$deviance), out$deviance >= 0)
  est <- unlist(out$par)
  stopifnot(abs(est[["a"]] - a_true) < 0.15)
  stopifnot(abs(est[["b"]] - b_true) < 0.15)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all minpack.lm smoke tests passed\n")
