#!/usr/bin/env Rscript
# Smoke test for the R `glmnet` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# glmnet itself (and the dependencies it implies, e.g. Matrix). All data
# is simulated with fixed seeds; model-fit checks are structural /
# tolerance-based, never exact floating-point equality. Exercises the
# core API surface and exits 0 only if every check passes, so it can be
# used as a pass/fail library validator:
#
#   Rscript glmnet.R

if (!requireNamespace("glmnet", quietly = TRUE)) {
  cat("FAIL: package 'glmnet' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(glmnet))
cat(sprintf("glmnet version: %s\n", as.character(packageVersion("glmnet"))))

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

# Sparse gaussian design: only the first 3 of 20 predictors carry signal.
set.seed(1234)
n <- 100L
p <- 20L
X <- matrix(rnorm(n * p), n, p)
beta_true <- c(3, -2, 1.5, rep(0, p - 3L))
y <- as.numeric(X %*% beta_true + rnorm(n))

# Separate seed for the binomial response so the two simulations stay
# independently reproducible; strong effects (+1.5 / -1.5) on X1 and X2.
set.seed(4321)
ybin <- rbinom(n, 1L, plogis(1.5 * X[, 1] - 1.5 * X[, 2]))

run_test("gaussian lasso: fit object and lambda path", function() {
  fit <- glmnet(X, y)
  stopifnot(inherits(fit, "glmnet"))
  stopifnot(length(fit$lambda) > 1L)
  stopifnot(all(is.finite(fit$lambda)), all(fit$lambda > 0))
  # The regularization path is a strictly decreasing lambda sequence.
  stopifnot(all(diff(fit$lambda) < 0))
  stopifnot(identical(dim(fit$beta), c(p, length(fit$lambda))))
})

run_test("coef and predict shapes at a fixed lambda", function() {
  fit <- glmnet(X, y)
  s_mid <- fit$lambda[min(10L, length(fit$lambda))]
  cf <- as.numeric(coef(fit, s = s_mid))
  stopifnot(length(cf) == p + 1L, all(is.finite(cf)))
  pr <- as.numeric(predict(fit, X, s = s_mid))
  stopifnot(length(pr) == n, all(is.finite(pr)))
})

run_test("lasso recovers the sparse signal", function() {
  fit <- glmnet(X, y)
  # At the smallest path lambda the fit is nearly unpenalized, so the
  # three true effects should show the right sign and rough magnitude.
  cf <- as.numeric(coef(fit, s = min(fit$lambda)))
  stopifnot(cf[2] > 0, cf[3] < 0, cf[4] > 0)
  stopifnot(abs(cf[2] - 3) < 1, abs(cf[3] - (-2)) < 1, abs(cf[4] - 1.5) < 1)
  # The 17 true-zero predictors stay small (noise-level estimates only).
  stopifnot(max(abs(cf[5:(p + 1L)])) < 0.75)
})

run_test("cv.glmnet: cross-validation object", function() {
  set.seed(1234) # fold assignment is random; pin it for determinism
  cvfit <- cv.glmnet(X, y)
  stopifnot(inherits(cvfit, "cv.glmnet"))
  stopifnot(is.finite(cvfit$lambda.min), cvfit$lambda.min > 0)
  stopifnot(is.finite(cvfit$lambda.1se), cvfit$lambda.1se >= cvfit$lambda.min)
  stopifnot(length(cvfit$cvm) == length(cvfit$lambda))
  stopifnot(all(is.finite(cvfit$cvm)))
})

run_test("cv predictions track the simulated response", function() {
  set.seed(1234)
  cvfit <- cv.glmnet(X, y)
  pr <- as.numeric(predict(cvfit, newx = X, s = "lambda.min"))
  stopifnot(length(pr) == n, all(is.finite(pr)))
  # Signal-to-noise is ~15:1, so in-sample correlation must be high.
  stopifnot(cor(pr, y) > 0.8)
})

run_test("binomial lasso: logistic fit and probabilities", function() {
  fit <- glmnet(X, ybin, family = "binomial")
  stopifnot(inherits(fit, "glmnet"))
  cf <- as.numeric(coef(fit, s = min(fit$lambda)))
  stopifnot(length(cf) == p + 1L, all(is.finite(cf)))
  # True effects: +1.5 on X1, -1.5 on X2 -- signs must be recovered.
  stopifnot(cf[2] > 0, cf[3] < 0)
  pr <- as.numeric(predict(fit, X, s = min(fit$lambda), type = "response"))
  stopifnot(length(pr) == n, all(is.finite(pr)))
  stopifnot(all(pr >= 0 & pr <= 1))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all glmnet smoke tests passed\n")
