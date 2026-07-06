#!/usr/bin/env Rscript
# Smoke test for the R `yaml` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# yaml itself. Exercises the core API surface and exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript yaml.R

if (!requireNamespace("yaml", quietly = TRUE)) {
  cat("FAIL: package 'yaml' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(yaml))
cat(sprintf("yaml version: %s\n", as.character(packageVersion("yaml"))))

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

run_test("as.yaml/yaml.load roundtrip of a named list", function() {
  x <- list(
    name = "smoke",
    count = 3L,
    ratio = 1.5,
    enabled = TRUE,
    tags = c("a", "b")
  )
  back <- yaml.load(as.yaml(x))
  stopifnot(identical(back, x))
})

run_test("yaml.load literal multi-line document", function() {
  doc <- "server:\n  host: localhost\n  port: 8080\n  debug: true\nfeatures:\n  - alpha\n  - beta\n"
  x <- yaml.load(doc)
  stopifnot(identical(names(x), c("server", "features")))
  stopifnot(identical(x$server, list(host = "localhost", port = 8080L, debug = TRUE)))
  stopifnot(identical(x$features, c("alpha", "beta")))
})

run_test("sequences: uniform -> vector, mixed -> list", function() {
  stopifnot(identical(yaml.load("[1, 2, 3]"), c(1L, 2L, 3L)))
  stopifnot(identical(yaml.load("[a, b]"), c("a", "b")))
  stopifnot(identical(yaml.load("[1, two, true]"), list(1L, "two", TRUE)))
})

run_test("scalar types parse to correct R types", function() {
  stopifnot(identical(yaml.load("42"), 42L))
  stopifnot(identical(yaml.load("3.5"), 3.5))
  stopifnot(identical(yaml.load("true"), TRUE))
  stopifnot(identical(yaml.load("no"), FALSE))
  stopifnot(identical(yaml.load("hello"), "hello"))
  stopifnot(is.null(yaml.load("~")))
})

run_test("custom type handlers", function() {
  # handlers receive the RAW scalar string, not a parsed value: convert explicitly
  x <- yaml.load("count: 5", handlers = list(int = function(v) as.integer(v) + 1L))
  stopifnot(identical(x, list(count = 6L)))
  # the str handler is applied to map KEYS too, not just values
  y <- yaml.load("word: hi", handlers = list(str = function(v) toupper(v)))
  stopifnot(identical(y, list(WORD = "HI")))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all yaml smoke tests passed\n")
