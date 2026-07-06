#!/usr/bin/env Rscript
# Smoke test for the R `glmGamPoi` package.
#
# Fully self-contained: no input files, no network. Simulates a small Poisson
# count matrix (genes x samples) with a fixed seed and a two-group design, fits
# a Gamma-Poisson GLM with glm_gp(), then runs a differential-expression test
# with test_de(). Checks are structural / tolerance-based (object class, matrix
# shapes, finite non-negative overdispersions, probability ranges) -- never
# exact floating-point equality on the fit. Exits 0 only if every check passes,
# so it can be used as a pass/fail library validator:
#
#   Rscript glmGamPoi.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# UNVERIFIABLE WITHOUT AN INSTALL -- confirm once glmGamPoi is available:
#   - glm_gp() SIGNATURE. Assumes glm_gp(data, design = <matrix or formula>)
#     returns an S3 object of class "glmGamPoi" whose elements include:
#       * $Beta            -- coefficient matrix, (n_genes x n_coef)
#       * $overdispersions -- length-(n_genes) numeric, finite & >= 0
#       * $Mu              -- fitted means, same dim as the count matrix
#   - test_de() SIGNATURE. Assumes test_de(fit, contrast = "<coef name>")
#     returns a data.frame with (at least) columns `pval`, `adj_pval`, `lfc`,
#     one row per gene. The contrast is passed as the STRING name of the
#     non-intercept design coefficient ("groupb"); if the coefficient-naming
#     convention differs, adjust the contrast argument.
# ============================================================================

if (!requireNamespace("glmGamPoi", quietly = TRUE)) {
  cat("FAIL: package 'glmGamPoi' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(glmGamPoi))
cat(sprintf("glmGamPoi version: %s\n", as.character(packageVersion("glmGamPoi"))))

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

# Synthetic counts: 100 genes x 10 samples, integer Poisson draws. A balanced
# two-group design (5 "a" + 5 "b"); model.matrix gives coefficients named
# "(Intercept)" and "groupb", the latter being the contrast tested below.
set.seed(1)
n_genes <- 100L
n_samples <- 10L
counts <- matrix(rpois(n_genes * n_samples, lambda = 8), nrow = n_genes, ncol = n_samples)
group <- factor(rep(c("a", "b"), each = 5))
design <- model.matrix(~group)
n_coef <- ncol(design)

run_test("glm_gp returns a glmGamPoi fit", function() {
  fit <- suppressWarnings(suppressMessages(glm_gp(counts, design = design)))
  stopifnot(inherits(fit, "glmGamPoi"))
})

run_test("Beta is a (genes x coef) coefficient matrix", function() {
  fit <- suppressWarnings(suppressMessages(glm_gp(counts, design = design)))
  stopifnot(is.matrix(fit$Beta))
  stopifnot(identical(dim(fit$Beta), c(n_genes, n_coef)))
  stopifnot(all(is.finite(fit$Beta)))
})

run_test("overdispersions are finite and non-negative, one per gene", function() {
  fit <- suppressWarnings(suppressMessages(glm_gp(counts, design = design)))
  od <- fit$overdispersions
  stopifnot(length(od) == n_genes)
  stopifnot(all(is.finite(od)))
  stopifnot(all(od >= 0))
})

run_test("Mu (fitted means) matches the count-matrix shape", function() {
  fit <- suppressWarnings(suppressMessages(glm_gp(counts, design = design)))
  stopifnot(identical(dim(fit$Mu), dim(counts)))
  stopifnot(all(is.finite(fit$Mu)))
  # Fitted Poisson/GP means are strictly positive.
  stopifnot(all(fit$Mu > 0))
})

run_test("test_de returns a per-gene DE table with pval/adj_pval/lfc", function() {
  fit <- suppressWarnings(suppressMessages(glm_gp(counts, design = design)))
  res <- suppressWarnings(suppressMessages(test_de(fit, contrast = "groupb")))
  stopifnot(is.data.frame(res))
  stopifnot(all(c("pval", "adj_pval", "lfc") %in% names(res)))
  stopifnot(nrow(res) == n_genes)
  # p-values and adjusted p-values are probabilities (allow NA for degenerate
  # genes, but every non-NA value must lie in [0, 1]).
  pv <- res$pval[is.finite(res$pval)]
  ap <- res$adj_pval[is.finite(res$adj_pval)]
  stopifnot(all(pv >= 0 & pv <= 1))
  stopifnot(all(ap >= 0 & ap <= 1))
  # log fold-changes are finite where defined.
  stopifnot(all(is.finite(res$lfc[!is.na(res$lfc)])))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all glmGamPoi smoke tests passed\n")
