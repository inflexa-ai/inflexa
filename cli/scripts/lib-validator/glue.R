#!/usr/bin/env Rscript
# Smoke test for the R `glue` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# glue itself. Exercises the core API surface and exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript glue.R

if (!requireNamespace("glue", quietly = TRUE)) {
  cat("FAIL: package 'glue' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(glue))
cat(sprintf("glue version: %s\n", as.character(packageVersion("glue"))))

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

run_test("basic interpolation with local variables", function() {
  name <- "world"
  n <- 2L
  stopifnot(identical(as.character(glue("hello {name}!")), "hello world!"))
  stopifnot(identical(as.character(glue("{n} + {n} = {n + n}")), "2 + 2 = 4"))
})

run_test("interpolation via .envir", function() {
  e <- new.env(parent = emptyenv())
  assign("x", 42L, envir = e)
  assign("who", "env", envir = e)
  stopifnot(identical(as.character(glue("x is {x} from {who}", .envir = e)), "x is 42 from env"))
})

run_test("vectorized interpolation and recycling", function() {
  v <- c("a", "b", "c")
  stopifnot(identical(as.character(glue("{v}-{1:3}")), c("a-1", "b-2", "c-3")))
  # length-1 recycles against length-2
  stopifnot(identical(as.character(glue("{c('x', 'y')}{1L}")), c("x1", "y1")))
})

run_test("glue_data over a list and a data.frame", function() {
  d <- list(a = "foo", b = 1:2)
  stopifnot(identical(as.character(glue_data(d, "{a}{b}")), c("foo1", "foo2")))
  df <- data.frame(x = c("p", "q"), y = c(1L, 2L), stringsAsFactors = FALSE)
  stopifnot(identical(as.character(glue_data(df, "{x}={y}")), c("p=1", "q=2")))
})

run_test("glue_collapse with sep and last", function() {
  stopifnot(identical(
    as.character(glue_collapse(c("a", "b", "c"), sep = ", ", last = " and ")),
    "a, b and c"
  ))
  stopifnot(identical(as.character(glue_collapse(1:4, sep = "-")), "1-2-3-4"))
})

run_test("literal braces and custom delimiters", function() {
  a <- 1L
  stopifnot(identical(as.character(glue("{{a}} = {a}")), "{a} = 1"))
  stopifnot(identical(
    as.character(glue("<x> + <y> = {kept}", x = 1L, y = 2L, .open = "<", .close = ">")),
    "1 + 2 = {kept}"
  ))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all glue smoke tests passed\n")
