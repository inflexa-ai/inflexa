#!/usr/bin/env Rscript
# Smoke test for the R `reshape2` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# reshape2 itself (plus its implied deps). Exercises the core melt/cast API on
# a small in-memory data frame and exits 0 only if every check passes, so it
# can be used as a pass/fail library validator:
#
#   Rscript reshape2.R

if (!requireNamespace("reshape2", quietly = TRUE)) {
  cat("FAIL: package 'reshape2' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(reshape2))
cat(sprintf("reshape2 version: %s\n", as.character(packageVersion("reshape2"))))

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

wide_df <- function() {
  data.frame(id = 1:3, x = c(10, 20, 30), y = c(40, 50, 60))
}

run_test("melt turns wide into long", function() {
  df <- wide_df()
  long <- reshape2::melt(df, id.vars = "id")
  # n rows * measured columns: 3 ids * 2 measures (x, y) = 6.
  stopifnot(nrow(long) == 3L * 2L)
  stopifnot(all(c("id", "variable", "value") %in% names(long)))
  stopifnot(setequal(as.character(unique(long$variable)), c("x", "y")))
  stopifnot(setequal(long$value, c(10, 20, 30, 40, 50, 60)))
})

run_test("dcast reconstructs the wide frame exactly", function() {
  df <- wide_df()
  long <- reshape2::melt(df, id.vars = "id")
  wide2 <- reshape2::dcast(long, id ~ variable, value.var = "value")
  stopifnot(identical(wide2$id, df$id))
  stopifnot(identical(wide2$x, df$x))
  stopifnot(identical(wide2$y, df$y))
  stopifnot(isTRUE(all.equal(df, wide2, check.attributes = FALSE)))
})

run_test("acast returns a matrix of the right dims", function() {
  df <- wide_df()
  long <- reshape2::melt(df, id.vars = "id")
  m <- reshape2::acast(long, id ~ variable, value.var = "value")
  stopifnot(is.matrix(m))
  stopifnot(identical(dim(m), c(3L, 2L)))
  stopifnot(setequal(colnames(m), c("x", "y")))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all reshape2 smoke tests passed\n")
