#!/usr/bin/env Rscript
# Smoke test for the R `scGate` package.
#
# Fully self-contained: no input files, no network. scGate performs marker-based
# purification / gating of cell types on a Seurat object -- scGate(data, model)
# annotates each cell with an `is.pure` classification against a hierarchical
# gating model. Both heavier paths need resources unavailable here (the Seurat
# object path needs Seurat, which is not installed; get_scGateDB() fetches the
# model database over the network), so this test exercises the one genuinely
# OFFLINE, dependency-free piece -- building a gating model with gating_model()
# -- plus existence checks on the core exported entry points. Checks are
# structural (function presence, data.frame shape / column schema) -- never
# numeric. Exits 0 only if every check passes, so it can be used as a pass/fail
# library validator:
#
#   Rscript scGate.R
#
# Install: remotes::install_github("carmonalab/scGate")
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# UNVERIFIABLE WITHOUT AN INSTALL (scGate and its Seurat dependency are both
# absent here) -- confirm every item below once scGate is available:
#   - gating_model() COLUMN SCHEMA. This test asserts gating_model(name=,
#     signature=) returns a data.frame whose columns include exactly
#     c("levels", "use_as", "name", "signature"). If that column set or those
#     names differ in the installed build, update the schema assertion.
#   - scGate() SIGNATURE. The assumed core call is scGate(data = <Seurat obj>,
#     model = <gating model>), which adds an `is.pure` classification to the
#     object. This is NOT exercised (it needs a Seurat object); only
#     is.function(scGate) is checked. Re-confirm the argument names / return
#     shape once installed.
#   - get_scGateDB() is deliberately NOT called (it downloads the model DB over
#     the network) -- out of scope for an offline validator.
# ============================================================================

if (!requireNamespace("scGate", quietly = TRUE)) {
  cat("FAIL: package 'scGate' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(scGate))
cat(sprintf("scGate version: %s\n", as.character(packageVersion("scGate"))))

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

# Expected column schema of a gating model data.frame (see RE-CHECK note above).
gating_cols <- c("levels", "use_as", "name", "signature")

run_test("core entry points are exported functions", function() {
  stopifnot(is.function(scGate))
  stopifnot(is.function(gating_model))
})

run_test("gating_model builds a gating-model data.frame with the expected schema", function() {
  # Genuinely offline: gating_model() assembles a plain data.frame from the
  # supplied name + signature, with no Seurat object or network access.
  gm <- gating_model(name = "Tcell", signature = c("CD3D", "CD3E", "CD3G"))
  stopifnot(is.data.frame(gm))
  stopifnot(nrow(gm) >= 1L)
  stopifnot(all(gating_cols %in% colnames(gm)))
})

run_test("gating_model records the supplied name and signature", function() {
  gm <- gating_model(name = "Tcell", signature = c("CD3D", "CD3E", "CD3G"))
  # The model must carry the name we gave it.
  stopifnot("Tcell" %in% as.character(gm$name))
  # The signature is stored as text; every supplied marker should appear in it.
  sig_text <- paste(as.character(gm$signature), collapse = ";")
  stopifnot(all(vapply(
    c("CD3D", "CD3E", "CD3G"),
    function(g) grepl(g, sig_text, fixed = TRUE),
    logical(1)
  )))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all scGate smoke tests passed\n")
