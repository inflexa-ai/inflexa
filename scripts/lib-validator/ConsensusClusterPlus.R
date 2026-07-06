#!/usr/bin/env Rscript
# Smoke test for the R `ConsensusClusterPlus` package.
#
# Fully self-contained: no input files, NO network. Runs consensus clustering on
# a small synthetic feature-by-sample matrix (fixed seed) and inspects the
# per-k result structure. ConsensusClusterPlus DRAWS diagnostic plots as a side
# effect, so every call is wrapped in a throwaway pdf() null device (opened on a
# tempfile, closed + unlinked on exit) and its file output is directed at a temp
# dir that is removed on exit -- no interactive device is opened, nothing is left
# behind. Checks are STRUCTURAL (list length, per-k class labels + consensus
# matrix dims) rather than numeric equality on the random resampling. Exits 0
# only if every check passes, so it can be used as a pass/fail validator:
#
#   Rscript ConsensusClusterPlus.R
#
# ======================= ASSUMPTIONS TO RE-CHECK ============================
# Written from the ConsensusClusterPlus contract rather than a live install:
#
#  * SIGNATURE: ConsensusClusterPlus(d, maxK, reps, pItem, pFeature, title,
#    plot=NULL, seed, verbose). `d` is FEATURES x SAMPLES. `title` is a directory
#    for file output. plot=NULL draws to the CURRENT device (hence the null pdf
#    wrapper); plot="pdf"/"png" would instead write image files under `title`.
#
#  * RETURN: a list of length maxK. Element [[1]] (k=1) is an empty placeholder;
#    element [[k]] for k>=2 is a list with:
#       $consensusMatrix -- numeric matrix, (n samples) x (n samples)
#       $consensusClass  -- integer cluster labels, length == n samples, in 1..k
#    RE-VERIFY these element names and that [[1]] is the empty slot once a build
#    is available.
# ============================================================================

if (!requireNamespace("ConsensusClusterPlus", quietly = TRUE)) {
  cat("FAIL: package 'ConsensusClusterPlus' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(ConsensusClusterPlus))
cat(sprintf("ConsensusClusterPlus version: %s\n",
            as.character(packageVersion("ConsensusClusterPlus"))))

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

# Synthetic data: 20 features x 40 samples. ConsensusClusterPlus expects the
# matrix oriented features-in-rows, samples-in-columns.
n_samples <- 40L
maxK <- 4L

run_test("ConsensusClusterPlus returns a per-k consensus result list", function() {
  set.seed(1)
  d <- matrix(rnorm(20 * n_samples), nrow = 20, ncol = n_samples)

  title_dir <- tempfile("ccp-")
  null_dev <- tempfile("ccp-null-", fileext = ".pdf")
  # Swallow ALL of ConsensusClusterPlus's drawing into a throwaway pdf device,
  # and clean up both the device file and any title-dir output on exit.
  grDevices::pdf(null_dev)
  on.exit({
    grDevices::dev.off()
    unlink(null_dev)
    unlink(title_dir, recursive = TRUE)
  }, add = TRUE)

  res <- suppressWarnings(suppressMessages(
    ConsensusClusterPlus(d, maxK = maxK, reps = 10, pItem = 0.8,
                         pFeature = 1, title = title_dir,
                         plot = NULL, seed = 1, verbose = FALSE)))

  stopifnot(is.list(res), length(res) == maxK)
})

run_test("each k>=2 carries consensusClass + consensusMatrix of right dims", function() {
  set.seed(1)
  d <- matrix(rnorm(20 * n_samples), nrow = 20, ncol = n_samples)

  title_dir <- tempfile("ccp-")
  null_dev <- tempfile("ccp-null-", fileext = ".pdf")
  grDevices::pdf(null_dev)
  on.exit({
    grDevices::dev.off()
    unlink(null_dev)
    unlink(title_dir, recursive = TRUE)
  }, add = TRUE)

  res <- suppressWarnings(suppressMessages(
    ConsensusClusterPlus(d, maxK = maxK, reps = 10, pItem = 0.8,
                         pFeature = 1, title = title_dir,
                         plot = NULL, seed = 1, verbose = FALSE)))

  for (k in 2:maxK) {
    ck <- res[[k]]
    stopifnot(is.list(ck))
    stopifnot(!is.null(ck$consensusClass))
    stopifnot(length(ck$consensusClass) == n_samples)
    # k clusters -> labels fall within 1..k
    stopifnot(all(ck$consensusClass >= 1L), all(ck$consensusClass <= k))
    stopifnot(!is.null(ck$consensusMatrix))
    cm <- ck$consensusMatrix
    stopifnot(is.matrix(cm))
    stopifnot(nrow(cm) == n_samples, ncol(cm) == n_samples)
    # consensus values are proportions in [0, 1]
    stopifnot(all(cm >= 0), all(cm <= 1))
  }
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all ConsensusClusterPlus smoke tests passed\n")
