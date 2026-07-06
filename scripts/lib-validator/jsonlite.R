#!/usr/bin/env Rscript
# Smoke test for the R `jsonlite` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# jsonlite itself. Exercises the core API surface and exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript jsonlite.R

if (!requireNamespace("jsonlite", quietly = TRUE)) {
  cat("FAIL: package 'jsonlite' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(jsonlite))
cat(sprintf("jsonlite version: %s\n", as.character(packageVersion("jsonlite"))))

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

run_test("toJSON/fromJSON data.frame roundtrip (dataframe=\"rows\")", function() {
  df <- data.frame(id = 1:2, name = c("a", "b"), stringsAsFactors = FALSE)
  json <- toJSON(df, dataframe = "rows")
  stopifnot(identical(as.character(json), '[{"id":1,"name":"a"},{"id":2,"name":"b"}]'))
  back <- fromJSON(as.character(json))
  stopifnot(is.data.frame(back), nrow(back) == 2L)
  stopifnot(identical(back$id, c(1L, 2L)))
  stopifnot(identical(back$name, c("a", "b")))
})

run_test("auto_unbox scalar behavior", function() {
  stopifnot(identical(as.character(toJSON("hi")), '["hi"]'))
  stopifnot(identical(as.character(toJSON("hi", auto_unbox = TRUE)), '"hi"'))
  stopifnot(identical(
    as.character(toJSON(list(name = "x", n = 1L), auto_unbox = TRUE)),
    '{"name":"x","n":1}'
  ))
  stopifnot(identical(
    as.character(toJSON(list(name = "x", n = 1L))),
    '{"name":["x"],"n":[1]}'
  ))
})

run_test("fromJSON literal string into list", function() {
  x <- fromJSON('{"a": 1, "b": [1, 2, 3], "c": "x"}')
  stopifnot(is.list(x), identical(names(x), c("a", "b", "c")))
  stopifnot(identical(x$a, 1L))
  stopifnot(identical(x$b, c(1L, 2L, 3L)))
  stopifnot(identical(x$c, "x"))
  y <- fromJSON('{"a": 1, "b": [1, 2, 3]}', simplifyVector = FALSE)
  stopifnot(identical(y, list(a = 1L, b = list(1L, 2L, 3L))))
})

run_test("prettify and minify", function() {
  json <- '{"a": 1, "b": [true, null], "c": "x"}'
  stopifnot(identical(as.character(minify(json)), '{"a":1,"b":[true,null],"c":"x"}'))
  pretty <- prettify(json)
  stopifnot(grepl("\n", as.character(pretty), fixed = TRUE))
  stopifnot(identical(as.character(minify(pretty)), as.character(minify(json))))
})

run_test("serializeJSON/unserializeJSON roundtrip", function() {
  obj <- list(x = 1:3, y = "hello", z = c(TRUE, FALSE), w = c(1.5, NA))
  back <- unserializeJSON(serializeJSON(obj))
  stopifnot(identical(back, obj))
  df <- data.frame(a = 1:2, b = c("p", "q"), stringsAsFactors = FALSE)
  stopifnot(identical(unserializeJSON(serializeJSON(df)), df))
})

run_test("null and NA handling", function() {
  stopifnot(is.null(fromJSON("null")))
  # default NA encoding for bare vectors is the string "NA"; na = "null" opts into JSON null
  stopifnot(identical(as.character(toJSON(c(1L, NA, 3L))), '[1,"NA",3]'))
  stopifnot(identical(as.character(toJSON(c(1L, NA, 3L), na = "null")), "[1,null,3]"))
  stopifnot(identical(fromJSON("[1, null, 3]"), c(1L, NA, 3L)))
  stopifnot(identical(fromJSON("[true, null]"), c(TRUE, NA)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all jsonlite smoke tests passed\n")
