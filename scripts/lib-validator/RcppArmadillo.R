#!/usr/bin/env Rscript
# Smoke test for the R `RcppArmadillo` package.
#
# Fully self-contained: no input files, no network. Exercises the core API
# surface -- including inline C++ compilation against the Armadillo headers,
# which needs a working R build toolchain (a C++ compiler). `Rcpp::sourceCpp`
# is available because RcppArmadillo hard-depends on Rcpp. Exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript RcppArmadillo.R

if (!requireNamespace("RcppArmadillo", quietly = TRUE)) {
  cat("FAIL: package 'RcppArmadillo' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(RcppArmadillo))
cat(sprintf("RcppArmadillo version: %s\n", as.character(packageVersion("RcppArmadillo"))))

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

run_test("armadillo_version reports major/minor/patch", function() {
  v <- RcppArmadillo::armadillo_version(single = FALSE)
  stopifnot(all(c("major", "minor", "patch") %in% names(v)))
  stopifnot(as.integer(v[["major"]]) >= 1L)
})

run_test("sourceCpp with Armadillo: matrix multiply", function() {
  Rcpp::sourceCpp(code = "
    // [[Rcpp::depends(RcppArmadillo)]]
    #include <RcppArmadillo.h>
    using namespace Rcpp;
    // [[Rcpp::export]]
    arma::mat mat_mult(const arma::mat& a, const arma::mat& b) {
      return a * b;
    }
  ")
  a <- matrix(c(1, 2, 3, 4), 2, 2)
  b <- matrix(c(5, 6, 7, 8), 2, 2)
  stopifnot(isTRUE(all.equal(mat_mult(a, b), a %*% b, tolerance = 1e-9)))
})

run_test("sourceCpp with Armadillo: solve linear system", function() {
  Rcpp::sourceCpp(code = "
    // [[Rcpp::depends(RcppArmadillo)]]
    #include <RcppArmadillo.h>
    using namespace Rcpp;
    // [[Rcpp::export]]
    arma::vec arma_solve(const arma::mat& A, const arma::vec& b) {
      return arma::solve(A, b);
    }
  ")
  # A = diag(2, 4); solving A x = (2, 8) gives x = (1, 2).
  A <- matrix(c(2, 0, 0, 4), 2, 2)
  b <- c(2, 8)
  x <- arma_solve(A, b)
  stopifnot(isTRUE(all.equal(as.numeric(x), c(1, 2), tolerance = 1e-9)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all RcppArmadillo smoke tests passed\n")
