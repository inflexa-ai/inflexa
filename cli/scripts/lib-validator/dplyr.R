#!/usr/bin/env Rscript
# Smoke test for the R `dplyr` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# dplyr itself. Exercises the core API surface and exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript dplyr.R

if (!requireNamespace("dplyr", quietly = TRUE)) {
  cat("FAIL: package 'dplyr' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(dplyr))
cat(sprintf("dplyr version: %s\n", as.character(packageVersion("dplyr"))))

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

run_test("filter, select, mutate, arrange", function() {
  df <- data.frame(id = c(3L, 1L, 2L), v = c(30, 10, 20))
  out <- df |>
    filter(v > 10) |>
    mutate(v2 = v * 2) |>
    arrange(id) |>
    select(id, v2)
  stopifnot(identical(names(out), c("id", "v2")))
  stopifnot(identical(out$id, c(2L, 3L)))
  stopifnot(identical(out$v2, c(40, 60)))
})

run_test("group_by + summarise on mtcars", function() {
  agg <- mtcars |>
    group_by(cyl) |>
    summarise(m = mean(mpg))
  stopifnot(identical(nrow(agg), 3L))
  stopifnot(identical(agg$cyl, c(4, 6, 8)))
  expected <- c(26.66364, 19.74286, 15.1)
  stopifnot(all(abs(agg$m - expected) < 1e-4))
})

run_test("left_join and inner_join", function() {
  left <- data.frame(id = c(1L, 2L, 3L), x = c("a", "b", "c"))
  right <- data.frame(id = c(2L, 3L, 4L), y = c(20, 30, 40))
  lj <- left_join(left, right, by = "id")
  stopifnot(identical(nrow(lj), 3L))
  stopifnot(identical(lj$y, c(NA, 20, 30)))
  ij <- inner_join(left, right, by = "id")
  stopifnot(identical(ij$id, c(2L, 3L)))
  stopifnot(identical(ij$x, c("b", "c")))
  stopifnot(identical(ij$y, c(20, 30)))
})

run_test("count, distinct, slice", function() {
  df <- data.frame(g = c("a", "a", "b"), v = c(1, 1, 2))
  cnt <- count(df, g)
  stopifnot(identical(cnt$g, c("a", "b")))
  stopifnot(identical(cnt$n, c(2L, 1L)))
  d <- distinct(df)
  stopifnot(identical(nrow(d), 2L))
  stopifnot(identical(d$g, c("a", "b")))
  s <- slice(df, 2)
  stopifnot(identical(nrow(s), 1L))
  stopifnot(identical(s$v, 1))
})

run_test("case_when", function() {
  x <- c(1, 5, 10)
  out <- case_when(
    x < 3 ~ "low",
    x < 8 ~ "mid",
    TRUE ~ "high"
  )
  stopifnot(identical(out, c("low", "mid", "high")))
})

run_test("across in grouped summarise", function() {
  df <- data.frame(g = c("a", "a", "b"), x = c(1, 2, 3), y = c(4, 5, 6))
  agg <- df |>
    group_by(g) |>
    summarise(across(c(x, y), mean))
  stopifnot(identical(agg$g, c("a", "b")))
  stopifnot(identical(agg$x, c(1.5, 3)))
  stopifnot(identical(agg$y, c(4.5, 6)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all dplyr smoke tests passed\n")
