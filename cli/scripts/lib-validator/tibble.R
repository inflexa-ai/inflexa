#!/usr/bin/env Rscript
# Smoke test for the R `tibble` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# tibble itself. Exercises the core API surface and exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript tibble.R

if (!requireNamespace("tibble", quietly = TRUE)) {
  cat("FAIL: package 'tibble' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(tibble))
cat(sprintf("tibble version: %s\n", as.character(packageVersion("tibble"))))

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

run_test("tibble() with tidy eval across columns", function() {
  t <- tibble(a = 1:3, b = a * 2)
  stopifnot(inherits(t, "tbl_df"), inherits(t, "data.frame"))
  stopifnot(identical(dim(t), c(3L, 2L)))
  stopifnot(identical(names(t), c("a", "b")))
  stopifnot(identical(t$a, 1:3))
  stopifnot(identical(t$b, c(2, 4, 6)))
})

run_test("as_tibble from data.frame", function() {
  df <- data.frame(x = 1:2, y = c("p", "q"))
  t <- as_tibble(df)
  stopifnot(inherits(t, "tbl_df"))
  stopifnot(identical(t$x, 1:2))
  stopifnot(identical(t$y, c("p", "q")))
  stopifnot(is_tibble(t), !is_tibble(df))
})

run_test("tribble row-wise construction", function() {
  t <- tribble(
    ~x, ~y,
    1, "a",
    2, "b"
  )
  stopifnot(identical(names(t), c("x", "y")))
  stopifnot(identical(t$x, c(1, 2)))
  stopifnot(identical(t$y, c("a", "b")))
  stopifnot(identical(nrow(t), 2L))
})

run_test("add_row and add_column", function() {
  t <- tibble(a = c(1, 2), b = c("x", "y"))
  t2 <- add_row(t, a = 3, b = "z")
  stopifnot(identical(t2$a, c(1, 2, 3)))
  stopifnot(identical(t2$b, c("x", "y", "z")))
  t3 <- add_column(t, flag = c(TRUE, FALSE))
  stopifnot(identical(names(t3), c("a", "b", "flag")))
  stopifnot(identical(t3$flag, c(TRUE, FALSE)))
})

run_test("enframe/deframe roundtrip", function() {
  v <- c(alpha = 1.5, beta = 2.5)
  e <- enframe(v)
  stopifnot(identical(names(e), c("name", "value")))
  stopifnot(identical(e$name, c("alpha", "beta")))
  stopifnot(identical(e$value, c(1.5, 2.5)))
  stopifnot(identical(deframe(e), v))
})

run_test("single-bracket subsetting keeps tibble", function() {
  t <- tibble(a = 1:3, b = c("x", "y", "z"))
  one_col <- t["a"]
  stopifnot(inherits(one_col, "tbl_df"))
  stopifnot(identical(one_col$a, 1:3))
  stopifnot(identical(t[[2]], c("x", "y", "z")))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all tibble smoke tests passed\n")
