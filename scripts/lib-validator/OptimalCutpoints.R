#!/usr/bin/env Rscript
# Smoke test for the R `OptimalCutpoints` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# OptimalCutpoints itself. Data is simulated with a fixed seed (a continuous
# marker that separates a binary disease status). Exercises the core
# cutpoint-selection API and exits 0 only if every check passes, so it can be
# used as a pass/fail library validator:
#
#   Rscript OptimalCutpoints.R
#
# NOTE (needs re-check once installed): the nested result structure
# (`oc$Youden$Global$optimal.cutoff$cutoff` / `$Se` / `$Sp`) and the
# "optimal.cutpoints" class name were written from the documented API and NOT
# verified against an installed build -- re-confirm the accessor path when the
# package is available. Selected cutoffs and Se/Sp are floating point, so checks
# assert structural/robust properties (class, finiteness, in-range,
# probabilities in [0, 1]) -- never exact equality.

if (!requireNamespace("OptimalCutpoints", quietly = TRUE)) {
  cat("FAIL: package 'OptimalCutpoints' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(OptimalCutpoints))
cat(sprintf("OptimalCutpoints version: %s\n",
            as.character(packageVersion("OptimalCutpoints"))))

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

# Shared simulated diagnostic dataset: diseased subjects (status == 1) carry a
# higher marker, so a Youden-optimal cutoff should sit between the two means.
make_data <- function() {
  set.seed(1)
  n <- 300L
  status <- rbinom(n, 1L, 0.5)
  marker <- rnorm(n, mean = ifelse(status == 1L, 2.5, 0), sd = 1)
  data.frame(marker = marker, status = status)
}

run_test("optimal.cutpoints fits with the Youden method", function() {
  df <- make_data()
  oc <- optimal.cutpoints(X = "marker", status = "status",
                          tag.healthy = 0, methods = "Youden", data = df)
  stopifnot(inherits(oc, "optimal.cutpoints"))
  # the requested method is present in the result
  stopifnot("Youden" %in% names(oc))
})

run_test("Youden optimal cutoff is finite and within marker range", function() {
  df <- make_data()
  oc <- optimal.cutpoints(X = "marker", status = "status",
                          tag.healthy = 0, methods = "Youden", data = df)
  cutoff <- as.numeric(oc$Youden$Global$optimal.cutoff$cutoff)
  stopifnot(length(cutoff) >= 1L)
  stopifnot(all(is.finite(cutoff)))
  rng <- range(df$marker)
  stopifnot(all(cutoff >= rng[1]), all(cutoff <= rng[2]))
  # a well-separated marker -> cutoff sits between the two group means (0 & 2.5)
  stopifnot(any(cutoff > -1 & cutoff < 3.5))
})

run_test("sensitivity and specificity are valid probabilities", function() {
  df <- make_data()
  oc <- optimal.cutpoints(X = "marker", status = "status",
                          tag.healthy = 0, methods = "Youden", data = df)
  se <- as.numeric(oc$Youden$Global$optimal.cutoff$Se)
  sp <- as.numeric(oc$Youden$Global$optimal.cutoff$Sp)
  se <- se[is.finite(se)]
  sp <- sp[is.finite(sp)]
  stopifnot(length(se) >= 1L, length(sp) >= 1L)
  stopifnot(all(se >= 0), all(se <= 1))
  stopifnot(all(sp >= 0), all(sp <= 1))
  # a separable marker should yield decent discrimination at the optimum
  stopifnot(max(se) > 0.6, max(sp) > 0.6)
})

run_test("multiple methods can be requested together", function() {
  df <- make_data()
  oc <- optimal.cutpoints(X = "marker", status = "status", tag.healthy = 0,
                          methods = c("Youden", "MaxSpSe"), data = df)
  stopifnot(inherits(oc, "optimal.cutpoints"))
  stopifnot(all(c("Youden", "MaxSpSe") %in% names(oc)))
  for (m in c("Youden", "MaxSpSe")) {
    cut_m <- as.numeric(oc[[m]]$Global$optimal.cutoff$cutoff)
    stopifnot(length(cut_m) >= 1L, all(is.finite(cut_m)))
  }
})

run_test("summary of the fit is produced without error", function() {
  df <- make_data()
  oc <- optimal.cutpoints(X = "marker", status = "status",
                          tag.healthy = 0, methods = "Youden", data = df)
  s <- summary(oc)
  stopifnot(!is.null(s))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all OptimalCutpoints smoke tests passed\n")
