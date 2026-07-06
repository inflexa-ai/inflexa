#!/usr/bin/env Rscript
# Smoke test for the R `openxlsx2` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# openxlsx2 itself. Roundtrips a data frame through a tempfile workbook
# (cleaned up on exit) and exits 0 only if every check passes, so it can
# be used as a pass/fail library validator:
#
#   Rscript openxlsx2.R

if (!requireNamespace("openxlsx2", quietly = TRUE)) {
  cat("FAIL: package 'openxlsx2' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(openxlsx2))
cat(sprintf("openxlsx2 version: %s\n", as.character(packageVersion("openxlsx2"))))

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

run_test("workbook save/read_xlsx roundtrip via tempfile", function() {
  df <- data.frame(a = 1:3, b = c("x", "y", "z"), stringsAsFactors = FALSE)
  # openxlsx2's chaining API: wbWorkbook methods return the workbook.
  wb <- wb_workbook()$add_worksheet("s1")$add_data(x = df)
  tmp <- tempfile("openxlsx2-smoke-", fileext = ".xlsx")
  on.exit(unlink(tmp), add = TRUE)
  wb_save(wb, tmp)
  stopifnot(file.exists(tmp), file.size(tmp) > 0)
  back <- read_xlsx(tmp)
  stopifnot(nrow(back) == 3L, ncol(back) == 2L)
  stopifnot(identical(names(back), c("a", "b")))
  stopifnot(isTRUE(all.equal(as.numeric(back$a), c(1, 2, 3))))
  stopifnot(identical(as.character(back$b), c("x", "y", "z")))
})

run_test("wb_to_df reads back from the in-memory workbook", function() {
  df <- data.frame(a = 1:3, b = c("x", "y", "z"), stringsAsFactors = FALSE)
  # Same pipeline through the functional (non-chaining) API surface.
  wb <- wb_workbook()
  wb <- wb_add_worksheet(wb, "s1")
  wb <- wb_add_data(wb, sheet = "s1", x = df)
  back <- wb_to_df(wb, sheet = "s1")
  stopifnot(nrow(back) == 3L, ncol(back) == 2L)
  stopifnot(identical(names(back), c("a", "b")))
  stopifnot(isTRUE(all.equal(as.numeric(back$a), c(1, 2, 3))))
  stopifnot(identical(as.character(back$b), c("x", "y", "z")))
})

run_test("sheet names are tracked", function() {
  wb <- wb_workbook()$add_worksheet("first")$add_worksheet("second")
  stopifnot(identical(unname(wb_get_sheet_names(wb)), c("first", "second")))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all openxlsx2 smoke tests passed\n")
