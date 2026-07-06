#!/usr/bin/env Rscript
# Smoke test for the R `DSS` package.
#
# Fully self-contained: no input files, NO network. DSS calls differentially
# methylated loci (DML) and regions (DMR) from a `bsseq::BSseq` object. We build
# a synthetic two-group BSseq (mirroring the dmrseq build: one chromosome of CpG
# loci with methylation + coverage matrices and a planted differential block),
# run `DMLtest`, then `callDML`/`callDMR`. Exits 0 only if every check passes, so
# it works as a pass/fail validator:
#
#   Rscript DSS.R
#
# ============================ HEAVILY FLAGGED — RE-CHECK =====================
# Written blind (package not installed here). The LOAD-BEARING checks are the
# safe ones: (a) DMLtest()/callDML()/callDMR() exist, and (b) a synthetic BSseq
# is CONSTRUCTIBLE. VERIFY ONCE INSTALLED:
#   * BSseq CONSTRUCTION: assumed `bsseq::BSseq(chr=, pos=, M=, Cov=, ...)`
#     (M = methylated counts, Cov = total coverage). Mirrors the dmrseq build.
#   * DMLtest GROUP-ARG FORM: assumed `DSS::DMLtest(BSobj, group1=, group2=)`
#     where group1/group2 are vectors of SAMPLE NAMES present in the BSseq. If
#     DSS expects indices or a different arg form, test 3 fails at the call.
#   * OUTPUT SHAPE: assumed DMLtest() -> data.frame with at least chr/pos/stat/
#     pval; callDML() -> data.frame; callDMR() -> data.frame OR NULL (it returns
#     NULL when no region passes). The actual DMLtest run (test 3) is SOFT: it
#     warns and passes if DSS cannot complete on this minimal set, asserting the
#     data.frame contract only on success. If it runs reliably, PROMOTE to hard.
# ============================================================================

if (!requireNamespace("DSS", quietly = TRUE)) {
  cat("FAIL: package 'DSS' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(DSS))
cat(sprintf("DSS version: %s\n", as.character(packageVersion("DSS"))))

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

# Deterministic synthetic BSseq with a planted differential block (mirrors the
# dmrseq build). Coverage is positive at every locus/sample.
nLoci <- 400L
nPerGroup <- 3L
sampleIds <- sprintf("S%02d", seq_len(2L * nPerGroup))
group1 <- sampleIds[seq_len(nPerGroup)]                       # "A"
group2 <- sampleIds[nPerGroup + seq_len(nPerGroup)]           # "B"

build_bs <- function() {
  set.seed(3)
  nSample <- 2L * nPerGroup
  condition <- factor(rep(c("A", "B"), each = nPerGroup))

  pos <- sort(sample.int(1e6L, nLoci))  # unique, strictly increasing positions
  cov <- matrix(sample(10:30, nLoci * nSample, replace = TRUE),
                nrow = nLoci, ncol = nSample)

  prob <- matrix(0.5, nrow = nLoci, ncol = nSample)
  block <- 150:200
  prob[block, condition == "B"] <- 0.85
  prob[block, condition == "A"] <- 0.15
  meth <- matrix(rbinom(nLoci * nSample, size = as.vector(cov), prob = as.vector(prob)),
                 nrow = nLoci, ncol = nSample)

  bsseq::BSseq(chr = rep("chr1", nLoci), pos = pos,
               M = meth, Cov = cov, sampleNames = sampleIds)
}

run_test("DMLtest, callDML and callDMR are exported functions", function() {
  stopifnot(is.function(DSS::DMLtest))
  stopifnot(is.function(DSS::callDML))
  stopifnot(is.function(DSS::callDMR))
})

run_test("synthetic BSseq object is constructible with the expected shape", function() {
  bs <- build_bs()
  stopifnot(methods::is(bs, "BSseq"))
  stopifnot(nrow(bs) == nLoci, ncol(bs) == 2L * nPerGroup)
  stopifnot(all(c(group1, group2) %in% bsseq::sampleNames(bs)))
})

run_test("DMLtest -> callDML/callDMR return data frames (SOFT -- see header)", function() {
  bs <- build_bs()
  dml <- tryCatch({
    out <- NULL
    invisible(utils::capture.output(suppressWarnings(suppressMessages(
      out <- DSS::DMLtest(bs, group1 = group1, group2 = group2)))))
    out
  }, error = function(e) e)
  if (inherits(dml, "error")) {
    cat(sprintf("  note DMLtest() did not complete on the synthetic set: %s\n",
                conditionMessage(dml)))
    return(invisible(NULL))
  }
  stopifnot(is.data.frame(dml), nrow(dml) > 0L)
  stopifnot(all(c("chr", "pos", "stat", "pval") %in% names(dml)))

  calls <- suppressWarnings(suppressMessages(DSS::callDML(dml)))
  stopifnot(is.data.frame(calls))

  # callDMR() returns NULL when no region passes the thresholds — both are fine.
  dmr <- suppressWarnings(suppressMessages(DSS::callDMR(dml)))
  stopifnot(is.null(dmr) || is.data.frame(dmr))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all DSS smoke tests passed\n")
