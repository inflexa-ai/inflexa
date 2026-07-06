#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `Spectra` package.
#
# Fully self-contained: no input files, NO network, no packages beyond Spectra
# itself (a Bioconductor MS package that attaches ProtGenerics / S4Vectors /
# BiocGenerics). All data is built in memory: two synthetic MS2 spectra described
# as an S4Vectors DataFrame with scalar spectra variables plus per-peak list
# columns. Checks are structural / exact on the values we put in. Exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript Spectra.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# Spectra is NOT installed in this environment, so the bodies below are written
# correct-by-review and could NOT be executed. Re-confirm once a build exists:
#   - The DataFrame-backend construction path: a DataFrame with scalar columns
#     (msLevel, rtime) plus LIST columns `mz`/`intensity` (one numeric vector
#     per spectrum), passed straight to Spectra(spd), yields a 2-spectrum object
#     backed by the in-memory backend. This is the load-bearing API to verify.
#   - mz()/intensity() return a list-like (NumericList) indexable with [[ ]] and
#     answering lengths(); msLevel()/rtime() return plain per-spectrum vectors.
# ============================================================================

if (!requireNamespace("Spectra", quietly = TRUE)) {
  cat("FAIL: package 'Spectra' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(Spectra))
cat(sprintf("Spectra version: %s\n", as.character(packageVersion("Spectra"))))

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

# Two synthetic MS2 spectra. Scalar spectra variables (msLevel, rtime) are plain
# columns; the peaks are LIST columns holding one numeric vector per spectrum.
# This DataFrame is Spectra's documented in-memory construction input.
spd <- S4Vectors::DataFrame(msLevel = c(2L, 2L), rtime = c(10.1, 10.5))
spd$mz <- list(c(100.1, 150.2, 200.3), c(110.0, 220.0))
spd$intensity <- list(c(10, 20, 30), c(5, 15))

run_test("Spectra builds from a DataFrame backend", function() {
  sp <- Spectra(spd)
  stopifnot(inherits(sp, "Spectra"))
  stopifnot(length(sp) == 2L)
})

run_test("scalar spectra variables round-trip (msLevel, rtime)", function() {
  sp <- Spectra(spd)
  stopifnot(identical(msLevel(sp), c(2L, 2L)))
  stopifnot(isTRUE(all.equal(rtime(sp), c(10.1, 10.5))))
})

run_test("mz peak lists round-trip", function() {
  sp <- Spectra(spd)
  mzs <- mz(sp)
  stopifnot(length(mzs) == 2L)
  stopifnot(identical(as.integer(lengths(mzs)), c(3L, 2L)))
  stopifnot(isTRUE(all.equal(as.numeric(mzs[[1]]), c(100.1, 150.2, 200.3))))
  stopifnot(isTRUE(all.equal(as.numeric(mzs[[2]]), c(110.0, 220.0))))
})

run_test("intensity peak lists round-trip", function() {
  sp <- Spectra(spd)
  ints <- intensity(sp)
  stopifnot(length(ints) == 2L)
  stopifnot(identical(as.integer(lengths(ints)), c(3L, 2L)))
  stopifnot(isTRUE(all.equal(as.numeric(ints[[1]]), c(10, 20, 30))))
  stopifnot(isTRUE(all.equal(as.numeric(ints[[2]]), c(5, 15))))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all Spectra smoke tests passed\n")
