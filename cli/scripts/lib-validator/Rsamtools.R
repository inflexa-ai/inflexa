#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `Rsamtools` package.
#
# NO network and no truly-external files: it reads only the example BAM/FASTA
# that ship INSIDE Rsamtools' own installation (via system.file(..., package=
# "Rsamtools")), which are part of the package, not user data. Checks are
# STRUCTURAL (class, header targets, a positive record count) with no numeric
# tolerance needed. Exits 0 only if every check passes, so it can be used as a
# pass/fail library validator:
#
#   Rscript Rsamtools.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# The load-bearing assumption is the exact bundled example filenames. RE-CHECK
# these once a build is available:
#   - system.file("extdata", "ex1.bam", package="Rsamtools") exists (the classic
#     samtools example alignment; reference seqs "seq1"/"seq2").
#   - system.file("extdata", "ex1.fa", package="Rsamtools") exists (matching
#     FASTA). scanFa() needs a ".fai" index — the index-dependent FaFile test is
#     GUARDED on ex1.fa.fai existing and skipped (still passes) if absent.
#   - idxstatsBam() needs a ".bai" index — GUARDED on ex1.bam.bai existing and
#     skipped if absent (no index is written; writing into the package dir would
#     be an external side effect).
# ============================================================================

if (!requireNamespace("Rsamtools", quietly = TRUE)) {
  cat("FAIL: package 'Rsamtools' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(Rsamtools))
cat(sprintf("Rsamtools version: %s\n", as.character(packageVersion("Rsamtools"))))

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

# Package-bundled example alignment (ships inside Rsamtools/extdata).
bam_path <- system.file("extdata", "ex1.bam", package = "Rsamtools")

run_test("bundled example BAM is present", function() {
  stopifnot(nzchar(bam_path), file.exists(bam_path))
})

run_test("BamFile opens the alignment", function() {
  bf <- BamFile(bam_path)
  stopifnot(inherits(bf, "BamFile"))
  stopifnot(identical(normalizePath(path(bf)), normalizePath(bam_path)))
})

run_test("countBam reports a positive record count", function() {
  cb <- countBam(bam_path)
  stopifnot(is.data.frame(cb))
  stopifnot("records" %in% colnames(cb))
  stopifnot(sum(cb$records) > 0)
})

run_test("scanBamHeader exposes reference targets", function() {
  hdr <- scanBamHeader(bam_path)
  stopifnot(is.list(hdr), "targets" %in% names(hdr))
  targets <- hdr$targets
  stopifnot(length(targets) > 0L)
  # Target lengths are named positive integers.
  stopifnot(!is.null(names(targets)), all(targets > 0))
})

run_test("idxstatsBam summarises per-reference counts (if .bai present)", function() {
  bai <- paste0(bam_path, ".bai")
  if (!file.exists(bai)) {
    # No bundled index; skip without failing (writing one would touch the
    # package directory — an external side effect we forbid).
    return(invisible(NULL))
  }
  st <- idxstatsBam(bam_path)
  stopifnot(is.data.frame(st))
  stopifnot(all(c("seqnames", "seqlength", "mapped", "unmapped") %in% colnames(st)))
  stopifnot(nrow(st) > 0L)
})

run_test("FaFile/scanFa reads the bundled FASTA (if .fai present)", function() {
  fa_path <- system.file("extdata", "ex1.fa", package = "Rsamtools")
  fai <- paste0(fa_path, ".fai")
  if (!nzchar(fa_path) || !file.exists(fa_path) || !file.exists(fai)) {
    # Missing FASTA or its index; skip without failing (scanFa needs the .fai
    # and we must not write one into the package dir).
    return(invisible(NULL))
  }
  seqs <- scanFa(FaFile(fa_path))
  stopifnot(inherits(seqs, "DNAStringSet"))
  stopifnot(length(seqs) > 0L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all Rsamtools smoke tests passed\n")
