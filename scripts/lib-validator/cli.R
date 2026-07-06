#!/usr/bin/env Rscript
# Smoke test for the R `cli` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# cli itself. Exercises the core API surface and exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript cli.R

if (!requireNamespace("cli", quietly = TRUE)) {
  cat("FAIL: package 'cli' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(cli))
cat(sprintf("cli version: %s\n", as.character(packageVersion("cli"))))

# Force ANSI color support on: Rscript runs without a TTY, where cli would
# otherwise disable styling and the styled-string tests would be vacuous.
options(cli.num_colors = 256L)

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

run_test("inline interpolation (format_inline)", function() {
  out <- cli::format_inline("value is {toupper('abc')} ok")
  stopifnot(identical(as.character(out), "value is ABC ok"))
  n <- 4L
  stopifnot(identical(as.character(cli::format_inline("got {n} rows")), "got 4 rows"))
})

run_test("ANSI styling + strip roundtrip", function() {
  styled <- cli::col_red("hello")
  # Styling must actually add escape codes, and stripping must recover the text.
  stopifnot(cli::ansi_has_any(styled))
  stopifnot(base::nchar(styled) > 5L)
  stopifnot(identical(as.character(cli::ansi_strip(styled)), "hello"))
  bolded <- cli::style_bold("wide text")
  stopifnot(identical(as.character(cli::ansi_strip(bolded)), "wide text"))
})

run_test("pluralization", function() {
  stopifnot(identical(as.character(cli::pluralize("{1} file{?s}")), "1 file"))
  stopifnot(identical(as.character(cli::pluralize("{3} file{?s}")), "3 files"))
  n <- 0L
  stopifnot(identical(as.character(cli::pluralize("{n} file{?s}")), "0 files"))
})

run_test("ansi_nchar vs base nchar on styled string", function() {
  styled <- cli::col_red("hello")
  stopifnot(identical(cli::ansi_nchar(styled), 5L))
  stopifnot(base::nchar(styled) > cli::ansi_nchar(styled))
  # Unstyled strings agree between the two.
  stopifnot(identical(cli::ansi_nchar("plain"), base::nchar("plain")))
})

run_test("ansi_align pads to width", function() {
  left <- cli::ansi_align("ab", width = 6)
  stopifnot(identical(as.character(left), "ab    "))
  right <- cli::ansi_align("ab", width = 6, align = "right")
  stopifnot(identical(as.character(right), "    ab"))
})

run_test("cli_fmt captures cli output", function() {
  out <- cli::cli_fmt(cli::cli_text("count is {2 + 2}"))
  stopifnot(identical(as.character(cli::ansi_strip(out)), "count is 4"))
})

run_test("cli_vec collapsing", function() {
  v <- cli::cli_vec(c("a", "b", "c"), style = list("vec-last" = " and "))
  out <- cli::format_inline("{v}")
  stopifnot(identical(as.character(cli::ansi_strip(out)), "a, b and c"))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all cli smoke tests passed\n")
