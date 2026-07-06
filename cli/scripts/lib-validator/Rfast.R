#!/usr/bin/env Rscript
# Smoke test for the R `Rfast` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# Rfast itself and its implied dependencies (Rcpp et al.). Checks Rfast's
# fast linear-algebra / stats routines against their base R equivalents on
# fixed-seed data, and exits 0 only if every check passes, so it can be
# used as a pass/fail library validator:
#
#   Rscript Rfast.R

if (!requireNamespace("Rfast", quietly = TRUE)) {
  cat("FAIL: package 'Rfast' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(Rfast))
cat(sprintf("Rfast version: %s\n", as.character(packageVersion("Rfast"))))

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

run_test("colmeans matches base colMeans", function() {
  set.seed(42)
  x <- matrix(rnorm(50 * 4), 50, 4)
  cm <- Rfast::colmeans(x)
  stopifnot(length(cm) == 4L)
  stopifnot(isTRUE(all.equal(as.numeric(cm), as.numeric(colMeans(x)),
                             tolerance = 1e-6)))
})

run_test("colVars matches apply(x, 2, var)", function() {
  set.seed(43)
  x <- matrix(rnorm(50 * 4), 50, 4)
  # Rfast::colVars defaults to the SAMPLE variance (n - 1 denominator),
  # i.e. base var(); `std = TRUE` would return standard deviations instead.
  cv <- Rfast::colVars(x)
  stopifnot(isTRUE(all.equal(as.numeric(cv),
                             as.numeric(apply(x, 2, var)),
                             tolerance = 1e-6)))
})

run_test("rowmeans matches base rowMeans", function() {
  set.seed(44)
  x <- matrix(rnorm(50 * 4), 50, 4)
  stopifnot(isTRUE(all.equal(as.numeric(Rfast::rowmeans(x)),
                             as.numeric(rowMeans(x)),
                             tolerance = 1e-6)))
})

run_test("colMedians matches apply(x, 2, median)", function() {
  set.seed(45)
  x <- matrix(rnorm(51 * 4), 51, 4)
  stopifnot(isTRUE(all.equal(as.numeric(Rfast::colMedians(x)),
                             as.numeric(apply(x, 2, median)),
                             tolerance = 1e-6)))
})

run_test("Dist matches base dist", function() {
  set.seed(46)
  x <- matrix(rnorm(20 * 3), 20, 3)
  d <- Rfast::Dist(x)
  stopifnot(is.matrix(d), identical(dim(d), c(20L, 20L)))
  stopifnot(all(abs(diag(d)) < 1e-12))
  stopifnot(isTRUE(all.equal(d, t(d), tolerance = 1e-12))) # symmetric
  stopifnot(isTRUE(all.equal(as.numeric(d),
                             as.numeric(as.matrix(dist(x))),
                             tolerance = 1e-6)))
})

run_test("colSort sorts every column", function() {
  set.seed(47)
  x <- matrix(rnorm(50 * 4), 50, 4)
  s <- Rfast::colSort(x)
  stopifnot(identical(dim(s), dim(x)))
  stopifnot(all(apply(s, 2, function(col) all(diff(col) >= 0))))
  stopifnot(isTRUE(all.equal(as.numeric(s),
                             as.numeric(apply(x, 2, sort)),
                             tolerance = 1e-12)))
})

run_test("med and Var match base median/var", function() {
  set.seed(48)
  # Odd length: the median is an actual sample point, so no midpoint
  # convention can differ between implementations.
  v <- rnorm(101)
  stopifnot(isTRUE(all.equal(as.numeric(Rfast::med(v)), median(v),
                             tolerance = 1e-6)))
  stopifnot(isTRUE(all.equal(as.numeric(Rfast::Var(v)), var(v),
                             tolerance = 1e-6)))
})

run_test("lmfit matches base lm.fit", function() {
  set.seed(49)
  x <- matrix(rnorm(50 * 4), 50, 4)
  X <- cbind(1, x) # lmfit takes the full design matrix: intercept is explicit
  beta_true <- c(2, 1, -1, 0.5, 3)
  y <- as.numeric(X %*% beta_true + rnorm(50, sd = 0.1))
  fit <- Rfast::lmfit(X, y)
  base_fit <- lm.fit(X, y)
  stopifnot(isTRUE(all.equal(as.numeric(fit$be),
                             as.numeric(base_fit$coefficients),
                             tolerance = 1e-6)))
  stopifnot(length(fit$residuals) == 50L)
  stopifnot(isTRUE(all.equal(as.numeric(fit$residuals),
                             as.numeric(base_fit$residuals),
                             tolerance = 1e-6)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all Rfast smoke tests passed\n")
