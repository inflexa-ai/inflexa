#!/usr/bin/env Rscript
# Smoke test for the R `survival` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# survival itself (and its implied deps). Data is either bundled with the
# package (`lung`) or simulated with a fixed seed. Exercises the core
# survival-modeling API and exits 0 only if every check passes, so it can be
# used as a pass/fail library validator:
#
#   Rscript survival.R
#
# Modeling outputs are floating-point, so checks assert structural/robust
# properties (classes, lengths, finiteness, monotonicity) and recover known
# effects only within a generous tolerance -- never exact coefficient equality.

if (!requireNamespace("survival", quietly = TRUE)) {
  cat("FAIL: package 'survival' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(survival))
cat(sprintf("survival version: %s\n", as.character(packageVersion("survival"))))

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

run_test("Surv object construction", function() {
  s <- Surv(time = c(5, 10, 15, 20), event = c(1L, 0L, 1L, 1L))
  stopifnot(inherits(s, "Surv"))
  m <- as.matrix(s)
  stopifnot(nrow(m) == 4L, ncol(m) == 2L)
  # right-censored Surv exposes time + status columns
  stopifnot(all(c("time", "status") %in% colnames(m)))
  stopifnot(identical(as.integer(m[, "status"]), c(1L, 0L, 1L, 1L)))
})

run_test("coxph fit on bundled lung dataset", function() {
  # `lung` is lazy-loaded by the package namespace; reference it directly.
  fit <- coxph(Surv(time, status) ~ age + sex, data = lung)
  stopifnot(inherits(fit, "coxph"))
  cf <- coef(fit)
  stopifnot(length(cf) == 2L, identical(names(cf), c("age", "sex")))
  stopifnot(all(is.finite(cf)))
  ll <- as.numeric(logLik(fit))
  stopifnot(is.finite(ll))
  stopifnot(is.finite(AIC(fit)))
  # females (sex == 2) have lower hazard in lung -> negative sex coefficient
  stopifnot(cf["sex"] < 0)
})

run_test("coxph recovers a known effect (simulated)", function() {
  set.seed(123)
  n <- 2000L
  x <- rnorm(n)
  beta <- 0.8
  # exponential event times with hazard proportional to exp(beta * x)
  event_time <- -log(runif(n)) / exp(beta * x)
  cens_time <- runif(n, 0, 3)
  obs <- pmin(event_time, cens_time)
  status <- as.integer(event_time <= cens_time)
  stopifnot(sum(status) > 0L, sum(status) < n) # some events, some censored
  fit <- coxph(Surv(obs, status) ~ x)
  est <- unname(coef(fit))
  stopifnot(is.finite(est))
  # generous tolerance -- floating-point fit on simulated data
  stopifnot(abs(est - beta) < 0.15)
})

run_test("kaplan-meier survfit is a valid survival curve", function() {
  sf <- survfit(Surv(time, status) ~ 1, data = lung)
  stopifnot(inherits(sf, "survfit"))
  surv <- sf$surv
  stopifnot(length(surv) > 1L, all(is.finite(surv)))
  # survival probabilities live in [0, 1], start at/near 1, never increase
  stopifnot(all(surv >= 0), all(surv <= 1))
  stopifnot(abs(surv[1] - 1) < 0.05)
  stopifnot(all(diff(surv) <= 1e-9))
  # a median survival estimate should be finite and positive
  med <- summary(sf)$table["median"]
  stopifnot(is.finite(med), med > 0)
})

run_test("log-rank survdiff between groups", function() {
  sd <- survdiff(Surv(time, status) ~ sex, data = lung)
  stopifnot(sd$chisq >= 0, is.finite(sd$chisq))
  pval <- pchisq(sd$chisq, df = length(sd$n) - 1L, lower.tail = FALSE)
  stopifnot(pval >= 0, pval <= 1)
  # observed/expected counts line up with the two groups
  stopifnot(length(sd$obs) == 2L, length(sd$exp) == 2L)
})

run_test("predict from a fitted coxph model", function() {
  fit <- coxph(Surv(time, status) ~ age + sex, data = lung)
  lp <- predict(fit, type = "lp")
  rk <- predict(fit, type = "risk")
  stopifnot(length(lp) == nrow(lung), all(is.finite(lp)))
  stopifnot(length(rk) == nrow(lung), all(is.finite(rk)))
  # relative-risk scores are strictly positive
  stopifnot(all(rk > 0))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all survival smoke tests passed\n")
