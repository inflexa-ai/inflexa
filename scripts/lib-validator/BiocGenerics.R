#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `BiocGenerics` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# BiocGenerics itself (and the base packages it attaches). BiocGenerics is the
# S4 generics hub for Bioconductor, so this exercises that a representative set
# of generics exist, are true S4 generics, and dispatch to their base-vector
# default methods with the expected values. Exits 0 only if every check passes,
# so it can be used as a pass/fail library validator:
#
#   Rscript BiocGenerics.R

if (!requireNamespace("BiocGenerics", quietly = TRUE)) {
  cat("FAIL: package 'BiocGenerics' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(BiocGenerics))
cat(sprintf("BiocGenerics version: %s\n", as.character(packageVersion("BiocGenerics"))))

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

run_test("set-operation generics exist", function() {
  stopifnot(isGeneric("union"), isGeneric("intersect"), isGeneric("setdiff"))
  stopifnot(existsFunction("combine"))
})

run_test("union/intersect/setdiff dispatch on base vectors", function() {
  stopifnot(identical(BiocGenerics::union(c(1, 2), c(2, 3)), c(1, 2, 3)))
  stopifnot(identical(BiocGenerics::intersect(c(1, 2, 3), c(2, 3, 4)), c(2, 3)))
  stopifnot(identical(BiocGenerics::setdiff(c(1, 2, 3), c(2)), c(1, 3)))
})

run_test("rbind/cbind are generics", function() {
  stopifnot(isGeneric("rbind"), isGeneric("cbind"))
  stopifnot(is.function(BiocGenerics::rbind), is.function(BiocGenerics::cbind))
  m <- BiocGenerics::rbind(c(1L, 2L), c(3L, 4L))
  stopifnot(is.matrix(m), identical(dim(m), c(2L, 2L)))
  stopifnot(identical(as.vector(m), c(1L, 3L, 2L, 4L)))
})

run_test("unique and duplicated generics", function() {
  stopifnot(isGeneric("unique"), isGeneric("duplicated"))
  stopifnot(identical(BiocGenerics::unique(c(1L, 1L, 2L, 3L, 3L)), c(1L, 2L, 3L)))
  stopifnot(identical(BiocGenerics::duplicated(c(1L, 1L, 2L)), c(FALSE, TRUE, FALSE)))
})

run_test("table generic tallies base vectors", function() {
  stopifnot(isGeneric("table"))
  tab <- BiocGenerics::table(c("a", "a", "b"))
  stopifnot(identical(as.integer(tab[["a"]]), 2L), identical(as.integer(tab[["b"]]), 1L))
})

run_test("apply-family generics are exported", function() {
  stopifnot(existsFunction("lapply"), existsFunction("sapply"), existsFunction("mapply"))
  stopifnot(isGeneric("lapply"), isGeneric("sapply"))
})

run_test("nrow/ncol generics exist and dispatch", function() {
  stopifnot(isGeneric("nrow"), isGeneric("ncol"))
  m <- matrix(1:6, nrow = 2, ncol = 3)
  stopifnot(BiocGenerics::nrow(m) == 2L, BiocGenerics::ncol(m) == 3L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all BiocGenerics smoke tests passed\n")
