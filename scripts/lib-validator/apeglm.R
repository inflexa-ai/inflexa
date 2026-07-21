#!/usr/bin/env Rscript
# Smoke test for the R `apeglm` package (adaptive shrinkage of log-fold-changes).
#
# apeglm exists in this store for exactly one reason: it is the default backend
# of DESeq2's lfcShrink(), and the shrinkage estimator that
# skills/bulk-transcriptomics prescribes. So this validator exercises it THROUGH
# lfcShrink() rather than through apeglm's own low-level nbinomGLM() API — the
# prescribed call path is the one worth guarding.
#
# Why it is worth guarding: DESeq2 only *Suggests* apeglm, so nothing installs it
# transitively. `library(DESeq2)` succeeds without it and only the lfcShrink()
# call fails, which is how a store shipped where every documented shrinkage call
# errored. A DESeq2-only smoke test cannot catch that; this one can.
#
# Depends on DESeq2 in addition to apeglm (unavoidable — see above); both are
# guarded below. All data is simulated with a fixed seed, and every check is
# structural or tolerance-based, never exact floating-point equality. Exits 0
# only if every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript apeglm.R

if (!requireNamespace("apeglm", quietly = TRUE)) {
  cat("FAIL: package 'apeglm' is not installed\n")
  quit(save = "no", status = 1)
}
if (!requireNamespace("DESeq2", quietly = TRUE)) {
  cat("FAIL: package 'DESeq2' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(DESeq2))
cat(sprintf("apeglm version: %s\n", as.character(packageVersion("apeglm"))))

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

# Simulate a 200-gene x 6-sample count matrix: two conditions, 3 vs 3. The first
# 20 genes (the planted DE set) get a strong ~8x up-shift in condition B; the
# remaining 180 are null. The planted/null split is what makes the shrinkage
# checks meaningful — shrinkage should pull noisy null estimates toward zero
# while leaving a real, well-supported effect substantially intact.
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
# The coefficient apeglm shrinks. Named rather than positional so a change in
# resultsNames() ordering fails loudly here instead of silently shrinking the
# intercept.
coef_name <- "cond_B_vs_A"

run_test("resultsNames exposes the expected coefficient", function() {
  stopifnot(coef_name %in% resultsNames(dds))
})

run_test("lfcShrink(type='apeglm'): table shape and required columns", function() {
  s <- suppressMessages(lfcShrink(dds, coef = coef_name, type = "apeglm", quiet = TRUE))
  stopifnot(nrow(s) == n_genes)
  stopifnot(all(c("baseMean", "log2FoldChange", "lfcSE") %in% colnames(s)))
  stopifnot(sum(is.finite(s$log2FoldChange)) > 0.9 * n_genes)
})

run_test("lfcShrink(type='apeglm'): planted DE effect survives shrinkage", function() {
  s <- suppressMessages(lfcShrink(dds, coef = coef_name, type = "apeglm", quiet = TRUE))
  lfc <- s$log2FoldChange[de_idx]
  # ~8x up in B: sign preserved and still clearly non-trivial after shrinkage.
  stopifnot(all(is.finite(lfc)), all(lfc > 1))
})

run_test("lfcShrink(type='apeglm'): null genes pulled toward zero", function() {
  raw <- results(dds, name = coef_name)
  s <- suppressMessages(lfcShrink(dds, coef = coef_name, type = "apeglm", quiet = TRUE))
  # The defining property of shrinkage: noisy null estimates move toward 0.
  # Compared on medians so a single gene cannot decide the outcome.
  m_raw <- median(abs(raw$log2FoldChange[null_idx]), na.rm = TRUE)
  m_shr <- median(abs(s$log2FoldChange[null_idx]), na.rm = TRUE)
  stopifnot(is.finite(m_raw), is.finite(m_shr), m_shr <= m_raw)
})

run_test("lfcShrink(type='apeglm', lfcThreshold=): returns s-values", function() {
  s <- suppressMessages(lfcShrink(
    dds,
    coef = coef_name,
    type = "apeglm",
    lfcThreshold = 1,
    quiet = TRUE
  ))
  # The documented behaviour of thresholded shrinkage: s-values REPLACE p-values.
  # Asserting the swap (not just presence) is what pins the documented contract.
  stopifnot("svalue" %in% colnames(s))
  stopifnot(!("pvalue" %in% colnames(s)))
  sv <- s$svalue[is.finite(s$svalue)]
  stopifnot(length(sv) > 0, all(sv >= 0), all(sv <= 1))
})

run_test("lfcShrink(type='apeglm'): rejects contrast=", function() {
  # apeglm is coef-only. The skill documents this constraint and routes
  # contrast-based shrinkage to ashr, so pin it: if apeglm ever accepted
  # contrast=, that guidance would be stale.
  err <- tryCatch({
    suppressMessages(lfcShrink(
      dds,
      contrast = c("cond", "B", "A"),
      type = "apeglm",
      quiet = TRUE
    ))
    NULL
  }, error = function(e) conditionMessage(e))
  stopifnot(!is.null(err))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all apeglm smoke tests passed\n")
