#!/usr/bin/env Rscript
# Smoke test for the R `RSQLite` package.
#
# Fully self-contained: no input files, no network, in-memory databases
# only (nothing touches disk). RSQLite is driven through the DBI generics
# (DBI is a hard dependency of RSQLite). Exits 0 only if every check
# passes, so it can be used as a pass/fail library validator:
#
#   Rscript RSQLite.R

if (!requireNamespace("RSQLite", quietly = TRUE)) {
  cat("FAIL: package 'RSQLite' is not installed\n")
  quit(save = "no", status = 1)
}
if (!requireNamespace("DBI", quietly = TRUE)) {
  cat("FAIL: package 'DBI' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(RSQLite))
suppressPackageStartupMessages(library(DBI))
cat(sprintf("RSQLite version: %s\n", as.character(packageVersion("RSQLite"))))

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

run_test("create, insert, parameterized query", function() {
  con <- dbConnect(RSQLite::SQLite(), ":memory:")
  on.exit(dbDisconnect(con), add = TRUE)
  dbExecute(con, "CREATE TABLE t (id INTEGER, v TEXT)")
  stopifnot(dbExecute(con, "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')") == 3)
  hit <- dbGetQuery(con, "SELECT v FROM t WHERE id = ?", params = list(2L))
  stopifnot(nrow(hit) == 1L, identical(as.character(hit$v), "b"))
})

run_test("prepared statement: dbSendQuery/dbBind/dbFetch", function() {
  con <- dbConnect(RSQLite::SQLite(), ":memory:")
  on.exit(dbDisconnect(con), add = TRUE)
  dbExecute(con, "CREATE TABLE t (id INTEGER, v TEXT)")
  dbExecute(con, "INSERT INTO t VALUES (1, 'a'), (2, 'b'), (3, 'c')")
  res <- dbSendQuery(con, "SELECT v FROM t WHERE id = ?")
  on.exit(dbClearResult(res), add = TRUE, after = FALSE)
  dbBind(res, list(3L))
  row <- dbFetch(res)
  stopifnot(nrow(row) == 1L, identical(as.character(row$v), "c"))
})

run_test("transactions: commit persists, rollback discards", function() {
  con <- dbConnect(RSQLite::SQLite(), ":memory:")
  on.exit(dbDisconnect(con), add = TRUE)
  dbExecute(con, "CREATE TABLE t (id INTEGER)")
  dbBegin(con)
  dbExecute(con, "INSERT INTO t VALUES (1)")
  dbCommit(con)
  stopifnot(dbGetQuery(con, "SELECT COUNT(*) AS n FROM t")$n == 1)
  dbBegin(con)
  dbExecute(con, "INSERT INTO t VALUES (2)")
  dbRollback(con)
  stopifnot(dbGetQuery(con, "SELECT COUNT(*) AS n FROM t")$n == 1)
})

run_test("SQLite scalar functions evaluate", function() {
  con <- dbConnect(RSQLite::SQLite(), ":memory:")
  on.exit(dbDisconnect(con), add = TRUE)
  out <- dbGetQuery(con, "SELECT abs(-5) AS a, lower('ABC') AS l, length('hello') AS n")
  stopifnot(out$a == 5)
  stopifnot(identical(as.character(out$l), "abc"))
  stopifnot(out$n == 5)
  ver <- dbGetQuery(con, "SELECT sqlite_version() AS v")$v
  stopifnot(is.character(ver), nzchar(ver))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all RSQLite smoke tests passed\n")
