#!/usr/bin/env Rscript
# Smoke test for the R `tidyr` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# tidyr itself. Exercises the core API surface and exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript tidyr.R

if (!requireNamespace("tidyr", quietly = TRUE)) {
  cat("FAIL: package 'tidyr' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(tidyr))
cat(sprintf("tidyr version: %s\n", as.character(packageVersion("tidyr"))))

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

run_test("pivot_longer/pivot_wider roundtrip", function() {
  wide <- data.frame(id = 1:2, m1 = c(10, 20), m2 = c(30, 40))
  long <- pivot_longer(wide, cols = c(m1, m2), names_to = "metric", values_to = "val")
  stopifnot(identical(nrow(long), 4L))
  stopifnot(identical(long$id, c(1L, 1L, 2L, 2L)))
  stopifnot(identical(long$metric, c("m1", "m2", "m1", "m2")))
  stopifnot(identical(long$val, c(10, 30, 20, 40)))
  wide2 <- pivot_wider(long, names_from = metric, values_from = val)
  stopifnot(identical(wide2$id, wide$id))
  stopifnot(identical(wide2$m1, wide$m1))
  stopifnot(identical(wide2$m2, wide$m2))
})

run_test("separate/unite roundtrip", function() {
  df <- data.frame(x = c("a-1", "b-2"))
  sep <- separate(df, x, into = c("l", "n"), sep = "-")
  stopifnot(identical(names(sep), c("l", "n")))
  stopifnot(identical(sep$l, c("a", "b")))
  stopifnot(identical(sep$n, c("1", "2")))
  back <- unite(sep, "x", l, n, sep = "-")
  stopifnot(identical(back$x, c("a-1", "b-2")))
})

run_test("nest/unnest roundtrip", function() {
  df <- data.frame(g = c("a", "a", "b"), v = 1:3)
  n <- nest(df, data = c(v))
  stopifnot(identical(nrow(n), 2L))
  stopifnot(identical(n$g, c("a", "b")))
  stopifnot(identical(n$data[[1]]$v, 1:2))
  stopifnot(identical(n$data[[2]]$v, 3L))
  un <- unnest(n, cols = data)
  stopifnot(identical(un$g, c("a", "a", "b")))
  stopifnot(identical(un$v, 1:3))
})

run_test("fill in both directions", function() {
  df <- data.frame(x = c(1, NA, NA, 2))
  stopifnot(identical(fill(df, x)$x, c(1, 1, 1, 2)))
  stopifnot(identical(fill(df, x, .direction = "up")$x, c(1, 2, 2, 2)))
})

run_test("complete adds missing combinations", function() {
  df <- data.frame(g = c("a", "a", "b"), t = c(1, 2, 1), v = c(10, 20, 30))
  out <- complete(df, g, t)
  stopifnot(identical(nrow(out), 4L))
  stopifnot(identical(out$g, c("a", "a", "b", "b")))
  stopifnot(identical(out$t, c(1, 2, 1, 2)))
  stopifnot(identical(out$v, c(10, 20, 30, NA)))
})

run_test("drop_na", function() {
  df <- data.frame(x = c(1, NA, 3), y = c("a", "b", NA))
  all_complete <- drop_na(df)
  stopifnot(identical(nrow(all_complete), 1L))
  stopifnot(identical(all_complete$x, 1), identical(all_complete$y, "a"))
  x_only <- drop_na(df, x)
  stopifnot(identical(x_only$x, c(1, 3)))
  stopifnot(identical(x_only$y, c("a", NA)))
})

run_test("expand_grid", function() {
  grid <- expand_grid(x = 1:2, y = c("a", "b"))
  stopifnot(identical(nrow(grid), 4L))
  stopifnot(identical(grid$x, c(1L, 1L, 2L, 2L)))
  stopifnot(identical(grid$y, c("a", "b", "a", "b")))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all tidyr smoke tests passed\n")
