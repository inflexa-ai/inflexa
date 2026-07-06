#!/usr/bin/env Rscript
# Smoke test for the R `quadprog` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# quadprog itself. Solves small quadratic programs with known closed-form
# optima (including the classic documented example from ?solve.QP) and
# exits 0 only if every check passes, so it can be used as a pass/fail
# library validator:
#
#   Rscript quadprog.R

if (!requireNamespace("quadprog", quietly = TRUE)) {
  cat("FAIL: package 'quadprog' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(quadprog))
cat(sprintf("quadprog version: %s\n", as.character(packageVersion("quadprog"))))

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

run_test("classic ?solve.QP example", function() {
  # minimize -d^T b + 1/2 b^T D b  subject to  A^T b >= b0
  Dmat <- matrix(0, 3, 3)
  diag(Dmat) <- 1
  dvec <- c(0, 5, 0)
  Amat <- matrix(c(-4, -3, 0, 2, 1, 0, 0, -2, 1), 3, 3)
  bvec <- c(-8, 2, 0)
  sol <- solve.QP(Dmat, dvec, Amat, bvec)
  # Documented optimum: b = (10, 22, 44)/21, value = -50/21.
  stopifnot(isTRUE(all.equal(sol$solution,
                             c(0.4761905, 1.0476190, 2.0952381),
                             tolerance = 1e-5)))
  stopifnot(isTRUE(all.equal(sol$value, -2.380952, tolerance = 1e-5)))
  # With D = I the unconstrained optimum of 1/2 b'b - d'b is b = dvec.
  stopifnot(isTRUE(all.equal(sol$unconstrained.solution, dvec,
                             tolerance = 1e-6)))
  # Feasibility: every constraint holds at the solution (small slack for fp).
  stopifnot(all(crossprod(Amat, sol$solution) - bvec >= -1e-8))
  # Constraints 2 and 3 are active at the optimum, with multipliers 5/21
  # and 44/21 (constraint 1 is slack, so its multiplier is 0).
  stopifnot(length(sol$iact) == 2L, all(sort(sol$iact) == c(2, 3)))
  stopifnot(isTRUE(all.equal(sol$Lagrangian, c(0, 5 / 21, 44 / 21),
                             tolerance = 1e-5)))
})

run_test("inactive constraints recover the unconstrained optimum", function() {
  # With D = I and a constraint far from the optimum, the QP reduces to
  # minimizing 1/2 b'b - d'b, whose minimum is b = dvec.
  Dmat <- diag(2)
  dvec <- c(1, 2)
  Amat <- matrix(c(1, 0), 2, 1) # b1 >= -100: never active
  bvec <- -100
  sol <- solve.QP(Dmat, dvec, Amat, bvec)
  stopifnot(isTRUE(all.equal(sol$solution, c(1, 2), tolerance = 1e-6)))
  stopifnot(isTRUE(all.equal(sol$value, -2.5, tolerance = 1e-6)))
  stopifnot(isTRUE(all.equal(sol$unconstrained.solution, c(1, 2),
                             tolerance = 1e-6)))
})

run_test("equality constraint via meq", function() {
  # minimize 1/2 (b1^2 + b2^2)  subject to  b1 + b2 = 1  =>  b = (0.5, 0.5)
  Dmat <- diag(2)
  dvec <- c(0, 0)
  Amat <- matrix(c(1, 1), 2, 1)
  bvec <- 1
  sol <- solve.QP(Dmat, dvec, Amat, bvec, meq = 1)
  stopifnot(isTRUE(all.equal(sol$solution, c(0.5, 0.5), tolerance = 1e-6)))
  stopifnot(isTRUE(all.equal(sol$value, 0.25, tolerance = 1e-6)))
  stopifnot(abs(sum(sol$solution) - 1) < 1e-8) # equality holds exactly
  stopifnot(isTRUE(all.equal(as.numeric(sol$Lagrangian), 0.5,
                             tolerance = 1e-6)))
})

run_test("result structure and compact interface", function() {
  sol <- solve.QP(diag(2), c(0, 0), matrix(c(1, 0), 2, 1), 0)
  stopifnot(all(c("solution", "value", "unconstrained.solution",
                  "iterations", "Lagrangian", "iact") %in% names(sol)))
  stopifnot(all(abs(sol$solution) < 1e-8)) # optimum at the origin
  # The sparse-storage variant exists too; the standard dense interface
  # exercised above is the canonical API surface.
  stopifnot(is.function(solve.QP.compact))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all quadprog smoke tests passed\n")
