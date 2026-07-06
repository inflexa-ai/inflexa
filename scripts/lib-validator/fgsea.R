#!/usr/bin/env Rscript
# Smoke test for the R `fgsea` (Bioconductor) package.
#
# Fully self-contained: no input files, NO network. fgsea runs preranked gene
# set enrichment analysis; this test SIMULATES a named ranked statistic vector
# and a list of gene sets (pathways), planting one strongly-enriched pathway so
# the outcome is deterministic. Nothing reaches an online pathway database.
# Exits 0 only if every check passes, so it can be used as a pass/fail library
# validator:
#
#   Rscript fgsea.R
#
# ============================ API UNCERTAINTY ================================
# RE-CHECK once installed:
#
#   * COLUMN NAMES: fgsea() returns a data.table whose columns are assumed to
#     be pathway / pval / padj / log2err / ES / NES / size / leadingEdge. The
#     load-bearing assertions check pathway/pval/padj/ES/NES presence -- if a
#     future release renames any of these the shape test flags it.
#
#   * ENTRY POINT: fgsea() dispatches to the multilevel algorithm in current
#     releases; fgseaMultilevel(pathways=, stats=, ...) is the explicit form and
#     is interchangeable here. Both take `pathways` (named list) and `stats`
#     (named numeric vector); size gating via minSize/maxSize.
#
# The enrichment RANK/SIGN checks are robust (a +3 SD shift on 30/500 genes),
# not exact p-values, so BiocParallel RNG variation cannot false-fail them.
# ============================================================================

if (!requireNamespace("fgsea", quietly = TRUE)) {
  cat("FAIL: package 'fgsea' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(fgsea))
cat(sprintf("fgsea version: %s\n", as.character(packageVersion("fgsea"))))

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

# Deterministic ranked statistics over 500 genes. The 30 genes of the planted
# pathway get a strong positive shift so they cluster at the top of the ranking
# -> the planted pathway must earn the largest |NES| with a positive sign.
set.seed(1)
n_genes <- 500L
gene_ids <- paste0("g", seq_len(n_genes))
stats <- rnorm(n_genes)
names(stats) <- gene_ids
planted_genes <- gene_ids[1:30]
stats[planted_genes] <- stats[planted_genes] + 3
stats <- sort(stats, decreasing = TRUE)

pathways <- list(
  planted = planted_genes,
  decoyA = sample(gene_ids, 25),
  decoyB = sample(gene_ids, 40)
)

run_test("fgsea returns the expected result columns", function() {
  res <- suppressWarnings(fgsea::fgsea(
    pathways = pathways, stats = stats, minSize = 5, maxSize = 200))
  stopifnot(is.data.frame(res))
  stopifnot(all(c("pathway", "pval", "padj", "ES", "NES") %in% colnames(res)))
})

run_test("one result row per size-eligible pathway", function() {
  res <- suppressWarnings(fgsea::fgsea(
    pathways = pathways, stats = stats, minSize = 5, maxSize = 200))
  # all three pathways fall inside [5, 200], so none are dropped
  stopifnot(nrow(res) == length(pathways))
  stopifnot(setequal(res$pathway, names(pathways)))
})

run_test("p-values and NES are valid numerics", function() {
  res <- suppressWarnings(fgsea::fgsea(
    pathways = pathways, stats = stats, minSize = 5, maxSize = 200))
  stopifnot(all(is.finite(res$NES)))
  stopifnot(all(res$pval >= 0 & res$pval <= 1))
  stopifnot(all(res$padj >= 0 & res$padj <= 1))
})

run_test("planted pathway has the largest |NES|, positive sign", function() {
  res <- suppressWarnings(fgsea::fgsea(
    pathways = pathways, stats = stats, minSize = 5, maxSize = 200))
  top <- res$pathway[which.max(abs(res$NES))]
  stopifnot(identical(top, "planted"))
  nes_planted <- res$NES[res$pathway == "planted"]
  stopifnot(length(nes_planted) == 1L, nes_planted > 0)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all fgsea smoke tests passed\n")
