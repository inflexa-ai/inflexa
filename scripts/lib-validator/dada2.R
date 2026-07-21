#!/usr/bin/env Rscript
# Smoke test for the R `dada2` package (amplicon sequence variant inference).
#
# dada2 is the ENTRY POINT of the 16S/ITS pack: it is the only staged package that
# turns raw demultiplexed FASTQ into an abundance table. Everything downstream
# (phyloseq, vegan, mia, ANCOM-BC2, ALDEx2, MaAsLin2) consumes such a table and
# cannot produce one. So this validator does not stop at "the package loads" — it
# runs the actual pipeline the skill prescribes, filterAndTrim -> learnErrors ->
# dada -> mergePairs -> makeSequenceTable -> removeBimeraDenovo, and asserts a
# non-empty ASV table comes out the far end.
#
# Fully self-contained: no network and no external data. The paired FASTQ files
# ship inside the package (inst/extdata), so the test exercises real reads without
# depending on the reference inventory. Exits 0 only if every check passes, so it
# can be used as a pass/fail library validator:
#
#   Rscript dada2.R
#
# NOT covered: assignTaxonomy(). It needs a SILVA/UNITE training set, which is
# reference-inventory content rather than library-store content and is not
# guaranteed present — so asserting it here would make this validator fail for a
# reason that has nothing to do with whether dada2 works.

if (!requireNamespace("dada2", quietly = TRUE)) {
  cat("FAIL: package 'dada2' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(dada2))
cat(sprintf("dada2 version: %s\n", as.character(packageVersion("dada2"))))

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

# Paired example reads bundled with the package.
fwd <- system.file("extdata", "sam1F.fastq.gz", package = "dada2")
rev <- system.file("extdata", "sam1R.fastq.gz", package = "dada2")
tmp <- tempfile("dada2-validator"); dir.create(tmp)
filt_f <- file.path(tmp, "F_filt.fastq.gz")
filt_r <- file.path(tmp, "R_filt.fastq.gz")

run_test("bundled example FASTQ are present", function() {
  stopifnot(nzchar(fwd), nzchar(rev), file.exists(fwd), file.exists(rev))
})

# The pipeline runs once here rather than per-test: learnErrors/dada are the
# expensive steps and re-running them per assertion would multiply the runtime of
# an already heavy validator for no extra coverage.
track <- NULL
seqtab <- NULL
seqtab_nochim <- NULL

run_test("filterAndTrim: reads survive quality filtering", function() {
  out <- filterAndTrim(
    fwd, filt_f, rev, filt_r,
    truncLen = c(240, 200), maxEE = 2,
    multithread = FALSE, verbose = FALSE
  )
  track <<- out
  stopifnot(nrow(out) == 1L)
  stopifnot(out[1, "reads.in"] > 0, out[1, "reads.out"] > 0)
  # Filtering removes reads; it must never invent them.
  stopifnot(out[1, "reads.out"] <= out[1, "reads.in"])
  stopifnot(file.exists(filt_f), file.exists(filt_r))
})

run_test("learnErrors + dada: denoising both orientations", function() {
  err_f <- learnErrors(filt_f, multithread = FALSE, verbose = FALSE)
  err_r <- learnErrors(filt_r, multithread = FALSE, verbose = FALSE)
  dd_f <- dada(filt_f, err = err_f, multithread = FALSE, verbose = FALSE)
  dd_r <- dada(filt_r, err = err_r, multithread = FALSE, verbose = FALSE)
  merged <- mergePairs(dd_f, filt_f, dd_r, filt_r, verbose = FALSE)
  st <- makeSequenceTable(merged)
  seqtab <<- st
  stopifnot(is.matrix(st), nrow(st) == 1L, ncol(st) > 0)
  stopifnot(sum(st) > 0)
})

run_test("removeBimeraDenovo: non-empty ASV table survives", function() {
  stopifnot(!is.null(seqtab))
  nc <- removeBimeraDenovo(seqtab, method = "consensus", multithread = FALSE, verbose = FALSE)
  seqtab_nochim <<- nc
  # Chimera removal drops columns; emptying the table would mean the engine
  # produced nothing usable, which is the failure this whole validator exists for.
  stopifnot(ncol(nc) > 0, sum(nc) > 0)
  stopifnot(ncol(nc) <= ncol(seqtab))
})

run_test("ASV sequences are plausible DNA", function() {
  stopifnot(!is.null(seqtab_nochim))
  asvs <- colnames(seqtab_nochim)
  stopifnot(length(asvs) > 0)
  stopifnot(all(nchar(asvs) > 50))
  # The column names ARE the sequences in dada2's table format — that contract is
  # what lets downstream code hand ASVs off for classification.
  stopifnot(all(grepl("^[ACGTN]+$", asvs)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all dada2 smoke tests passed\n")
