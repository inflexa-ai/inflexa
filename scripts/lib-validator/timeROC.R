#!/usr/bin/env Rscript
# Smoke test for the R `timeROC` package.
#
# Fully self-contained: no input files, no network, no packages beyond timeROC
# itself. Data is simulated with a fixed seed (right-censored survival times
# whose hazard rises with a continuous marker). Exercises the core
# time-dependent ROC / AUC API and exits 0 only if every check passes, so it can
# be used as a pass/fail library validator:
#
#   Rscript timeROC.R
#
# NOTE (needs re-check once installed): the "ipcwsurvivalROC" class name and the
# `$AUC` / `$times` accessors were written from the documented API and NOT
# verified against an installed build -- re-confirm when the package is
# available. AUC estimates are floating point (and early/late time points can be
# NA when at risk-set thins), so checks assert structural/robust properties
# (class, length matching `times`, finite AUCs in [0, 1], discrimination above
# chance) -- never exact equality.

if (!requireNamespace("timeROC", quietly = TRUE)) {
  cat("FAIL: package 'timeROC' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(timeROC))
cat(sprintf("timeROC version: %s\n", as.character(packageVersion("timeROC"))))

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

# Shared simulated survival dataset: higher marker -> higher hazard -> shorter
# time, so the marker is genuinely prognostic and time-dependent AUC > 0.5.
make_data <- function() {
  set.seed(1)
  n <- 400L
  marker <- rnorm(n)
  event_time <- rexp(n, rate = 0.1 * exp(0.8 * marker))
  cens_time <- rexp(n, rate = 0.05)
  time <- pmin(event_time, cens_time)
  status <- as.integer(event_time <= cens_time)
  list(time = time, status = status, marker = marker)
}

run_test("timeROC returns the expected object", function() {
  d <- make_data()
  t_eval <- as.numeric(quantile(d$time[d$status == 1L], probs = c(0.4, 0.6)))
  tr <- timeROC(T = d$time, delta = d$status, marker = d$marker,
                cause = 1, times = t_eval, iid = FALSE)
  stopifnot(inherits(tr, "ipcwsurvivalROC"))
})

run_test("AUC has one entry per requested time", function() {
  d <- make_data()
  t_eval <- as.numeric(quantile(d$time[d$status == 1L], probs = c(0.4, 0.6)))
  tr <- timeROC(T = d$time, delta = d$status, marker = d$marker,
                cause = 1, times = t_eval, iid = FALSE)
  stopifnot(length(tr$AUC) == length(t_eval))
})

run_test("AUC values are valid probabilities", function() {
  d <- make_data()
  t_eval <- as.numeric(quantile(d$time[d$status == 1L], probs = c(0.4, 0.6)))
  tr <- timeROC(T = d$time, delta = d$status, marker = d$marker,
                cause = 1, times = t_eval, iid = FALSE)
  auc <- tr$AUC[is.finite(tr$AUC)]
  # at least one time point yields a usable AUC, all within [0, 1]
  stopifnot(length(auc) >= 1L)
  stopifnot(all(auc >= 0), all(auc <= 1))
})

run_test("prognostic marker discriminates above chance", function() {
  d <- make_data()
  t_eval <- as.numeric(quantile(d$time[d$status == 1L], probs = c(0.4, 0.6)))
  tr <- timeROC(T = d$time, delta = d$status, marker = d$marker,
                cause = 1, times = t_eval, iid = FALSE)
  auc <- tr$AUC[is.finite(tr$AUC)]
  # a truly prognostic marker beats a coin flip -- generous margin above 0.5
  stopifnot(all(auc > 0.55))
})

run_test("single time point is handled", function() {
  d <- make_data()
  med <- as.numeric(median(d$time[d$status == 1L]))
  tr <- timeROC(T = d$time, delta = d$status, marker = d$marker,
                cause = 1, times = med, iid = FALSE)
  stopifnot(inherits(tr, "ipcwsurvivalROC"))
  # the evaluation time is echoed back on the fitted object
  stopifnot(any(is.finite(tr$times)))
  stopifnot(length(tr$AUC) == length(tr$times))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all timeROC smoke tests passed\n")
