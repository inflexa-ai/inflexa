#!/usr/bin/env Rscript
# Smoke test for the R `rlang` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# rlang itself. Exercises the core API surface and exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript rlang.R

if (!requireNamespace("rlang", quietly = TRUE)) {
  cat("FAIL: package 'rlang' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(rlang))
cat(sprintf("rlang version: %s\n", as.character(packageVersion("rlang"))))

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

run_test("quo + eval_tidy", function() {
  stopifnot(identical(rlang::eval_tidy(rlang::quo(1 + 2)), 3))
  q <- rlang::quo(x * 10)
  stopifnot(identical(rlang::eval_tidy(q, data = list(x = 4)), 40))
})

run_test("expr / sym / syms", function() {
  e <- rlang::expr(a + b)
  stopifnot(identical(e, quote(a + b)))
  s <- rlang::sym("foo")
  stopifnot(identical(s, quote(foo)))
  stopifnot(identical(rlang::syms(c("a", "b")), list(quote(a), quote(b))))
})

run_test("!! injection with eval_tidy", function() {
  col <- rlang::sym("foo")
  e <- rlang::expr(!!col + 1)
  stopifnot(identical(rlang::eval_tidy(e, data = list(foo = 41)), 42))
  val <- 10
  stopifnot(identical(rlang::eval_tidy(rlang::quo(!!val * 2)), 20))
})

run_test("set_names", function() {
  named <- rlang::set_names(1:3, c("a", "b", "c"))
  stopifnot(identical(named, c(a = 1L, b = 2L, c = 3L)))
  self_named <- rlang::set_names(c("x", "y"))
  stopifnot(identical(self_named, c(x = "x", y = "y")))
})

run_test("%||% null-default operator", function() {
  stopifnot(identical(NULL %||% 5, 5))
  stopifnot(identical("kept" %||% "fallback", "kept"))
})

run_test("type predicates", function() {
  stopifnot(isTRUE(rlang::is_empty(list())))
  stopifnot(isFALSE(rlang::is_empty(list(1))))
  stopifnot(isTRUE(rlang::is_null(NULL)))
  stopifnot(isFALSE(rlang::is_null(NA)))
  stopifnot(isTRUE(rlang::is_string("one")))
  stopifnot(isFALSE(rlang::is_string(c("two", "strings"))))
  stopifnot(isFALSE(rlang::is_string(1)))
})

run_test("list2 with !!! splice via tidy dots", function() {
  collect <- function(...) rlang::list2(...)
  extras <- list(b = 2, c = 3)
  got <- collect(a = 1, !!!extras)
  stopifnot(identical(got, list(a = 1, b = 2, c = 3)))
})

run_test("inject and call2 build + evaluate", function() {
  stopifnot(identical(rlang::inject(sum(!!!list(1, 2, 3))), 6))
  cl <- rlang::call2("sum", 1, 2, 3)
  stopifnot(identical(cl, quote(sum(1, 2, 3))))
  stopifnot(identical(rlang::eval_tidy(cl), 6))
  stopifnot(identical(rlang::exec("paste", "a", "b", sep = "-"), "a-b"))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all rlang smoke tests passed\n")
