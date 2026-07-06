#!/usr/bin/env Rscript
# Smoke test for the R `devtools` package.
#
# Fully self-contained and OFFLINE: no input files, no network. devtools is
# mostly a network / package-development workflow toolkit, so only its
# offline, side-effect-free surface is exercised -- the existence of the key
# workflow functions and `session_info()`, which merely inspects the loaded
# namespaces. Nothing is installed, checked, or built. Exits 0 only if every
# check passes, so it can be used as a pass/fail library validator:
#
#   Rscript devtools.R

if (!requireNamespace("devtools", quietly = TRUE)) {
  cat("FAIL: package 'devtools' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(devtools))
cat(sprintf("devtools version: %s\n", as.character(packageVersion("devtools"))))

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

run_test("core workflow functions exist", function() {
  stopifnot(is.function(devtools::install))
  stopifnot(is.function(devtools::check))
  stopifnot(is.function(devtools::test))
  stopifnot(is.function(devtools::load_all))
  stopifnot(is.function(devtools::document))
})

run_test("session_info() returns a session_info object", function() {
  si <- devtools::session_info()
  stopifnot(inherits(si, "session_info"))
  stopifnot(all(c("platform", "packages") %in% names(si)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all devtools smoke tests passed\n")
