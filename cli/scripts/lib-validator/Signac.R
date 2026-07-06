#!/usr/bin/env Rscript
# Smoke test for the R `Signac` package (scATAC-seq analysis on Seurat).
#
# Install: remotes::install_github("stuart-lab/signac@1.16.0")  — 1.17.0 removed
# RunChromVAR (chromVAR dropped from Bioc 3.23) but Azimuth still imports it, so
# this validator pins the last release that still ships RunChromVAR.
#
# Fully self-contained: no input files, no network. Builds a small synthetic
# peak x cell counts matrix with a fixed seed (peak ids like "chr1-1-100", cell
# ids as columns) and constructs a ChromatinAssay from it. Only the surface that
# touches Signac + SeuratObject (+ GenomicRanges) is exercised: the full LSI
# pipeline (RunTFIDF -> FindTopFeatures -> RunSVD) runs on a *Seurat* object,
# which is out of scope offline, so those entry points are asserted to EXIST as
# functions rather than driven end to end. Checks are structural (class, dims,
# parsed ranges) -- never numeric. Exits 0 only if every check passes, so it can
# be used as a pass/fail library validator:
#
#   Rscript Signac.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# UNVERIFIABLE WITHOUT AN INSTALL -- confirm all of the following once Signac is
# available:
#   - CreateChromatinAssay() ARG NAMES + `sep`. This test relies on
#     `counts = <matrix>` and `sep = c("-", "-")`, which splits a "chr1-1-100"
#     row name into (seqname="chr1", start=1, end=100): the FIRST separator sits
#     between seqname and start, the SECOND between start and end. Re-confirm the
#     `sep` semantics and whether a `genome`/`ranges` arg is required (here the
#     ranges are inferred from the row names alone, no genome supplied).
#   - ChromatinAssay CLASS NAME. Asserted via inherits(x, "ChromatinAssay") and
#     the granges() accessor returning a GRanges of one range per peak -- confirm
#     both the class string and that granges() is re-exported by Signac.
#   - FEATURE/CELL FILTERING. CreateChromatinAssay may drop peaks/cells via
#     min.cells / min.features. The synthetic matrix is dense (Poisson lambda 2
#     over 20 cells, so ~every peak is detected in most cells), so nothing is
#     EXPECTED to be filtered and all 50 peaks x 20 cells should survive -- but
#     the exact default filtering must be re-confirmed against an installed build.
#   - LSI PIPELINE. RunTFIDF() / FindTopFeatures() / RunSVD() are only checked to
#     be exported functions here; a real RunTFIDF(obj) -> FindTopFeatures(obj) ->
#     RunSVD(obj) chain needs a Seurat object (full Seurat, not blind-installable)
#     and returns a Seurat object -- out of scope offline.
#   - RunChromVAR presence is the whole reason for the @1.16.0 pin; it is checked
#     as an exported function below so the pin is self-documenting.
# ============================================================================

if (!requireNamespace("Signac", quietly = TRUE)) {
  cat("FAIL: package 'Signac' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(Signac))
cat(sprintf("Signac version: %s\n", as.character(packageVersion("Signac"))))

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

# Synthetic peak x cell counts: 50 peaks x 20 cells, integer Poisson draws.
# Peaks are non-overlapping windows on chr1 named "chr1-<start>-<end>" so the
# sep = c("-","-") parser can recover their genomic coordinates; cells are the
# columns. Poisson(lambda = 2) over 20 cells keeps every peak well detected, so
# the default construction filters drop nothing.
set.seed(1)
n_peaks <- 50L
n_cells <- 20L
starts <- seq(1L, by = 200L, length.out = n_peaks)
ends <- starts + 100L
peak_ids <- paste0("chr1-", starts, "-", ends)
cell_ids <- paste0("cell", seq_len(n_cells))
peaks <- matrix(
  rpois(n_peaks * n_cells, lambda = 2),
  nrow = n_peaks, ncol = n_cells,
  dimnames = list(peak_ids, cell_ids)
)

run_test("core LSI / TF-IDF entry points are exported functions", function() {
  stopifnot(is.function(CreateChromatinAssay))
  stopifnot(is.function(RunTFIDF))
  stopifnot(is.function(FindTopFeatures))
  stopifnot(is.function(RunSVD))
})

run_test("RunChromVAR is present (the @1.16.0 pin retains it)", function() {
  # 1.17.0 dropped this with chromVAR; the pin exists so Azimuth's import of it
  # keeps resolving. If this fails, the wrong Signac version is installed.
  stopifnot(is.function(RunChromVAR))
})

run_test("CreateChromatinAssay builds a ChromatinAssay from a peak x cell matrix", function() {
  chrom <- suppressWarnings(suppressMessages(
    CreateChromatinAssay(counts = peaks, sep = c("-", "-"))
  ))
  stopifnot(inherits(chrom, "ChromatinAssay"))
  # Nothing is expected to be filtered from the dense synthetic matrix (see the
  # FEATURE/CELL FILTERING note in the assumptions block above).
  stopifnot(ncol(chrom) == n_cells)
  stopifnot(nrow(chrom) == n_peaks)
})

run_test("sep parses peak ids into one genomic range per peak", function() {
  chrom <- suppressWarnings(suppressMessages(
    CreateChromatinAssay(counts = peaks, sep = c("-", "-"))
  ))
  # granges() (re-exported by Signac from GenomicRanges) is the proof the sep
  # argument parsed the "chr1-<start>-<end>" row names into coordinates.
  gr <- suppressWarnings(Signac::granges(chrom))
  stopifnot(inherits(gr, "GRanges"))
  stopifnot(length(gr) == nrow(chrom))
  stopifnot(all(as.character(GenomicRanges::seqnames(gr)) == "chr1"))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all Signac smoke tests passed\n")
