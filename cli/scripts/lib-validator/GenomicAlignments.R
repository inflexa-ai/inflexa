#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `GenomicAlignments` package.
#
# NO network and no truly-external files: it reads only the example BAM that
# ships INSIDE Rsamtools' own installation (system.file(..., package=
# "Rsamtools")) — Rsamtools is a hard dependency of GenomicAlignments and is
# therefore always present alongside it. Checks are STRUCTURAL (class, non-empty
# length, CIGAR type, finite coordinates, coverage class) with no numeric
# tolerance needed. Exits 0 only if every check passes, so it can be used as a
# pass/fail library validator:
#
#   Rscript GenomicAlignments.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# RE-CHECK once a build is available:
#   - The bundled BAM lives at system.file("extdata", "ex1.bam", package=
#     "Rsamtools"). GenomicAlignments has no example BAM of its own, so it
#     borrows Rsamtools' — Rsamtools MUST be installed (it is a dependency, so
#     this holds whenever GenomicAlignments itself is installed).
#   - readGAlignments(bam) returns a GAlignments; coverage() returns an RleList.
# ============================================================================

if (!requireNamespace("GenomicAlignments", quietly = TRUE)) {
  cat("FAIL: package 'GenomicAlignments' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(GenomicAlignments))
cat(sprintf("GenomicAlignments version: %s\n", as.character(packageVersion("GenomicAlignments"))))

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

# Package-bundled example alignment (ships inside Rsamtools/extdata; Rsamtools is
# a dependency of GenomicAlignments so it is always installed alongside it).
bam_path <- system.file("extdata", "ex1.bam", package = "Rsamtools")

run_test("bundled example BAM is reachable", function() {
  stopifnot(nzchar(bam_path), file.exists(bam_path))
})

run_test("readGAlignments returns a non-empty GAlignments", function() {
  ga <- readGAlignments(bam_path)
  stopifnot(inherits(ga, "GAlignments"))
  stopifnot(length(ga) > 0L)
})

run_test("CIGAR strings and coordinates are well-formed", function() {
  ga <- readGAlignments(bam_path)
  cg <- cigar(ga)
  stopifnot(is.character(cg))
  stopifnot(length(cg) == length(ga))
  st <- start(ga)
  wd <- width(ga)
  stopifnot(length(st) == length(ga), length(wd) == length(ga))
  stopifnot(all(is.finite(st)), all(is.finite(wd)))
  stopifnot(all(wd > 0))
})

run_test("coverage returns an RleList", function() {
  ga <- readGAlignments(bam_path)
  cov <- coverage(ga)
  stopifnot(inherits(cov, "RleList"))
  stopifnot(length(cov) > 0L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all GenomicAlignments smoke tests passed\n")
