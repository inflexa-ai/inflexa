#!/usr/bin/env Rscript
# Smoke test for the R `ChAMP` (Bioconductor) package.
#
# Fully self-contained: no input files, NO network. ChAMP is a full Illumina
# 450K/EPIC methylation pipeline: champ.load() reads per-sample .idat files, and
# every downstream step (normalization, DMP/DMR calling) leans on the array's
# annotation and manifest data packages. We have NEITHER IDATs/beta matrices NOR
# a chosen array annotation here, so a real pipeline run is OUT OF SCOPE OFFLINE.
# This test therefore verifies only what is checkable without any array files or
# annotation choice: that the package loads and that its pipeline entry points
# are present. Exits 0 only if every check passes, so it can be used as a
# pass/fail library validator:
#
#   Rscript ChAMP.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# This test is FUNCTION-EXISTENCE-DOMINATED. Even the beta-matrix entry points
# (champ.norm/champ.DMP/champ.DMR) require array annotation data (450K vs EPIC)
# to map probes to genome positions/genes, so none can be exercised offline on a
# synthetic matrix without pulling annotation. The checks below pass on any
# healthy install; VERIFY ONCE INSTALLED that these remain the pipeline's public
# entry points:
#   - champ.load()  : read IDATs -> beta matrix + pheno (needs IDAT files).
#   - champ.filter(): probe/sample QC filtering.
#   - champ.norm()  : normalization (BMIQ/etc.; needs array annotation).
#   - champ.DMP()   : differentially methylated positions.
#   - champ.DMR()   : differentially methylated regions.
# ============================================================================

if (!requireNamespace("ChAMP", quietly = TRUE)) {
  cat("FAIL: package 'ChAMP' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(ChAMP))
cat(sprintf("ChAMP version: %s\n", as.character(packageVersion("ChAMP"))))

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

run_test("data-loading / filtering entry points are exported functions", function() {
  stopifnot(exists("champ.load"), is.function(champ.load))
  stopifnot(exists("champ.filter"), is.function(champ.filter))
})

run_test("normalization entry point is an exported function", function() {
  stopifnot(exists("champ.norm"), is.function(champ.norm))
})

run_test("differential-methylation entry points are exported functions", function() {
  stopifnot(exists("champ.DMP"), is.function(champ.DMP))
  stopifnot(exists("champ.DMR"), is.function(champ.DMR))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all ChAMP smoke tests passed\n")
