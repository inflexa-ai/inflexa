#!/usr/bin/env Rscript
# Smoke test for the R `data.table` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# data.table itself. Exercises the core API surface and exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript data.table.R

if (!requireNamespace("data.table", quietly = TRUE)) {
  cat("FAIL: package 'data.table' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(data.table))
cat(sprintf("data.table version: %s\n", as.character(packageVersion("data.table"))))

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

run_test("create and subset", function() {
  dt <- data.table(id = 1:5, x = c(10, 20, 30, 40, 50))
  stopifnot(is.data.table(dt), nrow(dt) == 5L)
  stopifnot(identical(dt[id > 3, x], c(40, 50)))
  stopifnot(identical(dt[2:3, sum(x)], 50))
})

run_test("update by reference (:=)", function() {
  dt <- data.table(a = 1:3)
  dt[, b := a * 2L]
  dt[a == 2L, b := 100L]
  stopifnot(identical(dt$b, c(2L, 100L, 6L)))
  dt[, b := NULL]
  stopifnot(identical(names(dt), "a"))
})

run_test("grouped aggregation", function() {
  dt <- data.table(grp = c("a", "a", "b", "b", "b"), v = c(1, 3, 2, 4, 6))
  agg <- dt[, .(n = .N, total = sum(v), avg = mean(v)), by = grp][order(grp)]
  stopifnot(identical(agg$n, c(2L, 3L)))
  stopifnot(identical(agg$total, c(4, 12)))
  stopifnot(identical(agg$avg, c(2, 4)))
})

run_test("keys and joins", function() {
  left <- data.table(id = c(1L, 2L, 3L), x = c("a", "b", "c"))
  right <- data.table(id = c(2L, 3L, 4L), y = c(20, 30, 40))
  setkey(left, id)
  stopifnot(identical(key(left), "id"))
  joined <- right[left, on = "id"]
  stopifnot(nrow(joined) == 3L)
  stopifnot(identical(joined$y, c(NA, 20, 30)))
  inner <- merge(left, right, by = "id")
  stopifnot(identical(inner$id, c(2L, 3L)))
})

run_test("fwrite/fread roundtrip", function() {
  dt <- data.table(i = 1:4, f = c(1.5, 2.5, NA, 4.5), s = c("w", "x", "y", "z"))
  path <- tempfile("dt-smoke-", fileext = ".csv")
  on.exit(unlink(path), add = TRUE)
  fwrite(dt, path)
  back <- fread(path)
  stopifnot(all.equal(dt, back, check.attributes = FALSE))
})

run_test("fread from literal text", function() {
  dt <- fread("a,b\n1,x\n2,y\n")
  stopifnot(identical(dt$a, c(1L, 2L)), identical(dt$b, c("x", "y")))
})

run_test("melt and dcast", function() {
  wide <- data.table(id = 1:2, m1 = c(10, 20), m2 = c(30, 40))
  long <- melt(wide, id.vars = "id", variable.name = "metric", value.name = "val")
  stopifnot(nrow(long) == 4L, identical(sort(long$val), c(10, 20, 30, 40)))
  wide2 <- dcast(long, id ~ metric, value.var = "val")
  stopifnot(identical(wide2$m1, wide$m1), identical(wide2$m2, wide$m2))
})

run_test("rbindlist", function() {
  combined <- rbindlist(list(
    data.table(a = 1L, b = "x"),
    data.table(b = "y", a = 2L)
  ), use.names = TRUE)
  stopifnot(identical(combined$a, c(1L, 2L)), identical(combined$b, c("x", "y")))
})

run_test(".SD with .SDcols", function() {
  dt <- data.table(g = c("a", "a", "b"), x = c(1, 2, 3), y = c(4, 5, 6))
  sums <- dt[, lapply(.SD, sum), by = g, .SDcols = c("x", "y")][order(g)]
  stopifnot(identical(sums$x, c(3, 3)), identical(sums$y, c(9, 6)))
})

run_test("setorder and setnames", function() {
  dt <- data.table(a = c(3L, 1L, 2L), b = c("c", "a", "b"))
  setorder(dt, a)
  stopifnot(identical(dt$b, c("a", "b", "c")))
  setnames(dt, "b", "label")
  stopifnot(identical(names(dt), c("a", "label")))
})

run_test("utilities: shift, fifelse, uniqueN", function() {
  x <- c(1L, 2L, 2L, 3L)
  stopifnot(identical(shift(x), c(NA_integer_, 1L, 2L, 2L)))
  stopifnot(identical(fifelse(x > 1L, "hi", "lo"), c("lo", "hi", "hi", "hi")))
  stopifnot(uniqueN(x) == 3L)
})

run_test("threading is sane", function() {
  stopifnot(getDTthreads() >= 1L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all data.table smoke tests passed\n")
