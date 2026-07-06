#!/usr/bin/env Rscript
# Smoke test for the R `variancePartition` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# variancePartition itself (and the dependencies it implies, e.g. lme4 /
# BiocParallel). All data is simulated with a fixed seed; variance-fraction
# checks are structural / tolerance-based, never exact floating-point
# equality. Exercises the core API surface and exits 0 only if every check
# passes, so it can be used as a pass/fail library validator:
#
#   Rscript variancePartition.R

if (!requireNamespace("variancePartition", quietly = TRUE)) {
  cat("FAIL: package 'variancePartition' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(variancePartition))
cat(sprintf(
  "variancePartition version: %s\n",
  as.character(packageVersion("variancePartition"))
))

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

# Simulate 50 genes across 40 samples drawn from 10 individuals (4 repeats
# each) plus a continuous `age` covariate. A strong per-individual random
# intercept (sd 2) dominates variance; the first 25 genes also carry an age
# effect. Noise is N(0, 1). This gives the mixed model a clear, recoverable
# variance decomposition over the terms (1|individual) and age.
set.seed(1)
n_ind <- 10L
n_rep <- 4L
n_samples <- n_ind * n_rep
n_genes <- 50L
individual <- factor(rep(sprintf("ind%02d", seq_len(n_ind)), each = n_rep))
age <- rnorm(n_samples, mean = 50, sd = 10)
metadata <- data.frame(individual = individual, age = age)

ind_effect <- matrix(rnorm(n_genes * n_ind, sd = 2), nrow = n_genes, ncol = n_ind)
expr <- matrix(rnorm(n_genes * n_samples, sd = 1), nrow = n_genes, ncol = n_samples)
expr <- expr + ind_effect[, as.integer(individual)]
age_z <- scale(age)[, 1]
expr[1:25, ] <- expr[1:25, ] +
  matrix(1.5 * age_z, nrow = 25L, ncol = n_samples, byrow = TRUE)
rownames(expr) <- sprintf("gene%03d", seq_len(n_genes))
colnames(expr) <- sprintf("s%02d", seq_len(n_samples))

# Random effect for the categorical individual, fixed effect for age.
# TODO(robustness): fitExtractVarPartModel() signature + the BPPARAM arg are
# written against the current variancePartition API from memory -- re-check
# the formula/BPPARAM contract once the package is installed.
form <- ~ (1 | individual) + age

# suppressMessages/suppressWarnings silence per-gene fitting chatter and
# benign lme4 convergence notes; SerialParam keeps the run single-threaded
# and deterministic. Genuine errors still propagate to run_test.
fit_vp <- function() {
  suppressMessages(suppressWarnings(
    fitExtractVarPartModel(expr, form, metadata, BPPARAM = BiocParallel::SerialParam())
  ))
}

run_test("fitExtractVarPartModel: object shape and term columns", function() {
  vp <- fit_vp()
  df <- as.data.frame(vp)
  stopifnot(nrow(df) == n_genes)
  # One column per model term plus a Residuals column.
  stopifnot(all(c("individual", "age", "Residuals") %in% colnames(df)))
})

run_test("variance fractions are valid proportions summing to ~1", function() {
  vp <- fit_vp()
  df <- as.data.frame(vp)
  m <- as.matrix(df[, c("individual", "age", "Residuals")])
  stopifnot(all(m >= -1e-6 & m <= 1 + 1e-6))
  row_sums <- rowSums(m)
  stopifnot(all(abs(row_sums - 1) < 1e-6))
})

run_test("planted individual effect dominates variance", function() {
  vp <- fit_vp()
  df <- as.data.frame(vp)
  # The strong per-individual random intercept should explain a large median
  # share of the variance (aggregate/tolerance, not per-gene exact).
  stopifnot(median(df[["individual"]]) > 0.4)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all variancePartition smoke tests passed\n")
