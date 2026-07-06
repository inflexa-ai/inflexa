#!/usr/bin/env Rscript
# Smoke test for the R `BiocManager` package.
#
# Fully self-contained and OFFLINE: no input files, no network. Only the
# side-effect-free, non-networked surface is exercised -- `version()` plus
# function-existence/class checks. Networked entry points (`install()`,
# `available()`, `valid()`, `repositories()`) are deliberately NOT called.
# Exits 0 only if every check passes, so it can be used as a pass/fail
# library validator:
#
#   Rscript BiocManager.R

if (!requireNamespace("BiocManager", quietly = TRUE)) {
  cat("FAIL: package 'BiocManager' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(BiocManager))
cat(sprintf("BiocManager version: %s\n", as.character(packageVersion("BiocManager"))))

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

run_test("version() returns a valid Bioconductor version >= 3.0", function() {
  v <- BiocManager::version()
  # package_version objects carry class c("package_version", "numeric_version").
  stopifnot(inherits(v, "numeric_version"))
  stopifnot(length(v) == 1L)
  stopifnot(v >= "3.0")
})

run_test("version() is round-trippable through character", function() {
  v <- BiocManager::version()
  chr <- as.character(v)
  stopifnot(is.character(chr), nzchar(chr))
  stopifnot(numeric_version(chr) == v)
})

run_test("install is a function", function() {
  stopifnot(is.function(BiocManager::install))
})

run_test("valid is a function", function() {
  stopifnot(is.function(BiocManager::valid))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all BiocManager smoke tests passed\n")
