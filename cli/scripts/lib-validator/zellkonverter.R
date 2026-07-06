#!/usr/bin/env Rscript
# Smoke test for the R `zellkonverter` package.
#
# Fully self-contained: no input files, no network. Exercises ONLY the package's
# exported surface -- that the four conversion entry points load as functions --
# and exits 0 only if every check passes, so it can be used as a pass/fail
# library validator:
#
#   Rscript zellkonverter.R
#
# ============================ DELIBERATELY MODEST -- READ ====================
# zellkonverter bridges SingleCellExperiment <-> AnnData (.h5ad) through a
# PYTHON backend managed by basilisk (a conda/anndata environment). A REAL
# round-trip (SCE2AnnData -> writeH5AD -> readH5AD -> AnnData2SCE) would
# provision and launch that Python env on first use -- heavy, and it may hit the
# network to build the conda environment. An offline validator MUST NOT trigger
# that, so this test asserts only that the functions EXIST and are callable
# symbols; it never CALLS them.
#
# FLAG (verify separately, on a host with the basilisk env available):
#   - writeH5AD()/readH5AD() disk round-trip of an .h5ad file.
#   - SCE2AnnData()/AnnData2SCE() in-memory conversion fidelity.
# These are NOT exercised here by design (they need the Python/basilisk backend).
# ============================================================================

if (!requireNamespace("zellkonverter", quietly = TRUE)) {
  cat("FAIL: package 'zellkonverter' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(zellkonverter))
cat(sprintf("zellkonverter version: %s\n", as.character(packageVersion("zellkonverter"))))

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

run_test("in-memory converters SCE2AnnData / AnnData2SCE are exported functions", function() {
  # Referencing the symbols does NOT start the basilisk Python env; only calling
  # them would. We assert existence + callability, nothing more.
  stopifnot(is.function(SCE2AnnData))
  stopifnot(is.function(AnnData2SCE))
})

run_test("disk converters writeH5AD / readH5AD are exported functions", function() {
  stopifnot(is.function(writeH5AD))
  stopifnot(is.function(readH5AD))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all zellkonverter smoke tests passed\n")
