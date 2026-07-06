#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `rtracklayer` package.
#
# Fully self-contained: NO network, no external annotation files. A small
# in-memory GRanges is built, exported to a TEMPFILE (BED, then GFF3) and
# re-imported; every temp path is unlinked on exit. Checks are STRUCTURAL
# (class, length, seqnames) plus coordinate round-trip, accounting for BED's
# 0-based half-open convention vs GFF/GRanges' 1-based closed convention.
# Exits 0 only if every check passes, so it can be used as a pass/fail library
# validator:
#
#   Rscript rtracklayer.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# rtracklayer attaches GenomicRanges (Depends), so GRanges()/IRanges() are in
# scope. Points to re-confirm once a build is available:
#   - export(gr, path) dispatches on the ".bed"/".gff3" extension, and
#     import(path) recovers a GRanges. rtracklayer internally converts BED's
#     0-based starts back to 1-based on import, so start()/width() ROUND-TRIP
#     to the original 1-based values (this is the load-bearing coordinate
#     assumption — re-verify the convention did not change).
#   - Minimal BED (no name/score) may import strand as "*", so strand is NOT
#     asserted for the BED round-trip; GFF3 preserves it.
# ============================================================================

if (!requireNamespace("rtracklayer", quietly = TRUE)) {
  cat("FAIL: package 'rtracklayer' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(rtracklayer))
cat(sprintf("rtracklayer version: %s\n", as.character(packageVersion("rtracklayer"))))

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

# Two 5bp features on chr1, forward strand. 1-based closed coordinates:
# [10,14] and [50,54].
make_gr <- function() {
  GRanges(seqnames = "chr1",
          ranges = IRanges(start = c(10, 50), width = 5),
          strand = "+")
}

run_test("GRanges builds with expected shape", function() {
  gr <- make_gr()
  stopifnot(inherits(gr, "GRanges"))
  stopifnot(length(gr) == 2L)
  stopifnot(all(as.character(seqnames(gr)) == "chr1"))
  stopifnot(identical(as.integer(start(gr)), c(10L, 50L)))
  stopifnot(identical(as.integer(width(gr)), c(5L, 5L)))
})

run_test("BED export/import round-trips coordinates", function() {
  gr <- make_gr()
  tmp <- tempfile(fileext = ".bed")
  on.exit(unlink(tmp), add = TRUE)
  suppressWarnings(export(gr, tmp))
  stopifnot(file.exists(tmp))
  gr2 <- suppressWarnings(import(tmp))
  stopifnot(inherits(gr2, "GRanges"))
  stopifnot(length(gr2) == 2L)
  stopifnot(all(as.character(seqnames(gr2)) == "chr1"))
  # rtracklayer converts BED's 0-based starts back to 1-based on import, so the
  # 1-based start/width recover exactly.
  stopifnot(identical(as.integer(start(gr2)), c(10L, 50L)))
  stopifnot(identical(as.integer(width(gr2)), c(5L, 5L)))
})

run_test("GFF3 export/import round-trips coordinates and strand", function() {
  gr <- make_gr()
  tmp <- tempfile(fileext = ".gff3")
  on.exit(unlink(tmp), add = TRUE)
  suppressWarnings(export(gr, tmp))
  stopifnot(file.exists(tmp))
  gr2 <- suppressWarnings(import(tmp))
  stopifnot(inherits(gr2, "GRanges"))
  stopifnot(length(gr2) == 2L)
  stopifnot(all(as.character(seqnames(gr2)) == "chr1"))
  # GFF is 1-based closed, matching GRanges directly.
  stopifnot(identical(as.integer(start(gr2)), c(10L, 50L)))
  stopifnot(identical(as.integer(width(gr2)), c(5L, 5L)))
  stopifnot(all(as.character(strand(gr2)) == "+"))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all rtracklayer smoke tests passed\n")
