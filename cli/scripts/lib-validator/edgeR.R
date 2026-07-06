#!/usr/bin/env Rscript
# Smoke test for the R `edgeR` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# edgeR itself (and the dependencies it implies, e.g. limma). All data is
# simulated with a fixed seed; differential-expression checks are structural /
# tolerance-based, never exact floating-point equality. Exercises the core
# API surface and exits 0 only if every check passes, so it can be used as a
# pass/fail library validator:
#
#   Rscript edgeR.R

if (!requireNamespace("edgeR", quietly = TRUE)) {
  cat("FAIL: package 'edgeR' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(edgeR))
cat(sprintf("edgeR version: %s\n", as.character(packageVersion("edgeR"))))

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

# Simulate a 200-gene x 6-sample count matrix: two groups, 3 vs 3. Baseline
# counts are Poisson around a moderate mean; the first 20 genes (the planted
# DE set) get a strong ~8x up-shift in group B. The remaining 180 genes are
# null. gene001..gene020 are the planted set; used by rank/sign checks below.
set.seed(1)
n_genes <- 200L
n_per <- 3L
n_de <- 20L
base_mu <- 100
counts <- matrix(
  rpois(n_genes * 2L * n_per, lambda = base_mu),
  nrow = n_genes,
  ncol = 2L * n_per
)
b_cols <- (n_per + 1L):(2L * n_per) # columns 4:6 == group B
counts[1:n_de, b_cols] <- rpois(n_de * n_per, lambda = base_mu * 8)
rownames(counts) <- sprintf("gene%03d", seq_len(n_genes))
colnames(counts) <- sprintf("s%d", seq_len(2L * n_per))
grp <- factor(rep(c("A", "B"), each = n_per))
de_names <- sprintf("gene%03d", 1:n_de)

# Run the full QL pipeline. suppressMessages/suppressWarnings silence benign
# estimator chatter only; genuine errors still propagate to run_test.
fit_edger <- function() {
  suppressMessages(suppressWarnings({
    y <- DGEList(counts = counts, group = grp)
    y <- calcNormFactors(y)
    design <- model.matrix(~grp)
    y <- estimateDisp(y, design)
    fit <- glmQLFit(y, design)
    qlf <- glmQLFTest(fit) # tests the last coef, grpB
    list(y = y, design = design, fit = fit, qlf = qlf)
  }))
}

run_test("DGEList: object class and dims", function() {
  y <- DGEList(counts = counts, group = grp)
  stopifnot(inherits(y, "DGEList"))
  stopifnot(identical(dim(y), c(n_genes, 2L * n_per)))
  stopifnot(nrow(y$counts) == n_genes, ncol(y$counts) == 2L * n_per)
  stopifnot(length(y$samples$group) == 2L * n_per)
})

run_test("calcNormFactors + estimateDisp: norm factors and dispersion", function() {
  y <- suppressWarnings(calcNormFactors(DGEList(counts = counts, group = grp)))
  nf <- y$samples$norm.factors
  stopifnot(length(nf) == 2L * n_per, all(is.finite(nf)), all(nf > 0))
  design <- model.matrix(~grp)
  y <- suppressWarnings(estimateDisp(y, design))
  stopifnot(is.finite(y$common.dispersion), y$common.dispersion > 0)
  stopifnot(length(y$tagwise.dispersion) == n_genes)
})

run_test("glmQLFit + glmQLFTest + topTags: table shape and columns", function() {
  res <- fit_edger()
  tt <- topTags(res$qlf, n = Inf)
  stopifnot(nrow(tt$table) == n_genes)
  stopifnot(all(c("logFC", "PValue", "FDR") %in% colnames(tt$table)))
})

run_test("topTags: planted genes rank near the top with correct sign", function() {
  res <- fit_edger()
  tab <- topTags(res$qlf, n = Inf)$table
  # topTags sorts by significance; the strong planted set should dominate the
  # most-significant end of the table.
  top50 <- rownames(tab)[1:50]
  stopifnot(sum(de_names %in% top50) >= 15L)
  # grpB is the tested coefficient, so positive logFC == higher in group B.
  stopifnot(median(tab[de_names, "logFC"]) > 2)
})

run_test("topTags: null genes are not significant on average", function() {
  res <- fit_edger()
  tab <- topTags(res$qlf, n = Inf)$table
  null_names <- sprintf("gene%03d", (n_de + 1L):n_genes)
  stopifnot(abs(median(tab[null_names, "logFC"])) < 0.5)
  stopifnot(median(tab[null_names, "FDR"]) > 0.1)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all edgeR smoke tests passed\n")
