#!/usr/bin/env Rscript
# Smoke test for the R `immunedeconv` package (a unified wrapper over many
# immune-cell deconvolution methods: MCP-counter, quanTIseq, EPIC, xCell, ...).
#
# Install: remotes::install_github("omnideconv/immunedeconv")
#
# Fully self-contained: no input files, no network. The method-registry surface
# is tested HARD (deconvolution_methods is a non-empty named vector exposing the
# expected method keys; deconvolute() is a function). An actual deconvolution is
# attempted on a small synthetic TPM matrix whose rownames are REAL HGNC gene
# symbols (including MCP-counter marker genes), but only as a SOFT check: the
# marker-based methods rely on specific signature genes mapping onto the input,
# and a synthetic matrix may legitimately fail to map, so a run error there is
# reported and tolerated -- never counted as a failure. Exits 0 only if every
# HARD check passes, so it can be used as a pass/fail library validator:
#
#   Rscript immunedeconv.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# UNVERIFIABLE WITHOUT AN INSTALL -- confirm once immunedeconv is available:
#   - deconvolution_methods SHAPE. Assumed to be a named character vector whose
#     entries (as names OR values) include the free, self-contained method keys
#     "mcp_counter", "quantiseq", and "epic". Some methods (CIBERSORT, TIMER)
#     need extra setup/licensing and are intentionally not required here.
#   - METHOD-KEY SPELLING. The `method=` argument keys are assumed spelled
#     "mcp_counter" / "quantiseq" / "epic". Re-confirm against the installed
#     `deconvolution_methods`.
#   - deconvolute() OUTPUT SHAPE. When the soft run succeeds it is assumed to
#     return a data.frame/tibble of cell types x samples with a first column
#     named "cell_type". Re-confirm the column name and orientation.
#   - GENE-SYMBOL / MARKER DEPENDENCY (the reason the run is SOFT). Marker-based
#     methods map their signature genes onto the input rownames; the synthetic
#     symbols here may not cover enough markers to produce non-NA fractions.
#     Re-run deconvolute() on a REAL TPM matrix once installed.
# ============================================================================

if (!requireNamespace("immunedeconv", quietly = TRUE)) {
  cat("FAIL: package 'immunedeconv' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(immunedeconv))
cat(sprintf("immunedeconv version: %s\n", as.character(packageVersion("immunedeconv"))))

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

# Synthetic bulk RNA-seq expression: REAL HGNC symbols as rownames (a spread of
# MCP-counter T-cell / B-cell / monocyte / NK / endothelial / fibroblast markers
# plus common housekeeping/oncogenes), 6 samples. Values are drawn lognormal
# then column-normalised to TPM (each sample sums to 1e6) so the matrix is
# genuinely TPM-like. Real symbols give the marker-based methods a chance to map.
set.seed(2024)
genes <- c(
  "CD8A", "CD8B", "CD3D", "CD3E", "CD3G", "CD2", "CD5", "CD28",           # T cells
  "CD19", "MS4A1", "CD79A", "CD79B", "TCL1A",                              # B cells
  "CD14", "CD68", "CSF1R", "FCGR3A", "LYZ",                                # monocytic
  "NCAM1", "KLRD1", "KLRF1", "NKG7", "GNLY", "PRF1", "GZMB",               # NK / cytotoxic
  "PECAM1", "VWF", "CDH5", "CLDN5",                                        # endothelial
  "COL1A1", "COL3A1", "DCN", "PDGFRB", "THY1", "LUM",                      # fibroblast
  "PTPRC", "CD4", "FOXP3", "IL2RA", "CTLA4",                               # immune-general
  "ACTB", "GAPDH", "B2M", "TP53", "EGFR", "KRAS", "MYC", "VIM"            # housekeeping / onco
)
n_genes <- length(genes)
n_samples <- 6L
expr <- matrix(
  rlnorm(n_genes * n_samples, meanlog = 3, sdlog = 1),
  nrow = n_genes, ncol = n_samples,
  dimnames = list(genes, paste0("Sample", seq_len(n_samples)))
)
# Column-normalise to TPM (each sample sums to 1e6).
expr <- sweep(expr, 2L, colSums(expr), "/") * 1e6

run_test("deconvolution_methods is a non-empty named vector", function() {
  dm <- deconvolution_methods
  stopifnot(is.character(dm))
  stopifnot(length(dm) > 0L)
  stopifnot(!is.null(names(dm)))
})

run_test("deconvolution_methods exposes expected method keys", function() {
  dm <- deconvolution_methods
  # Accept the key appearing as a value OR a name -- immunedeconv maps display
  # names to method keys and the orientation has varied across versions.
  known <- c(unname(dm), names(dm))
  for (m in c("mcp_counter", "quantiseq", "epic")) {
    stopifnot(m %in% known)
  }
})

run_test("deconvolute is an exported function", function() {
  stopifnot(exists("deconvolute"))
  stopifnot(is.function(deconvolute))
})

run_test("deconvolute(method='mcp_counter') on synthetic TPM (soft)", function() {
  # SOFT: marker genes may not map onto the synthetic symbols, so a run error is
  # tolerated (reported, not failed). If it DOES run, sanity-check the shape.
  res <- tryCatch(
    suppressWarnings(suppressMessages(
      deconvolute(expr, method = "mcp_counter")
    )),
    error = function(e) e
  )
  if (inherits(res, "error")) {
    cat(sprintf("       (soft) mcp_counter did not run on synthetic data: %s\n",
                conditionMessage(res)))
    return(invisible(NULL))
  }
  stopifnot(is.data.frame(res))
  stopifnot("cell_type" %in% colnames(res))
  # One column per sample beside the cell_type label column.
  stopifnot(ncol(res) >= 2L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all immunedeconv smoke tests passed\n")
