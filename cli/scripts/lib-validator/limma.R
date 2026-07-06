#!/usr/bin/env Rscript
# Smoke test for the R `limma` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# limma itself. All data is simulated with a fixed seed; differential-
# expression checks are structural / tolerance-based, never exact floating-
# point equality. Exercises the core API surface and exits 0 only if every
# check passes, so it can be used as a pass/fail library validator:
#
#   Rscript limma.R

if (!requireNamespace("limma", quietly = TRUE)) {
  cat("FAIL: package 'limma' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(limma))
cat(sprintf("limma version: %s\n", as.character(packageVersion("limma"))))

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

# Simulate a 200-gene x 12-sample log-expression matrix: two groups, 6 vs 6.
# Baseline expression ~ N(6, 1); the first 20 genes (the planted DE set) get
# a strong +3 shift in group B. The remaining 180 genes are null.
# The effect size (+3 SD) and replication (6/group) are chosen so the planted
# genes clear a BH-adjusted 0.05 threshold across all 200 genes with margin —
# a smaller effect / 3-per-group leaves the recovery below the assertions after
# multiple-testing correction, which is a property of the test setup, not limma.
set.seed(1)
n_genes <- 200L
n_per <- 6L
n_de <- 20L
expr <- matrix(
  rnorm(n_genes * 2L * n_per, mean = 6, sd = 1),
  nrow = n_genes,
  ncol = 2L * n_per
)
b_cols <- (n_per + 1L):(2L * n_per) # group B columns
expr[1:n_de, b_cols] <- expr[1:n_de, b_cols] + 3
rownames(expr) <- sprintf("gene%03d", seq_len(n_genes))
colnames(expr) <- sprintf("s%d", seq_len(2L * n_per))
grp <- factor(rep(c("A", "B"), each = n_per))
de_names <- sprintf("gene%03d", 1:n_de)

# Design has an intercept + a grpB coefficient (coef 2 is the group effect).
fit_limma <- function() {
  design <- model.matrix(~grp)
  eBayes(lmFit(expr, design))
}

run_test("lmFit + eBayes: MArrayLM object and coefficient shape", function() {
  fit <- fit_limma()
  stopifnot(inherits(fit, "MArrayLM"))
  stopifnot(nrow(fit$coefficients) == n_genes)
  stopifnot(ncol(fit$coefficients) == 2L)
  stopifnot(!is.null(fit$t), !is.null(fit$p.value))
})

run_test("topTable: table shape and required columns", function() {
  fit <- fit_limma()
  tt <- topTable(fit, coef = 2, number = Inf)
  stopifnot(nrow(tt) == n_genes)
  stopifnot(all(c("logFC", "P.Value", "adj.P.Val") %in% colnames(tt)))
})

run_test("topTable: planted genes detected with correct sign", function() {
  fit <- fit_limma()
  tt <- topTable(fit, coef = 2, number = Inf)
  # Planted genes are +2 in group B, so the grpB logFC must be positive and
  # they should dominate the most-significant end of the table.
  stopifnot(median(tt[de_names, "logFC"]) > 1.5)
  top50 <- rownames(tt)[1:50]
  stopifnot(sum(de_names %in% top50) >= 15L)
  stopifnot(median(tt[de_names, "adj.P.Val"]) < 0.05)
})

run_test("topTable: null genes are not significant on average", function() {
  fit <- fit_limma()
  tt <- topTable(fit, coef = 2, number = Inf)
  null_names <- sprintf("gene%03d", (n_de + 1L):n_genes)
  stopifnot(abs(median(tt[null_names, "logFC"])) < 0.5)
  stopifnot(median(tt[null_names, "adj.P.Val"]) > 0.1)
})

run_test("decideTests: planted genes flagged up in group B", function() {
  fit <- fit_limma()
  dt <- decideTests(fit)
  stopifnot(inherits(dt, "TestResults"))
  # Column 2 is the grpB coefficient; a +1 call == significantly up.
  calls <- as.numeric(dt[, 2])
  stopifnot(sum(calls[1:n_de] == 1) >= 15L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all limma smoke tests passed\n")
