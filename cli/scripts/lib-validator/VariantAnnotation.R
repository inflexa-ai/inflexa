#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `VariantAnnotation` package.
#
# NO network and no truly-external files: it reads only the example VCF that
# ships INSIDE VariantAnnotation's own installation (system.file(..., package=
# "VariantAnnotation")) — part of the package, not user data. Checks are
# STRUCTURAL (VCF class, non-empty rows, rowRanges is a GRanges, info/geno
# accessible, named samples) with no numeric tolerance needed. Exits 0 only if
# every check passes, so it can be used as a pass/fail library validator:
#
#   Rscript VariantAnnotation.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# The load-bearing assumptions are the bundled filename and the genome tag.
# RE-CHECK once a build is available:
#   - system.file("extdata", "chr22.vcf.gz", package="VariantAnnotation") exists
#     (the classic 1000-Genomes chr22 example slice).
#   - readVcf(vf, "hg19") parses it — "hg19" is the genome label attached to the
#     result, not a lookup, so any string works, but hg19 matches the example.
#   - The result is a CollapsedVCF (extends VCF); rowRanges() -> GRanges;
#     info()/geno() are accessible; samples(header(vcf)) is non-empty.
# ============================================================================

if (!requireNamespace("VariantAnnotation", quietly = TRUE)) {
  cat("FAIL: package 'VariantAnnotation' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(VariantAnnotation))
cat(sprintf("VariantAnnotation version: %s\n", as.character(packageVersion("VariantAnnotation"))))

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

# Package-bundled example VCF (ships inside VariantAnnotation/extdata).
vcf_path <- system.file("extdata", "chr22.vcf.gz", package = "VariantAnnotation")

run_test("bundled example VCF is present", function() {
  stopifnot(nzchar(vcf_path), file.exists(vcf_path))
})

run_test("readVcf parses a non-empty VCF object", function() {
  vcf <- suppressWarnings(readVcf(vcf_path, "hg19"))
  stopifnot(inherits(vcf, "VCF"))
  stopifnot(inherits(vcf, "CollapsedVCF"))
  stopifnot(nrow(vcf) > 0L)
})

run_test("rowRanges is a GRanges over the variants", function() {
  vcf <- suppressWarnings(readVcf(vcf_path, "hg19"))
  rr <- rowRanges(vcf)
  stopifnot(inherits(rr, "GRanges"))
  stopifnot(length(rr) == nrow(vcf))
  # REF alleles come back as a DNAStringSet, one per variant.
  stopifnot(inherits(ref(vcf), "DNAStringSet"))
  stopifnot(length(ref(vcf)) == nrow(vcf))
})

run_test("info and geno matrices are accessible", function() {
  vcf <- suppressWarnings(readVcf(vcf_path, "hg19"))
  inf <- info(vcf)
  stopifnot(inherits(inf, "DataFrame"))
  stopifnot(nrow(inf) == nrow(vcf))
  gn <- geno(vcf)
  # geno is a SimpleList of per-genotype matrices (GT, etc.).
  stopifnot(length(gn) > 0L)
})

run_test("header exposes named samples", function() {
  vcf <- suppressWarnings(readVcf(vcf_path, "hg19"))
  smp <- samples(header(vcf))
  stopifnot(is.character(smp))
  stopifnot(length(smp) > 0L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all VariantAnnotation smoke tests passed\n")
