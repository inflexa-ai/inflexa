#!/usr/bin/env Rscript
# Smoke test for the R `CVXR` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# CVXR itself. Solves small convex problems with known analytic optima and
# exits 0 only if every check passes, so it can be used as a pass/fail
# library validator:
#
#   Rscript CVXR.R

if (!requireNamespace("CVXR", quietly = TRUE)) {
  cat("FAIL: package 'CVXR' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(CVXR))
cat(sprintf("CVXR version: %s\n", as.character(packageVersion("CVXR"))))

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

run_test("least squares recovers analytic solution", function() {
  # A %*% c(1, 2) == b exactly, so the optimum is 0 attained at x = (1, 2).
  A <- rbind(c(1, 0), c(0, 1), c(1, 1))
  b <- c(1, 2, 3)
  x <- Variable(2)
  prob <- Problem(Minimize(sum_squares(A %*% x - b)))
  # suppressMessages: CVXR prints a once-per-session future-API notice;
  # suppressWarnings: solver/deprecation chatter. Errors still propagate.
  res <- suppressMessages(suppressWarnings(solve(prob)))
  stopifnot(identical(res$status, "optimal"))
  stopifnot(is.finite(res$value))
  stopifnot(isTRUE(all.equal(res$value, 0, tolerance = 1e-4)))
  xhat <- as.numeric(suppressWarnings(res$getValue(x)))
  stopifnot(isTRUE(all.equal(xhat, c(1, 2), tolerance = 1e-4)))
})

run_test("constrained LP hits known vertex optimum", function() {
  # minimize x1 + 2*x2 over the simplex {x >= 0, sum(x) == 1}:
  # the optimum is the vertex x = (1, 0) with value 1.
  y <- Variable(2)
  cost <- c(1, 2)
  prob <- Problem(Minimize(t(cost) %*% y), list(y >= 0, sum(y) == 1))
  # suppressMessages: CVXR prints a once-per-session future-API notice;
  # suppressWarnings: solver/deprecation chatter. Errors still propagate.
  res <- suppressMessages(suppressWarnings(solve(prob)))
  stopifnot(identical(res$status, "optimal"))
  stopifnot(is.finite(res$value))
  stopifnot(isTRUE(all.equal(res$value, 1, tolerance = 1e-4)))
  yhat <- as.numeric(suppressWarnings(res$getValue(y)))
  stopifnot(isTRUE(all.equal(yhat, c(1, 0), tolerance = 1e-4)))
})

run_test("nonnegative QP with an active constraint", function() {
  # minimize ||x - (3, -2)||^2 s.t. x >= 0: the projection onto the
  # nonnegative orthant is x = (3, 0) with value (-2)^2 = 4.
  z <- Variable(2)
  prob <- Problem(Minimize(sum_squares(z - c(3, -2))), list(z >= 0))
  # suppressMessages: CVXR prints a once-per-session future-API notice;
  # suppressWarnings: solver/deprecation chatter. Errors still propagate.
  res <- suppressMessages(suppressWarnings(solve(prob)))
  stopifnot(identical(res$status, "optimal"))
  stopifnot(is.finite(res$value))
  stopifnot(isTRUE(all.equal(res$value, 4, tolerance = 1e-4)))
  zhat <- as.numeric(suppressWarnings(res$getValue(z)))
  stopifnot(isTRUE(all.equal(zhat, c(3, 0), tolerance = 1e-4)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all CVXR smoke tests passed\n")
