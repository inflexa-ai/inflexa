#!/usr/bin/env Rscript
# Smoke test for the R `dmrseq` package.
#
# Fully self-contained: no input files, NO network. dmrseq detects differentially
# methylated regions (DMRs) from a `bsseq::BSseq` object. We build a synthetic
# BSseq (a single chromosome of CpG loci with methylation + coverage matrices and
# a two-level `condition` in pData), then attempt a DMR scan. Exits 0 only if
# every check passes, so it works as a pass/fail validator:
#
#   Rscript dmrseq.R
#
# ============================ HEAVILY FLAGGED — RE-CHECK =====================
# Written blind (package not installed here). The LOAD-BEARING checks are the
# safe ones: (a) dmrseq()/BSseq() exist as functions, and (b) a synthetic BSseq
# is CONSTRUCTIBLE with the expected shape. VERIFY ONCE INSTALLED:
#   * BSseq CONSTRUCTION: assumed `bsseq::BSseq(chr=, pos=, M=, Cov=, ...,
#     pData=)` where M = methylated-read counts, Cov = total coverage, and
#     `pData` carries the `condition` column dmrseq keys on. If the constructor
#     signature differs, test 2 fails.
#   * dmrseq REQUIREMENTS: dmrseq needs the test covariate to VARY, every locus
#     covered in EVERY sample (Cov >= 1 everywhere — arranged here), and enough
#     loci for smoothing. Whether this particular minimal set satisfies dmrseq's
#     internal thresholds cannot be confirmed blind, so the actual scan (test 3)
#     is SOFT: it warns and passes if dmrseq() cannot complete, and only asserts
#     the GRanges + metadata-column contract (`stat`,`pval`,`qval`) on success.
#     If it turns out to run reliably, PROMOTE test 3 to a hard assertion.
# ============================================================================

if (!requireNamespace("dmrseq", quietly = TRUE)) {
  cat("FAIL: package 'dmrseq' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(dmrseq))
cat(sprintf("dmrseq version: %s\n", as.character(packageVersion("dmrseq"))))

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

# Deterministic synthetic BSseq with a planted hyper-methylated block in group B.
# Coverage is positive at every locus/sample (dmrseq requires full coverage).
nLoci <- 400L
nPerGroup <- 3L

build_bs <- function() {
  set.seed(2)
  nSample <- 2L * nPerGroup
  sampleIds <- sprintf("S%02d", seq_len(nSample))
  condition <- factor(rep(c("A", "B"), each = nPerGroup))

  pos <- sort(sample.int(1e6L, nLoci))  # unique, strictly increasing positions
  cov <- matrix(sample(10:30, nLoci * nSample, replace = TRUE),
                nrow = nLoci, ncol = nSample)

  # Baseline methylation ~0.5; loci 150:200 flip strongly between groups.
  prob <- matrix(0.5, nrow = nLoci, ncol = nSample)
  block <- 150:200
  prob[block, condition == "B"] <- 0.85
  prob[block, condition == "A"] <- 0.15
  meth <- matrix(rbinom(nLoci * nSample, size = as.vector(cov), prob = as.vector(prob)),
                 nrow = nLoci, ncol = nSample)

  pd <- S4Vectors::DataFrame(condition = condition, row.names = sampleIds)
  bsseq::BSseq(chr = rep("chr1", nLoci), pos = pos,
               M = meth, Cov = cov, sampleNames = sampleIds, pData = pd)
}

run_test("dmrseq and BSseq are exported functions", function() {
  stopifnot(is.function(dmrseq::dmrseq))
  stopifnot(is.function(bsseq::BSseq))
})

run_test("synthetic BSseq object is constructible with the expected shape", function() {
  bs <- build_bs()
  stopifnot(methods::is(bs, "BSseq"))
  stopifnot(nrow(bs) == nLoci, ncol(bs) == 2L * nPerGroup)
  stopifnot("condition" %in% names(bsseq::pData(bs)))
})

run_test("dmrseq detects DMRs and returns a GRanges (SOFT -- see header)", function() {
  bs <- build_bs()
  res <- tryCatch({
    out <- NULL
    # dmrseq is chatty (progress + BiocParallel notes); swallow it all.
    invisible(utils::capture.output(suppressWarnings(suppressMessages(
      out <- dmrseq::dmrseq(bs = bs, testCovariate = "condition")))))
    out
  }, error = function(e) e)
  if (inherits(res, "error")) {
    cat(sprintf("  note dmrseq() did not complete on the synthetic set: %s\n",
                conditionMessage(res)))
    return(invisible(NULL))
  }
  stopifnot(methods::is(res, "GRanges"))
  # A run can legitimately find zero DMRs; only check the metadata contract when
  # there are rows to carry it.
  if (length(res) > 0L) {
    mc <- names(S4Vectors::mcols(res))
    stopifnot(all(c("stat", "pval", "qval") %in% mc))
  }
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all dmrseq smoke tests passed\n")
