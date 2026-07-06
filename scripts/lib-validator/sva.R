#!/usr/bin/env Rscript
# Smoke test for the R `sva` package.
#
# Fully self-contained: no input files, no network, no packages beyond
# sva itself (and the dependencies it implies, e.g. mgcv / genefilter). All
# data is simulated with a fixed seed; batch-correction checks are structural
# / tolerance-based (inequalities on variance, never exact floating-point
# equality). Exercises the core API surface and exits 0 only if every check
# passes, so it can be used as a pass/fail library validator:
#
#   Rscript sva.R

if (!requireNamespace("sva", quietly = TRUE)) {
  cat("FAIL: package 'sva' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(sva))
cat(sprintf("sva version: %s\n", as.character(packageVersion("sva"))))

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

# Simulate a 500-gene x 20-sample expression matrix with a PRIMARY condition
# (A vs B, 10 each) AND a HIDDEN batch that is balanced within each condition
# (5 batch-1 + 5 batch-2 per condition, so batch is not confounded with the
# condition). The primary effect lives on the first 50 genes; the batch adds
# a strong per-gene shift to every batch-2 sample -- unwanted variation that
# sva should capture and ComBat should remove.
set.seed(1)
n_genes <- 500L
n_per <- 10L
n_samples <- 2L * n_per
cond <- factor(rep(c("A", "B"), each = n_per))
batch <- factor(rep(rep(c(1L, 2L), each = n_per %/% 2L), times = 2L))

edata <- matrix(rnorm(n_genes * n_samples), nrow = n_genes, ncol = n_samples)
edata[1:50, cond == "B"] <- edata[1:50, cond == "B"] + 3
batch_shift <- rnorm(n_genes, mean = 0, sd = 2)
edata[, batch == "2"] <- edata[, batch == "2"] + batch_shift
rownames(edata) <- sprintf("gene%03d", seq_len(n_genes))
colnames(edata) <- sprintf("s%02d", seq_len(n_samples))

mod <- model.matrix(~cond)
mod0 <- model.matrix(~1, data = data.frame(cond = cond))

# sva() and ComBat() print progress via cat(); capture.output swallows it so
# the harness output stays clean, while suppressMessages/suppressWarnings
# silence benign chatter. Genuine errors still propagate to run_test.
run_sva <- function(n.sv) {
  svobj <- NULL
  invisible(capture.output(
    svobj <- suppressMessages(suppressWarnings(
      sva(edata, mod, mod0, n.sv = n.sv)
    ))
  ))
  svobj
}
run_combat <- function() {
  adjusted <- NULL
  invisible(capture.output(
    adjusted <- suppressMessages(suppressWarnings(
      ComBat(edata, batch = batch)
    ))
  ))
  adjusted
}

run_test("num.sv: non-negative integer surrogate-variable count", function() {
  n.sv <- num.sv(edata, mod)
  stopifnot(length(n.sv) == 1L, is.finite(n.sv))
  stopifnot(n.sv >= 0, n.sv == as.integer(n.sv))
})

run_test("sva: surrogate variables recovered with correct dims", function() {
  n.sv <- num.sv(edata, mod)
  # The strong planted batch guarantees at least one SV; guard so sva() is
  # never asked to estimate zero surrogate variables.
  if (n.sv < 1L) n.sv <- 1L
  svobj <- run_sva(n.sv)
  stopifnot(is.list(svobj))
  stopifnot(svobj$n.sv >= 0, svobj$n.sv == as.integer(svobj$n.sv))
  stopifnot(is.matrix(svobj$sv))
  stopifnot(nrow(svobj$sv) == n_samples)
  stopifnot(ncol(svobj$sv) == svobj$n.sv)
  stopifnot(all(is.finite(svobj$sv)))
})

run_test("ComBat: shrinks between-batch variance", function() {
  # Per-gene mean difference between the two batches, before correction.
  before <- rowMeans(edata[, batch == "2"]) - rowMeans(edata[, batch == "1"])
  adjusted <- run_combat()
  stopifnot(is.matrix(adjusted), identical(dim(adjusted), dim(edata)))
  after <- rowMeans(adjusted[, batch == "2"]) - rowMeans(adjusted[, batch == "1"])
  # ComBat harmonizes batch means: the typical absolute between-batch gap
  # must shrink substantially versus the uncorrected data (inequality only).
  stopifnot(median(abs(after)) < median(abs(before)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all sva smoke tests passed\n")
