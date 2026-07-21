#!/usr/bin/env Rscript
# Smoke test for the R `ashr` package (adaptive shrinkage, empirical Bayes).
#
# ashr is in this store as the second backend of DESeq2's lfcShrink() — the one
# that accepts `contrast=`, which apeglm does not. skills/bulk-transcriptomics
# routes arbitrary-contrast shrinkage here for exactly that reason, so this
# validator exercises ashr THROUGH lfcShrink() rather than through ashr's own
# ash() API: the prescribed call path is the one worth guarding.
#
# Why it is worth guarding: DESeq2 only *Suggests* ashr, so nothing installs it
# transitively. `library(DESeq2)` succeeds without it and only the lfcShrink()
# call fails. A DESeq2-only smoke test cannot catch that; this one can.
#
# Depends on DESeq2 in addition to ashr (unavoidable — see above); both are
# guarded below. All data is simulated with a fixed seed, and every check is
# structural or tolerance-based, never exact floating-point equality. Exits 0
# only if every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript ashr.R

if (!requireNamespace("ashr", quietly = TRUE)) {
  cat("FAIL: package 'ashr' is not installed\n")
  quit(save = "no", status = 1)
}
if (!requireNamespace("DESeq2", quietly = TRUE)) {
  cat("FAIL: package 'DESeq2' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(DESeq2))
cat(sprintf("ashr version: %s\n", as.character(packageVersion("ashr"))))

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

# Same simulated design as apeglm.R: 200 genes x 6 samples, 3 vs 3, with the
# first 20 genes planted ~8x up in condition B and the rest null. The
# planted/null split is what makes the shrinkage checks meaningful.
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
b_cols <- (n_per + 1L):(2L * n_per)
counts[1:n_de, b_cols] <- rpois(n_de * n_per, lambda = base_mu * 8)
rownames(counts) <- sprintf("gene%03d", seq_len(n_genes))
colnames(counts) <- sprintf("s%d", seq_len(2L * n_per))
cond <- factor(rep(c("A", "B"), each = n_per))
de_idx <- 1:n_de
null_idx <- (n_de + 1L):n_genes

dds <- local({
  d <- DESeqDataSetFromMatrix(
    countData = counts,
    colData = DataFrame(cond = cond),
    design = ~cond
  )
  suppressMessages(DESeq(d))
})
coef_name <- "cond_B_vs_A"
the_contrast <- c("cond", "B", "A")

run_test("lfcShrink(type='ashr', contrast=): table shape and columns", function() {
  # The capability ashr is staged for: shrinkage addressed by contrast rather
  # than by coefficient.
  s <- suppressMessages(lfcShrink(dds, contrast = the_contrast, type = "ashr", quiet = TRUE))
  stopifnot(nrow(s) == n_genes)
  stopifnot(all(c("baseMean", "log2FoldChange", "lfcSE") %in% colnames(s)))
  stopifnot(sum(is.finite(s$log2FoldChange)) > 0.9 * n_genes)
})

run_test("lfcShrink(type='ashr'): also accepts coef=", function() {
  s <- suppressMessages(lfcShrink(dds, coef = coef_name, type = "ashr", quiet = TRUE))
  stopifnot(nrow(s) == n_genes)
  stopifnot(sum(is.finite(s$log2FoldChange)) > 0.9 * n_genes)
})

run_test("lfcShrink(type='ashr'): planted DE effect survives shrinkage", function() {
  s <- suppressMessages(lfcShrink(dds, contrast = the_contrast, type = "ashr", quiet = TRUE))
  lfc <- s$log2FoldChange[de_idx]
  stopifnot(all(is.finite(lfc)), all(lfc > 1))
})

run_test("lfcShrink(type='ashr'): null genes pulled toward zero", function() {
  raw <- results(dds, contrast = the_contrast)
  s <- suppressMessages(lfcShrink(dds, contrast = the_contrast, type = "ashr", quiet = TRUE))
  m_raw <- median(abs(raw$log2FoldChange[null_idx]), na.rm = TRUE)
  m_shr <- median(abs(s$log2FoldChange[null_idx]), na.rm = TRUE)
  stopifnot(is.finite(m_raw), is.finite(m_shr), m_shr <= m_raw)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all ashr smoke tests passed\n")
