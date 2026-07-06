#!/usr/bin/env Rscript
# Smoke test for the R `Rcpp` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# Rcpp itself. Exercises the core API surface -- including inline C++
# compilation, which needs a working R build toolchain (a C++ compiler) --
# and exits 0 only if every check passes, so it can be used as a pass/fail
# library validator:
#
#   Rscript Rcpp.R

if (!requireNamespace("Rcpp", quietly = TRUE)) {
  cat("FAIL: package 'Rcpp' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(Rcpp))
cat(sprintf("Rcpp version: %s\n", as.character(packageVersion("Rcpp"))))

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

run_test("evalCpp arithmetic", function() {
  stopifnot(Rcpp::evalCpp("1 + 1") == 2)
  stopifnot(Rcpp::evalCpp("2 * 21") == 42)
})

run_test("cppFunction compiles and runs (scalar)", function() {
  Rcpp::cppFunction("int add(int a, int b) { return a + b; }")
  stopifnot(add(2L, 3L) == 5L)
  stopifnot(add(-4L, 4L) == 0L)
})

run_test("cppFunction with NumericVector", function() {
  Rcpp::cppFunction("
    double vsum(NumericVector x) {
      double total = 0.0;
      for (int i = 0; i < x.size(); ++i) total += x[i];
      return total;
    }
  ")
  stopifnot(isTRUE(all.equal(vsum(c(1, 2, 3, 4)), 10)))
  stopifnot(isTRUE(all.equal(vsum(as.numeric(1:100)), 5050)))
})

run_test("sourceCpp from literal code", function() {
  Rcpp::sourceCpp(code = "
    #include <Rcpp.h>
    using namespace Rcpp;
    // [[Rcpp::export]]
    int mult(int a, int b) { return a * b; }
  ")
  stopifnot(mult(6L, 7L) == 42L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all Rcpp smoke tests passed\n")
