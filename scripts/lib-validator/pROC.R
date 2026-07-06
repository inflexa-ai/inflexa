#!/usr/bin/env Rscript
# Smoke test for the R `pROC` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# pROC itself. Data is simulated with a fixed seed: a binary outcome plus a
# predictor correlated with it. Exercises the core ROC / AUC API and exits 0
# only if every check passes, so it can be used as a pass/fail library
# validator:
#
#   Rscript pROC.R
#
# ROC/AUC/CI outputs are floating-point, so checks assert structural and
# robust properties (classes, ranges, CI bracketing, monotone comparisons)
# within generous tolerances -- never exact numeric equality.

if (!requireNamespace("pROC", quietly = TRUE)) {
  cat("FAIL: package 'pROC' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(pROC))
cat(sprintf("pROC version: %s\n", as.character(packageVersion("pROC"))))

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

# Shared fixture: a binary response and two predictors of differing strength.
# direction "<" and explicit levels make the ROC deterministic and silence the
# auto-direction message; quiet = TRUE suppresses the remaining console chatter.
set.seed(1)
n <- 300L
response <- rbinom(n, size = 1, prob = 0.5)
strong <- response + rnorm(n, sd = 0.6) # cases score higher -> strong signal
weak <- response + rnorm(n, sd = 3.0) # noisier -> weaker signal

roc_strong <- pROC::roc(response, strong,
                        levels = c(0, 1), direction = "<", quiet = TRUE)
roc_weak <- pROC::roc(response, weak,
                      levels = c(0, 1), direction = "<", quiet = TRUE)

run_test("roc object and AUC for a strong predictor", function() {
  stopifnot(inherits(roc_strong, "roc"))
  a <- as.numeric(pROC::auc(roc_strong))
  # AUC lives in (0.5, 1]; a strong predictor clears 0.7 comfortably
  stopifnot(a > 0.5, a <= 1)
  stopifnot(a > 0.7)
})

run_test("ci.auc returns a 3-number CI bracketing the AUC", function() {
  a <- as.numeric(pROC::auc(roc_strong))
  ci <- as.numeric(pROC::ci.auc(roc_strong)) # DeLong CI: deterministic
  stopifnot(length(ci) == 3L)
  # element 2 is the AUC point estimate; 1 and 3 are the CI bounds
  stopifnot(ci[1] <= ci[2], ci[2] <= ci[3])
  stopifnot(abs(ci[2] - a) < 1e-6)
  stopifnot(ci[1] >= 0, ci[3] <= 1)
})

run_test("coords(best) yields threshold/sensitivity/specificity", function() {
  # transpose = FALSE returns a data.frame with named columns. NOTE: pre-1.16
  # pROC returned a transposed named VECTOR by default -- flag on re-check.
  co <- pROC::coords(roc_strong, x = "best",
                     ret = c("threshold", "sensitivity", "specificity"),
                     transpose = FALSE)
  stopifnot(is.data.frame(co), nrow(co) >= 1L)
  stopifnot(all(c("threshold", "sensitivity", "specificity") %in% names(co)))
  stopifnot(all(co$sensitivity >= 0), all(co$sensitivity <= 1))
  stopifnot(all(co$specificity >= 0), all(co$specificity <= 1))
  stopifnot(all(is.finite(co$threshold)))
})

run_test("roc.test between two predictors returns a p-value", function() {
  # paired DeLong test: both ROC curves share the same response vector
  tst <- pROC::roc.test(roc_strong, roc_weak)
  stopifnot(inherits(tst, "htest"))
  stopifnot(is.finite(tst$p.value), tst$p.value >= 0, tst$p.value <= 1)
  # the stronger predictor should out-AUC the weaker one
  stopifnot(as.numeric(pROC::auc(roc_strong)) > as.numeric(pROC::auc(roc_weak)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all pROC smoke tests passed\n")
