#!/usr/bin/env Rscript
# Smoke test for the R `DMRcate` (Bioconductor) package.
#
# Fully self-contained: no input files, NO network. DMRcate calls differentially
# methylated regions (DMRs): cpg.annotate() turns per-CpG statistics into an
# annotated object using the array's annotation package (450K/EPIC) or a
# sequencing annotation, and dmrcate() then agglomerates neighbouring CpGs into
# regions. We have NEITHER per-CpG stats NOR a chosen array annotation here, so a
# real cpg.annotate() -> dmrcate() -> extractRanges() run is OUT OF SCOPE
# OFFLINE. This test therefore verifies only what is checkable without any
# annotation: that the package loads and that its DMR-calling entry points are
# present. Exits 0 only if every check passes, so it can be used as a pass/fail
# library validator:
#
#   Rscript DMRcate.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# This test is FUNCTION-EXISTENCE-DOMINATED. A real run needs annotated CpG
# statistics (from an array annotation package such as
# IlluminaHumanMethylation450kanno.* / EPIC, or a bisulfite-seq annotation),
# which we cannot construct or fetch offline. The checks below pass on any
# healthy install; VERIFY ONCE INSTALLED that these remain the public entry
# points:
#   - cpg.annotate()  : per-CpG stats + array annotation -> annotated object.
#   - dmrcate()       : agglomerate annotated CpGs into candidate regions.
#   - extractRanges() : pull the called DMRs out as a GRanges.
# ============================================================================

if (!requireNamespace("DMRcate", quietly = TRUE)) {
  cat("FAIL: package 'DMRcate' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(DMRcate))
cat(sprintf("DMRcate version: %s\n", as.character(packageVersion("DMRcate"))))

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

run_test("cpg.annotate entry point is an exported function", function() {
  stopifnot(exists("cpg.annotate"), is.function(cpg.annotate))
})

run_test("dmrcate DMR-calling entry point is an exported function", function() {
  stopifnot(exists("dmrcate"), is.function(dmrcate))
})

run_test("extractRanges result-extraction entry point is an exported function", function() {
  stopifnot(exists("extractRanges"), is.function(extractRanges))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all DMRcate smoke tests passed\n")
