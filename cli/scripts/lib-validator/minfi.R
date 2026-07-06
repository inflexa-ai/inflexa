#!/usr/bin/env Rscript
# Smoke test for the R `minfi` (Bioconductor) package.
#
# Fully self-contained: no input files, no network. minfi normally starts from
# raw Illumina 450K/EPIC methylation arrays (per-sample .idat files) read into
# an RGChannelSet -- which we do NOT have and must NOT fetch. But minfi's core
# methylation math is checkable OFFLINE by constructing a MethylSet directly
# from SYNTHETIC methylated/unmethylated intensity matrices (no IDATs, no array
# annotation needed), then verifying the beta / M-value definitions against
# their closed-form formulas. Exits 0 only if every check passes, so it can be
# used as a pass/fail library validator:
#
#   Rscript minfi.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# This is the richest offline test of the methylation set, but three minfi API
# details are load-bearing and MUST be re-verified once installed:
#   - CONSTRUCTOR: MethylSet(Meth = <matrix>, Unmeth = <matrix>) -- the two
#     assay args are capitalized "Meth"/"Unmeth". If those names drift the
#     "constructs" test fails first, flagging it.
#   - getBeta() OFFSET: beta = Meth / (Meth + Unmeth + offset) with the DEFAULT
#     offset = 100. The expected-beta below hardcodes 100; a changed default
#     would fail the beta test.
#   - getM() DEFAULT: assumed to be log2(Meth / Unmeth) for a raw MethylSet (the
#     type="" branch), NOT logit2(getBeta(...)). If minfi's default changed to a
#     beta-derived M, the M-value test fails -- re-confirm the definition.
# The intensities are drawn strictly positive so beta is well-defined in (0,1)
# and log2(Meth/Unmeth) is finite; checks are tolerance/structural, never
# equality on anything sampled.
# ============================================================================

if (!requireNamespace("minfi", quietly = TRUE)) {
  cat("FAIL: package 'minfi' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(minfi))
cat(sprintf("minfi version: %s\n", as.character(packageVersion("minfi"))))

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

# Synthetic methylation intensities: 50 CpG probes x 4 samples, strictly
# positive (drawn in [200, 8000]) so beta in (0,1) and log2(Meth/Unmeth) finite.
# Fixed seed -> deterministic; rownames are cg-style probe ids, colnames sample
# ids, matching what a real MethylSet carries.
set.seed(42)
n_probes <- 50L
n_samples <- 4L
meth <- matrix(runif(n_probes * n_samples, 200, 8000), nrow = n_probes, ncol = n_samples)
unmeth <- matrix(runif(n_probes * n_samples, 200, 8000), nrow = n_probes, ncol = n_samples)
probe_ids <- sprintf("cg%08d", seq_len(n_probes))
sample_ids <- paste0("sample", seq_len(n_samples))
rownames(meth) <- rownames(unmeth) <- probe_ids
colnames(meth) <- colnames(unmeth) <- sample_ids

# The offset getBeta() uses by default -- see ASSUMPTIONS block above.
beta_offset <- 100

run_test("MethylSet constructs from Meth/Unmeth intensity matrices", function() {
  ms <- MethylSet(Meth = meth, Unmeth = unmeth)
  stopifnot(inherits(ms, "MethylSet"))
  stopifnot(nrow(ms) == n_probes, ncol(ms) == n_samples)
  stopifnot(identical(dim(ms), c(n_probes, n_samples)))
})

run_test("getMeth / getUnmeth round-trip the input intensities", function() {
  ms <- MethylSet(Meth = meth, Unmeth = unmeth)
  m_back <- as.matrix(getMeth(ms))
  u_back <- as.matrix(getUnmeth(ms))
  stopifnot(identical(dim(m_back), dim(meth)))
  stopifnot(isTRUE(all.equal(m_back, meth, tolerance = 1e-8, check.attributes = FALSE)))
  stopifnot(isTRUE(all.equal(u_back, unmeth, tolerance = 1e-8, check.attributes = FALSE)))
  # Probe/sample names survive the round-trip.
  stopifnot(identical(rownames(m_back), probe_ids))
  stopifnot(identical(colnames(m_back), sample_ids))
})

run_test("getBeta returns [0,1] matching Meth/(Meth+Unmeth+offset)", function() {
  ms <- MethylSet(Meth = meth, Unmeth = unmeth)
  beta <- as.matrix(getBeta(ms))
  stopifnot(identical(dim(beta), dim(meth)))
  stopifnot(all(is.finite(beta)), all(beta >= 0), all(beta <= 1))
  expected_beta <- meth / (meth + unmeth + beta_offset)
  stopifnot(isTRUE(all.equal(beta, expected_beta, tolerance = 1e-8, check.attributes = FALSE)))
})

run_test("getM equals log2(Meth/Unmeth)", function() {
  ms <- MethylSet(Meth = meth, Unmeth = unmeth)
  mval <- as.matrix(getM(ms))
  stopifnot(identical(dim(mval), dim(meth)))
  stopifnot(all(is.finite(mval)))
  expected_m <- log2(meth / unmeth)
  stopifnot(isTRUE(all.equal(mval, expected_m, tolerance = 1e-6, check.attributes = FALSE)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all minfi smoke tests passed\n")
