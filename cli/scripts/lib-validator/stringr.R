#!/usr/bin/env Rscript
# Smoke test for the R `stringr` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# stringr itself. Exercises the core API surface and exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript stringr.R

if (!requireNamespace("stringr", quietly = TRUE)) {
  cat("FAIL: package 'stringr' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(stringr))
cat(sprintf("stringr version: %s\n", as.character(packageVersion("stringr"))))

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

run_test("str_detect and str_extract", function() {
  stopifnot(identical(str_detect(c("apple", "banana"), "an"), c(FALSE, TRUE)))
  stopifnot(identical(str_extract("abc123def", "\\d+"), "123"))
  stopifnot(identical(str_extract_all("a1b22c333", "\\d+")[[1]], c("1", "22", "333")))
})

run_test("str_replace and str_replace_all", function() {
  stopifnot(identical(str_replace("aaa", "a", "b"), "baa"))
  stopifnot(identical(str_replace_all("aaa", "a", "b"), "bbb"))
  stopifnot(identical(str_replace_all("x1y2", "\\d", "#"), "x#y#"))
})

run_test("str_split returns a list", function() {
  parts <- str_split("a,b,c", ",")
  stopifnot(is.list(parts), identical(length(parts), 1L))
  stopifnot(identical(parts[[1]], c("a", "b", "c")))
  stopifnot(identical(str_split(c("a-b", "c-d-e"), "-"), list(c("a", "b"), c("c", "d", "e"))))
})

run_test("str_c and str_flatten", function() {
  stopifnot(identical(str_c("a", "b", sep = "-"), "a-b"))
  stopifnot(identical(str_c(c("x", "y"), 1:2), c("x1", "y2")))
  stopifnot(identical(str_flatten(c("a", "b", "c"), collapse = "+"), "a+b+c"))
})

run_test("str_pad, str_trim, str_squish", function() {
  stopifnot(identical(str_pad("7", 3, pad = "0"), "007"))
  stopifnot(identical(str_pad("ab", 4, side = "right", pad = "."), "ab.."))
  stopifnot(identical(str_trim("  x  "), "x"))
  stopifnot(identical(str_squish("  a   b  "), "a b"))
})

run_test("case conversion and str_length", function() {
  stopifnot(identical(str_to_upper("abc"), "ABC"))
  stopifnot(identical(str_to_title("hello world"), "Hello World"))
  stopifnot(identical(str_length(c("a", "abc", "")), c(1L, 3L, 0L)))
})

run_test("str_match captures regex groups", function() {
  m <- str_match("2020-01-02", "(\\d{4})-(\\d{2})-(\\d{2})")
  stopifnot(identical(dim(m), c(1L, 4L)))
  stopifnot(identical(m[1, 1], "2020-01-02"))
  stopifnot(identical(m[1, 2], "2020"))
  stopifnot(identical(m[1, 3], "01"))
  stopifnot(identical(m[1, 4], "02"))
})

run_test("str_sub extraction and negative indexing", function() {
  stopifnot(identical(str_sub("abcdef", 2, 4), "bcd"))
  stopifnot(identical(str_sub("abcdef", -3), "def"))
  x <- "abcdef"
  str_sub(x, 1, 1) <- "Z"
  stopifnot(identical(x, "Zbcdef"))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all stringr smoke tests passed\n")
