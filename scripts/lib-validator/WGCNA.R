#!/usr/bin/env Rscript
# Smoke test for the R `WGCNA` package.
#
# Fully self-contained: no input files, no network, no packages beyond WGCNA
# and its implied deps. All data is a small synthetic Gaussian expression
# matrix built with a fixed seed (samples x genes); checks are structural
# (dimensions, symmetry) and tolerance-based (value ranges, finiteness) rather
# than numeric-equality on anything random. Exercises the core network-
# construction API and exits 0 only if every check passes, so it can be used as
# a pass/fail library validator:
#
#   Rscript WGCNA.R
#
# WGCNA is chatty (connectivity progress, soft-threshold tables): every noisy
# call is wrapped in suppressMessages()/suppressWarnings(). The heavy
# blockwiseModules() module-detection step is deliberately SKIPPED -- it is slow
# and stochastic; adjacency() / TOMsimilarity() / pickSoftThreshold() cover the
# core surface without it.
#
# NOTE (needs re-check once installed): WGCNA masks stats::cor with its own
# WGCNA::cor, so the correlation checks qualify WGCNA::cor / WGCNA::bicor
# explicitly. adjacency() defaults to type="unsigned" (abs(cor)^power, values in
# [0,1] with a unit diagonal); pickSoftThreshold() returns a `fitIndices`
# data.frame whose columns are assumed to include Power / SFT.R.sq / slope --
# re-confirm the default network type and those column names once a build is
# available.

if (!requireNamespace("WGCNA", quietly = TRUE)) {
  cat("FAIL: package 'WGCNA' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(WGCNA))
cat(sprintf("WGCNA version: %s\n", as.character(packageVersion("WGCNA"))))

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

# Synthetic expression: 30 samples (rows) x 100 genes (columns), i.i.d. normal.
# WGCNA expects genes in columns, so adjacency / TOM are gene-by-gene 100 x 100.
set.seed(1)
datExpr <- matrix(rnorm(30 * 100), nrow = 30, ncol = 100)
colnames(datExpr) <- paste0("gene", seq_len(100))
rownames(datExpr) <- paste0("sample", seq_len(30))

run_test("adjacency() is 100x100, symmetric, in [0,1] with unit diagonal", function() {
  adj <- suppressWarnings(suppressMessages(adjacency(datExpr, power = 6)))
  stopifnot(is.matrix(adj), nrow(adj) == 100L, ncol(adj) == 100L)
  stopifnot(max(abs(adj - t(adj))) < 1e-8)             # symmetric
  stopifnot(all(adj >= -1e-8 & adj <= 1 + 1e-8))       # unsigned range [0,1]
  stopifnot(all(abs(diag(adj) - 1) < 1e-8))            # self-adjacency == 1
})

run_test("TOMsimilarity() is 100x100, symmetric, in [0,1]", function() {
  adj <- suppressWarnings(suppressMessages(adjacency(datExpr, power = 6)))
  TOM <- suppressWarnings(suppressMessages(TOMsimilarity(adj)))
  stopifnot(is.matrix(TOM), nrow(TOM) == 100L, ncol(TOM) == 100L)
  stopifnot(all(TOM >= -1e-8 & TOM <= 1 + 1e-8))
  stopifnot(max(abs(TOM - t(TOM))) < 1e-8)
})

run_test("pickSoftThreshold() returns a fitIndices table over the powers", function() {
  sft <- suppressWarnings(suppressMessages(
    pickSoftThreshold(datExpr, powerVector = c(1, 4, 6), verbose = 0)))
  fi <- sft$fitIndices
  stopifnot(is.data.frame(fi), nrow(fi) == 3L)
  stopifnot(all(c("Power", "SFT.R.sq", "slope") %in% names(fi)))
  stopifnot(all(fi$Power == c(1, 4, 6)))
})

run_test("WGCNA::cor and WGCNA::bicor are finite 100x100 matrices", function() {
  cmat <- suppressWarnings(WGCNA::cor(datExpr))
  bmat <- suppressWarnings(WGCNA::bicor(datExpr))
  stopifnot(is.matrix(cmat), nrow(cmat) == 100L, ncol(cmat) == 100L, all(is.finite(cmat)))
  stopifnot(is.matrix(bmat), nrow(bmat) == 100L, ncol(bmat) == 100L, all(is.finite(bmat)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all WGCNA smoke tests passed\n")
