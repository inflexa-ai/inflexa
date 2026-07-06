#!/usr/bin/env Rscript
# Smoke test for the R `readr` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# readr itself. All I/O is in-memory (literal strings via I()); exercises
# the core API surface and exits 0 only if every check passes, so it can
# be used as a pass/fail library validator:
#
#   Rscript readr.R

if (!requireNamespace("readr", quietly = TRUE)) {
  cat("FAIL: package 'readr' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(readr))
cat(sprintf("readr version: %s\n", as.character(packageVersion("readr"))))

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

run_test("read_csv from literal string", function() {
  df <- suppressMessages(read_csv(I("a,b\n1,x\n2,y\n"), show_col_types = FALSE))
  stopifnot(identical(names(df), c("a", "b")))
  stopifnot(identical(nrow(df), 2L))
  stopifnot(identical(df$a, c(1, 2)))
  stopifnot(identical(df$b, c("x", "y")))
})

run_test("format_csv / read_csv roundtrip", function() {
  df <- suppressMessages(read_csv(I("a,b\n1,x\n2,y\n"), show_col_types = FALSE))
  csv <- format_csv(df)
  stopifnot(identical(csv, "a,b\n1,x\n2,y\n"))
  back <- suppressMessages(read_csv(I(csv), show_col_types = FALSE))
  stopifnot(identical(back$a, df$a), identical(back$b, df$b))
})

run_test("read_tsv from literal string", function() {
  df <- suppressMessages(read_tsv(I("a\tb\n1\tx\n2\ty\n"), show_col_types = FALSE))
  stopifnot(identical(names(df), c("a", "b")))
  stopifnot(identical(df$a, c(1, 2)))
  stopifnot(identical(df$b, c("x", "y")))
})

run_test("parse_number strips formatting", function() {
  stopifnot(identical(parse_number("$1,234.5"), 1234.5))
  stopifnot(identical(parse_number(c("50%", "-3.5")), c(50, -3.5)))
})

run_test("parse_date and parse_logical", function() {
  stopifnot(identical(parse_date("2020-01-02"), as.Date("2020-01-02")))
  stopifnot(identical(parse_logical(c("TRUE", "FALSE", "T", "F")), c(TRUE, FALSE, TRUE, FALSE)))
})

run_test("explicit col_types are honored", function() {
  df <- read_csv(I("a,b\n1,x\n2,y\n"), col_types = cols(a = col_integer(), b = col_character()))
  stopifnot(identical(df$a, c(1L, 2L)))
  stopifnot(identical(df$b, c("x", "y")))
})

run_test("type_convert re-guesses character columns", function() {
  df <- data.frame(x = c("1", "2"), y = c("a", "b"), stringsAsFactors = FALSE)
  tc <- suppressMessages(type_convert(df))
  stopifnot(identical(tc$x, c(1, 2)))
  stopifnot(identical(tc$y, c("a", "b")))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all readr smoke tests passed\n")
