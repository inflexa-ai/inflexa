#!/usr/bin/env Rscript
# Smoke test for the R `EnhancedVolcano` (Bioconductor) package.
#
# Fully self-contained: no input files, NO network, NO graphics device opened.
# EnhancedVolcano builds a ggplot volcano plot from a differential-expression
# results table; this test SIMULATES such a table (log2 fold changes + p-values
# with gene rownames) and asserts the returned object is a ggplot WITHOUT ever
# printing/drawing it (construction alone is the smoke test). Exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript EnhancedVolcano.R
#
# ============================ API UNCERTAINTY ================================
# RE-CHECK once installed:
#
#   * EnhancedVolcano(toptable, lab, x, y, ...) is assumed -- `toptable` is the
#     results data.frame, `lab` the point labels (here rownames), `x`/`y` the
#     COLUMN NAMES holding log2FC and (raw) p-value. The function RETURNS a
#     ggplot object; it does not draw unless printed.
#
#   * The returned object is asserted to inherit "ggplot" (and "gg"). Optional
#     args pCutoff / FCcutoff / title are exercised in the last test; re-check
#     those names if the extended call errors.
# ============================================================================

if (!requireNamespace("EnhancedVolcano", quietly = TRUE)) {
  cat("FAIL: package 'EnhancedVolcano' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(EnhancedVolcano))
cat(sprintf("EnhancedVolcano version: %s\n", as.character(packageVersion("EnhancedVolcano"))))

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

# Synthetic DE results: 500 genes, rownames "g1".."g500". A subset is pushed to
# large |log2FC| and tiny p-values so the plot has genuine "hits" to render.
set.seed(123)
n <- 500L
gene_ids <- paste0("g", seq_len(n))
lfc <- rnorm(n, sd = 1.5)
pval <- runif(n, min = 1e-8, max = 1)
hits <- 1:25
lfc[hits] <- sample(c(-1, 1), length(hits), replace = TRUE) * runif(length(hits), 3, 6)
pval[hits] <- 10^(-runif(length(hits), 6, 12))
res <- data.frame(
  log2FoldChange = lfc,
  pvalue = pval,
  row.names = gene_ids,
  stringsAsFactors = FALSE
)

run_test("EnhancedVolcano returns a ggplot object", function() {
  p <- suppressWarnings(suppressMessages(EnhancedVolcano::EnhancedVolcano(
    res, lab = rownames(res), x = "log2FoldChange", y = "pvalue")))
  stopifnot(inherits(p, "ggplot"), inherits(p, "gg"))
})

run_test("the plot carries at least one drawn layer", function() {
  p <- suppressWarnings(suppressMessages(EnhancedVolcano::EnhancedVolcano(
    res, lab = rownames(res), x = "log2FoldChange", y = "pvalue")))
  stopifnot(is.list(p$layers), length(p$layers) > 0L)
})

run_test("explicit cutoffs and title still yield a ggplot", function() {
  p <- suppressWarnings(suppressMessages(EnhancedVolcano::EnhancedVolcano(
    res, lab = rownames(res), x = "log2FoldChange", y = "pvalue",
    pCutoff = 1e-5, FCcutoff = 2, title = "smoke")))
  stopifnot(inherits(p, "ggplot"))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all EnhancedVolcano smoke tests passed\n")
