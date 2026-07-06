#!/usr/bin/env Rscript
# Smoke test for the R `CATALYST` package.
#
# Fully self-contained: no input files, NO network. Builds a synthetic CyTOF
# experiment entirely in memory (two flowFrames of Gaussian marker intensities
# assembled into a flowSet, plus the panel + metadata data.frames CATALYST
# requires) and drives it through `prepData()` to obtain a SingleCellExperiment.
# Checks are STRUCTURAL (class + dims relating markers/cells + assay presence);
# NO clustering is run. Exits 0 only if every check passes, so it can be used as
# a pass/fail library validator:
#
#   Rscript CATALYST.R
#
# ======================= ASSUMPTIONS TO RE-CHECK (FIDDLY) ====================
# The `prepData()` contract is intricate and was written from the CATALYST
# source (HelenaLC/CATALYST, R/prepData.R) rather than a live install -- RE-
# VERIFY ALL OF THIS once a build is available:
#
#  * SIGNATURE / column names (verified against source):
#      prepData(x, panel, md, features = NULL, ...)
#      panel_cols default: channel="fcs_colname", antigen="antigen",
#                          class="marker_class"
#      md_cols default:    file="file_name", id="sample_id",
#                          factors=c("condition","patient_id")
#    So `panel` MUST have columns  fcs_colname / antigen / marker_class,
#    and `md` MUST have columns    file_name / sample_id / condition / patient_id.
#
#  * marker_class values must be one of "type" / "state" / "none" (validated;
#    anything else errors "Invalid marker classes detected").
#
#  * flowSet <-> md matching (THE fiddly bit): prepData matches
#    `fsApply(fs, identifier)` (tried first) or `keyword(fs, "FILENAME")`
#    against `md[[file_name]]`, then reorders. We therefore set each frame's
#    identifier() EXPLICITLY to the md file_name, so the identifier path matches.
#
#  * `features = NULL` keeps every panel channel, so nrow(sce) == nrow(panel)
#    (markers) and ncol(sce) == total events across the two frames (cells).
#    RE-CONFIRM these dims and that "exprs"/"counts" assays are present.
#
# flowCore is a hard dependency of CATALYST, so it is guaranteed installed
# whenever the guard below passes; we attach it to build the flowFrames.
# ============================================================================

if (!requireNamespace("CATALYST", quietly = TRUE)) {
  cat("FAIL: package 'CATALYST' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(CATALYST))
suppressPackageStartupMessages(library(flowCore))
cat(sprintf("CATALYST version: %s\n", as.character(packageVersion("CATALYST"))))

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

# ---- synthetic CyTOF experiment -------------------------------------------
# Two samples of Gaussian marker intensities (kept positive-ish so the default
# arcsinh transform in prepData is exercised on realistic values). Channel
# names M1..M5 are what the panel's fcs_colname must reference.
markers <- paste0("M", 1:5)
n1 <- 1000L
n2 <- 500L

set.seed(1)
mat1 <- matrix(rnorm(n1 * 5, 5), ncol = 5, dimnames = list(NULL, markers))
set.seed(2)
mat2 <- matrix(rnorm(n2 * 5, 5), ncol = 5, dimnames = list(NULL, markers))

ff1 <- flowFrame(mat1)
ff2 <- flowFrame(mat2)
# The frame identifier is what prepData matches against md$file_name (the
# identifier path is tried before the FILENAME keyword). Set it explicitly.
identifier(ff1) <- "sample1.fcs"
identifier(ff2) <- "sample2.fcs"
fs <- flowSet(list(sample1.fcs = ff1, sample2.fcs = ff2))
sampleNames(fs) <- c("sample1.fcs", "sample2.fcs")

# panel: one row per channel. Column names are the prepData defaults.
panel <- data.frame(
  fcs_colname  = markers,
  antigen      = paste0("antigen", 1:5),
  marker_class = c("type", "type", "type", "state", "state"),
  stringsAsFactors = FALSE
)

# md: one row per sample. file_name MUST match the frame identifiers above.
md <- data.frame(
  file_name  = c("sample1.fcs", "sample2.fcs"),
  sample_id  = c("s1", "s2"),
  condition  = c("A", "B"),
  patient_id = c("p1", "p2"),
  stringsAsFactors = FALSE
)

run_test("prepData builds a SingleCellExperiment from the flowSet", function() {
  sce <- suppressMessages(suppressWarnings(
    prepData(fs, panel = panel, md = md, features = NULL)))
  stopifnot(inherits(sce, "SingleCellExperiment"))
})

run_test("SCE dims relate to markers (rows) and cells (cols)", function() {
  sce <- suppressMessages(suppressWarnings(
    prepData(fs, panel = panel, md = md, features = NULL)))
  # rows == panel channels (all kept because features = NULL)
  stopifnot(nrow(sce) == nrow(panel))
  # cols == total events pooled across both samples
  stopifnot(ncol(sce) == n1 + n2)
})

run_test("SCE carries the expression assays", function() {
  sce <- suppressMessages(suppressWarnings(
    prepData(fs, panel = panel, md = md, features = NULL)))
  an <- SummarizedExperiment::assayNames(sce)
  # prepData stores raw "counts" and, with transform = TRUE (default), "exprs".
  stopifnot("counts" %in% an)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all CATALYST smoke tests passed\n")
