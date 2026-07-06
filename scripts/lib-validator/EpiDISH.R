#!/usr/bin/env Rscript
# Smoke test for the R `EpiDISH` package.
#
# Fully self-contained: no input files, NO network. EpiDISH estimates cell-type
# fractions from a methylation (or expression) mixture given a reference profile
# — a task that is GENUINELY testable OFFLINE with synthetic matrices, because
# the answer is planted by construction. We build a random reference `ref`
# (CpGs x cell types), draw known mixing proportions `trueF` (cell types x
# samples), form the observed mixture `beta = ref %*% trueF` (+ tiny noise), run
# the deconvolution, and check the recovered fractions against what we planted.
# Exits 0 only if every check passes, so it works as a pass/fail validator:
#
#   Rscript EpiDISH.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# Written blind (package not installed here). VERIFY ONCE INSTALLED:
#   * epidish() ARG NAMES: assumed `beta.m` (mixture) and `ref.m` (reference),
#     with `method %in% {"RPC","CBS","CP"}`. If these names changed, the RPC
#     test below fails at the call site — that is the signal to re-check.
#   * estF ORIENTATION: assumed `out$estF` is a matrix of SAMPLES (rows) x
#     CELL TYPES (cols). The shape assertion pins this; if EpiDISH transposed
#     it, that assertion fails. The correlation test aligns by dimnames so it
#     is robust to column/row reordering but NOT to a full transpose.
#   * method="CBS" (CIBERSORT-style nu-SVR) needs `e1071`; kept SOFT so a
#     missing optional dep only warns, never false-fails a healthy install.
# ============================================================================

if (!requireNamespace("EpiDISH", quietly = TRUE)) {
  cat("FAIL: package 'EpiDISH' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(EpiDISH))
cat(sprintf("EpiDISH version: %s\n", as.character(packageVersion("EpiDISH"))))

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

# Deterministic synthetic deconvolution problem with a KNOWN answer.
# Rebuilt identically on each call (fixed seed) so every test shares one truth.
build_mix <- function() {
  set.seed(1)
  nCpG <- 200L
  cellTypes <- c("CT1", "CT2", "CT3")
  nCT <- length(cellTypes)
  nSample <- 5L
  cpgIds <- sprintf("cg%05d", seq_len(nCpG))
  sampleIds <- sprintf("S%02d", seq_len(nSample))

  # Reference: CpGs x cell types, methylation-beta values in [0, 1].
  ref <- matrix(runif(nCpG * nCT), nrow = nCpG, ncol = nCT,
                dimnames = list(cpgIds, cellTypes))

  # Planted proportions: cell types x samples, each SAMPLE column sums to 1.
  raw <- matrix(runif(nCT * nSample), nrow = nCT, ncol = nSample,
                dimnames = list(cellTypes, sampleIds))
  trueF <- sweep(raw, 2, colSums(raw), "/")

  # Observed mixture = exact linear combination of the reference + small noise,
  # clamped back into [0, 1] as a real methylation beta matrix would be.
  beta <- ref %*% trueF + matrix(rnorm(nCpG * nSample, sd = 0.01), nrow = nCpG)
  beta <- pmin(pmax(beta, 0), 1)
  dimnames(beta) <- list(cpgIds, sampleIds)

  list(beta = beta, ref = ref, trueF = trueF)
}

run_test("RPC deconvolution returns an estF matrix of the right shape", function() {
  d <- build_mix()
  out <- EpiDISH::epidish(beta.m = d$beta, ref.m = d$ref, method = "RPC")
  stopifnot(is.list(out), !is.null(out$estF))
  est <- out$estF
  # SAMPLES x CELL TYPES — see header ASSUMPTIONS.
  stopifnot(is.matrix(est))
  stopifnot(nrow(est) == ncol(d$beta), ncol(est) == ncol(d$ref))
})

run_test("estF fractions lie in [0,1] and sum to ~1 per sample", function() {
  d <- build_mix()
  est <- EpiDISH::epidish(beta.m = d$beta, ref.m = d$ref, method = "RPC")$estF
  stopifnot(all(est >= -1e-8), all(est <= 1 + 1e-8))
  # RPC constrains each estimate to non-negative fractions that renormalize to 1.
  stopifnot(max(abs(rowSums(est) - 1)) < 1e-2)
})

run_test("recovered fractions correlate with the planted proportions", function() {
  d <- build_mix()
  est <- EpiDISH::epidish(beta.m = d$beta, ref.m = d$ref, method = "RPC")$estF
  planted <- t(d$trueF)  # samples x cell types, matching estF orientation
  # Align by name so the check survives any column/row reordering.
  est <- est[rownames(planted), colnames(planted), drop = FALSE]
  r <- cor(as.vector(est), as.vector(planted))
  # Exact linear mixture + tiny noise => near-perfect recovery; 0.7 is a floor.
  stopifnot(is.finite(r), r > 0.7)
})

run_test("CBS method also runs and returns a well-shaped estF (SOFT)", function() {
  d <- build_mix()
  res <- tryCatch(
    EpiDISH::epidish(beta.m = d$beta, ref.m = d$ref, method = "CBS"),
    error = function(e) e)
  if (inherits(res, "error")) {
    # e1071 (nu-SVR backend) may be absent offline — warn, do NOT fail.
    cat(sprintf("  note CBS did not run (optional dep?): %s\n", conditionMessage(res)))
    return(invisible(NULL))
  }
  est <- res$estF
  stopifnot(is.matrix(est), nrow(est) == ncol(d$beta), ncol(est) == ncol(d$ref))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all EpiDISH smoke tests passed\n")
