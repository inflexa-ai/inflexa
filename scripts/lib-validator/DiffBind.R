#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `DiffBind` package (ChIP/ATAC differential
# binding).
#
# NO network and no truly-external files. A real DiffBind run needs peaksets +
# BAM files wired through a sample sheet, which is heavier than a smoke test
# should be; instead this validates the public API surface and — when the
# package ships its bundled example DBA object — a real `DBA` object built from
# that data. Everything comes from DiffBind's own installation (its exported
# functions and its bundled data()); no user data is touched. Checks are
# STRUCTURAL (functions exist; the example object, if present, is a DBA with
# the expected accessors). Exits 0 only if every check passes, so it can be used
# as a pass/fail library validator:
#
#   Rscript DiffBind.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# DiffBind is the HEAVIEST package to validate offline — a genuine analysis
# needs a sample sheet + aligned reads. RE-CHECK once a build is available:
#   - Exported entry points: dba, dba.count, dba.contrast, dba.analyze,
#     dba.normalize, dba.report (these are the load-bearing API assertions and
#     should hold on any install).
#   - The bundled example dataset name: this script tries data("tamoxifen_counts")
#     and expects it to materialise a `tamoxifen` object of class DBA. The
#     dataset name / object name have varied across DiffBind versions, so the
#     block is GUARDED — it is skipped (without failing) if that dataset is not
#     listed by data(package="DiffBind"). If skipped, only the API-surface
#     checks run. Re-confirm the current example-data name and object name.
# ============================================================================

if (!requireNamespace("DiffBind", quietly = TRUE)) {
  cat("FAIL: package 'DiffBind' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(DiffBind))
cat(sprintf("DiffBind version: %s\n", as.character(packageVersion("DiffBind"))))

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

run_test("core differential-binding API is exported", function() {
  stopifnot(is.function(DiffBind::dba))
  stopifnot(is.function(DiffBind::dba.count))
  stopifnot(is.function(DiffBind::dba.contrast))
  stopifnot(is.function(DiffBind::dba.analyze))
  stopifnot(is.function(DiffBind::dba.normalize))
  stopifnot(is.function(DiffBind::dba.report))
})

run_test("bundled example DBA object loads (if shipped)", function() {
  # DiffBind ships example objects via data(); the classic one is
  # 'tamoxifen_counts', which materialises a `tamoxifen` DBA object. The name
  # has drifted across versions, so guard on it actually being present.
  ds <- data(package = "DiffBind")$results
  available <- if (is.null(ds)) character(0) else ds[, "Item"]
  if (!("tamoxifen_counts" %in% available)) {
    # Example data not shipped under this name; skip without failing. The
    # API-surface test above still covers the load.
    return(invisible(NULL))
  }
  e <- new.env(parent = emptyenv())
  suppressWarnings(suppressMessages(
    data("tamoxifen_counts", package = "DiffBind", envir = e)
  ))
  stopifnot(exists("tamoxifen", envir = e, inherits = FALSE))
  obj <- get("tamoxifen", envir = e)
  stopifnot(inherits(obj, "DBA"))
  # A counted DBA carries a sample table; dba.show() returns one row per sample.
  info <- suppressMessages(dba.show(obj))
  stopifnot(is.data.frame(info))
  stopifnot(nrow(info) > 0L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all DiffBind smoke tests passed\n")
