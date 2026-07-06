#!/usr/bin/env Rscript
# Smoke test for the R `survminer` package.
#
# Fully self-contained: no input files, no network, no plotting device. Data is
# the `lung` dataset bundled with `survival` (a survminer dependency); models
# are fit with survival's `survfit`. Exercises survminer's survival-plot and
# summary API and exits 0 only if every check passes, so it can be used as a
# pass/fail library validator:
#
#   Rscript survminer.R
#
# ggsurvplot builds a ggplot object but is never drawn (no device is opened),
# so checks assert structural properties (object classes, data-frame columns,
# value ranges) rather than pixels -- and never exact floating-point equality.

if (!requireNamespace("survminer", quietly = TRUE)) {
  cat("FAIL: package 'survminer' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(survminer))
suppressPackageStartupMessages(library(survival))
cat(sprintf("survminer version: %s\n", as.character(packageVersion("survminer"))))

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

run_test("ggsurvplot builds a ggsurvplot / ggplot object", function() {
  fit <- survfit(Surv(time, status) ~ sex, data = lung)
  p <- ggsurvplot(fit, data = lung)
  stopifnot(inherits(p, "ggsurvplot"))
  # the survival curve itself is a ggplot; it is built but never drawn
  stopifnot(inherits(p$plot, "ggplot"))
})

run_test("ggsurvplot with risk table and p-value", function() {
  fit <- survfit(Surv(time, status) ~ sex, data = lung)
  p <- ggsurvplot(fit, data = lung, risk.table = TRUE, pval = TRUE,
                  conf.int = TRUE)
  stopifnot(inherits(p, "ggsurvplot"))
  stopifnot(inherits(p$plot, "ggplot"))
  # requesting a risk table yields a second ggplot component
  stopifnot(inherits(p$table, "ggplot"))
})

run_test("surv_summary returns a tidy data.frame", function() {
  fit <- survfit(Surv(time, status) ~ sex, data = lung)
  ss <- surv_summary(fit, data = lung)
  stopifnot(is.data.frame(ss))
  stopifnot(nrow(ss) > 0L)
  # the standard tidy survival-summary columns are present
  stopifnot(all(c("time", "n.risk", "n.event", "surv", "strata") %in% names(ss)))
  # survival probabilities are valid and non-increasing within each stratum
  stopifnot(all(is.finite(ss$surv)), all(ss$surv >= 0), all(ss$surv <= 1))
  for (st in unique(ss$strata)) {
    s <- ss$surv[ss$strata == st]
    stopifnot(all(diff(s) <= 1e-9))
  }
})

run_test("surv_median returns per-stratum medians", function() {
  fit <- survfit(Surv(time, status) ~ sex, data = lung)
  med <- surv_median(fit)
  stopifnot(is.data.frame(med))
  stopifnot("median" %in% names(med))
  # one median row per stratum (sex has two levels)
  stopifnot(nrow(med) == 2L)
  stopifnot(all(is.finite(med$median)), all(med$median > 0))
})

run_test("pairwise_survdiff returns valid p-values", function() {
  psd <- pairwise_survdiff(Surv(time, status) ~ sex, data = lung)
  stopifnot(inherits(psd, "pairwise.htest"))
  pv <- psd$p.value
  finite_p <- pv[is.finite(pv)]
  # at least one comparison, all p-values are proper probabilities
  stopifnot(length(finite_p) >= 1L)
  stopifnot(all(finite_p >= 0), all(finite_p <= 1))
})

run_test("surv_fit convenience wrapper fits a survfit", function() {
  # survminer's surv_fit re-evaluates the formula against the data, keeping the
  # call tidy for downstream ggsurvplot use.
  fit <- surv_fit(Surv(time, status) ~ sex, data = lung)
  stopifnot(inherits(fit, "survfit"))
  stopifnot(length(fit$strata) == 2L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all survminer smoke tests passed\n")
