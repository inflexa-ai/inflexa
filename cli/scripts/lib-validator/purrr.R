#!/usr/bin/env Rscript
# Smoke test for the R `purrr` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# purrr itself. Exercises the core API surface and exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript purrr.R

if (!requireNamespace("purrr", quietly = TRUE)) {
  cat("FAIL: package 'purrr' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(purrr))
cat(sprintf("purrr version: %s\n", as.character(packageVersion("purrr"))))

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

run_test("map family with lambda shorthand", function() {
  stopifnot(identical(map(1:3, ~ .x + 1), list(2, 3, 4)))
  stopifnot(identical(map_dbl(1:3, ~ .x * 2), c(2, 4, 6)))
  stopifnot(identical(map_chr(c("a", "b"), toupper), c("A", "B")))
  stopifnot(identical(map_int(list(1:2, 1:5), length), c(2L, 5L)))
})

run_test("map2 and pmap", function() {
  stopifnot(identical(map2(1:3, 4:6, `+`), list(5L, 7L, 9L)))
  stopifnot(identical(map2_chr(c("a", "b"), c("x", "y"), paste0), c("ax", "by")))
  stopifnot(identical(pmap_dbl(list(1:2, 3:4, 5:6), function(a, b, c) a + b + c), c(9, 12)))
})

run_test("reduce", function() {
  stopifnot(identical(reduce(1:5, `+`), 15L))
  stopifnot(identical(reduce(c("a", "b", "c"), paste0), "abc"))
  stopifnot(identical(reduce(1:3, `+`, .init = 10L), 16L))
})

run_test("keep, discard, compact", function() {
  stopifnot(identical(keep(1:5, ~ .x > 3), c(4L, 5L)))
  stopifnot(identical(discard(1:5, ~ .x > 3), c(1L, 2L, 3L)))
  stopifnot(identical(compact(list(a = 1, b = NULL, c = 2)), list(a = 1, c = 2)))
})

run_test("pluck into nested lists", function() {
  x <- list(a = list(b = list(c = 42)))
  stopifnot(identical(pluck(x, "a", "b", "c"), 42))
  stopifnot(is.null(pluck(x, "a", "missing")))
  stopifnot(identical(pluck(x, "a", "missing", .default = -1), -1))
})

run_test("list_rbind combines data frames", function() {
  combined <- list_rbind(list(
    data.frame(a = 1, b = "x"),
    data.frame(a = 2, b = "y")
  ))
  stopifnot(identical(nrow(combined), 2L))
  stopifnot(identical(combined$a, c(1, 2)))
  stopifnot(identical(combined$b, c("x", "y")))
})

run_test("imap sees names", function() {
  stopifnot(identical(
    imap_chr(c(a = 1, b = 2), ~ paste0(.y, .x)),
    c(a = "a1", b = "b2")
  ))
})

run_test("possibly and safely wrap failures", function() {
  safe_log <- safely(log)
  bad <- safe_log("not a number")
  stopifnot(is.null(bad$result), inherits(bad$error, "error"))
  good <- safe_log(exp(1))
  stopifnot(is.null(good$error), abs(good$result - 1) < 1e-12)
  maybe_log <- possibly(log, otherwise = NA_real_)
  stopifnot(identical(maybe_log("nope"), NA_real_))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all purrr smoke tests passed\n")
