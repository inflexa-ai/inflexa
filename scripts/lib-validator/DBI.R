#!/usr/bin/env Rscript
# Smoke test for the R `DBI` package.
#
# Fully self-contained: no input files, no network. DBI is an interface,
# so its generics are exercised through the RSQLite driver against
# in-memory databases only (nothing touches disk). Exits 0 only if every
# check passes, so it can be used as a pass/fail library validator:
#
#   Rscript DBI.R

if (!requireNamespace("DBI", quietly = TRUE)) {
  cat("FAIL: package 'DBI' is not installed\n")
  quit(save = "no", status = 1)
}
if (!requireNamespace("RSQLite", quietly = TRUE)) {
  cat("FAIL: package 'RSQLite' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(DBI))
cat(sprintf("DBI version: %s\n", as.character(packageVersion("DBI"))))

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

run_test("connect, dbWriteTable, count", function() {
  con <- dbConnect(RSQLite::SQLite(), ":memory:")
  on.exit(dbDisconnect(con), add = TRUE)
  dbWriteTable(con, "t", data.frame(id = 1:3, v = c("a", "b", "c"), stringsAsFactors = FALSE))
  stopifnot(dbGetQuery(con, "SELECT COUNT(*) AS n FROM t")$n == 3)
})

run_test("dbListTables and dbExistsTable", function() {
  con <- dbConnect(RSQLite::SQLite(), ":memory:")
  on.exit(dbDisconnect(con), add = TRUE)
  dbWriteTable(con, "t", data.frame(id = 1:3))
  stopifnot("t" %in% dbListTables(con))
  stopifnot(isTRUE(dbExistsTable(con, "t")))
  stopifnot(isFALSE(dbExistsTable(con, "missing")))
})

run_test("dbReadTable roundtrips the frame", function() {
  con <- dbConnect(RSQLite::SQLite(), ":memory:")
  on.exit(dbDisconnect(con), add = TRUE)
  df <- data.frame(id = 1:3, v = c("a", "b", "c"), stringsAsFactors = FALSE)
  dbWriteTable(con, "t", df)
  back <- dbReadTable(con, "t")
  stopifnot(nrow(back) == 3L, identical(names(back), c("id", "v")))
  stopifnot(all(back$id == 1:3))
  stopifnot(identical(as.character(back$v), c("a", "b", "c")))
})

run_test("dbExecute reports affected rows", function() {
  con <- dbConnect(RSQLite::SQLite(), ":memory:")
  on.exit(dbDisconnect(con), add = TRUE)
  dbExecute(con, "CREATE TABLE t (id INTEGER, v TEXT)")
  stopifnot(dbExecute(con, "INSERT INTO t VALUES (1, 'a'), (2, 'b')") == 2)
  stopifnot(dbExecute(con, "UPDATE t SET v = 'z' WHERE id = 1") == 1)
  stopifnot(identical(as.character(dbGetQuery(con, "SELECT v FROM t WHERE id = 1")$v), "z"))
})

run_test("dbDisconnect invalidates the connection", function() {
  con <- dbConnect(RSQLite::SQLite(), ":memory:")
  stopifnot(isTRUE(dbIsValid(con)))
  dbDisconnect(con)
  stopifnot(isFALSE(dbIsValid(con)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all DBI smoke tests passed\n")
