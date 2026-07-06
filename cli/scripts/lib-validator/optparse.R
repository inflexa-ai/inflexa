#!/usr/bin/env Rscript
# Smoke test for the R `optparse` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# optparse itself. Parsing runs against FIXED argument vectors (never the
# process's real argv), so it is deterministic. Exits 0 only if every check
# passes, so it can be used as a pass/fail library validator:
#
#   Rscript optparse.R

if (!requireNamespace("optparse", quietly = TRUE)) {
  cat("FAIL: package 'optparse' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(optparse))
cat(sprintf("optparse version: %s\n", as.character(packageVersion("optparse"))))

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

make_parser <- function() {
  option_list <- list(
    optparse::make_option(c("-n", "--num"), type = "integer", default = 1L),
    optparse::make_option(c("-v", "--verbose"), action = "store_true", default = FALSE)
  )
  optparse::OptionParser(option_list = option_list)
}

run_test("integer option and store_true flag parse", function() {
  opts <- optparse::parse_args(make_parser(), args = c("--num", "5", "--verbose"))
  stopifnot(identical(opts$num, 5L))
  stopifnot(isTRUE(opts$verbose))
})

run_test("defaults applied when args are absent", function() {
  opts <- optparse::parse_args(make_parser(), args = character(0))
  stopifnot(identical(opts$num, 1L))
  stopifnot(identical(opts$verbose, FALSE))
})

run_test("positional arguments captured alongside options", function() {
  res <- optparse::parse_args(
    make_parser(),
    args = c("--num", "7", "file1.txt", "file2.txt"),
    positional_arguments = TRUE
  )
  stopifnot(identical(res$options$num, 7L))
  stopifnot(identical(res$args, c("file1.txt", "file2.txt")))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all optparse smoke tests passed\n")
