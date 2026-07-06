#!/usr/bin/env Rscript
# Smoke test for the R `Azimuth` package (reference-based scRNA annotation).
#
# Install: remotes::install_github("satijalab/azimuth")
#
# Fully self-contained and OFFLINE: no input files, no network. Azimuth's core
# entry point, RunAzimuth(query, reference = ...), needs a DOWNLOADED reference
# (a network fetch) plus a full Seurat query object -- both out of scope here --
# so this validator exercises only the side-effect-free surface: that the public
# entry points load and are exported as functions. Exits 0 only if every check
# passes, so it can be used as a pass/fail library validator:
#
#   Rscript Azimuth.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# UNVERIFIABLE WITHOUT AN INSTALL -- confirm all of the following once Azimuth is
# available:
#   - RunAzimuth() is the annotation workhorse: RunAzimuth(query, reference =).
#     It maps a Seurat query onto a reference and REQUIRES a downloaded reference
#     bundle (network) -- the reference is fetched/loaded, not bundled -- so a
#     real annotation run cannot be validated offline. Only its existence as a
#     function is checked here.
#   - LoadReference() reads a reference directory/bundle from disk (again, a real
#     reference must be downloaded first). Checked only as an exported function.
#   - AzimuthApp() launches the interactive Shiny mapping app; it cannot run
#     headless/offline. Checked only as an exported function.
#   - EXPORT SURFACE. If any of these three names is not exported by the installed
#     build (renamed / moved), the corresponding is.function() check will fail --
#     re-confirm the public API names against the installed package.
# ============================================================================

if (!requireNamespace("Azimuth", quietly = TRUE)) {
  cat("FAIL: package 'Azimuth' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(Azimuth))
cat(sprintf("Azimuth version: %s\n", as.character(packageVersion("Azimuth"))))

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

run_test("RunAzimuth is an exported function", function() {
  # The annotation workhorse. A real call needs a downloaded reference (network)
  # and a Seurat query -- out of scope offline; existence is all we can assert.
  stopifnot(is.function(RunAzimuth))
})

run_test("LoadReference is an exported function", function() {
  stopifnot(is.function(LoadReference))
})

run_test("AzimuthApp is an exported function", function() {
  stopifnot(is.function(AzimuthApp))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all Azimuth smoke tests passed\n")
