#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `Biostrings` package.
#
# Fully self-contained: no input files, NO network, no packages beyond
# Biostrings itself. Every object is a small, literal, in-memory DNA/amino-acid
# sequence, so the checks are DETERMINISTIC and use exact equality — no random
# data, no tolerance needed. Exercises the core XString / XStringSet API
# (construction, reverse-complement, alphabet counting, pattern matching,
# translation, subsetting) and exits 0 only if every check passes, so it can be
# used as a pass/fail library validator:
#
#   Rscript Biostrings.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# All assertions are on fixed literal sequences with hand-computed expected
# values, so they should hold on any healthy Biostrings install. Points worth a
# glance once a build is available:
#   - reverseComplement("AAGCTT") == "AAGCTT" (HindIII site is its own
#     reverse-complement); reverseComplement("AAGC") == "GCTT".
#   - translate() uses the Standard Genetic Code by default: ATG->M, GCC->A.
#   - alphabetFrequency(x, baseOnly=TRUE) yields the A/C/G/T/other 5-vector.
# ============================================================================

if (!requireNamespace("Biostrings", quietly = TRUE)) {
  cat("FAIL: package 'Biostrings' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(Biostrings))
cat(sprintf("Biostrings version: %s\n", as.character(packageVersion("Biostrings"))))

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

run_test("DNAString construction and round-trip", function() {
  d <- DNAString("AAGCTT")
  stopifnot(inherits(d, "DNAString"))
  stopifnot(length(d) == 6L)
  stopifnot(identical(as.character(d), "AAGCTT"))
})

run_test("reverseComplement of a palindrome (HindIII site)", function() {
  d <- DNAString("AAGCTT")
  # complement AAGCTT -> TTCGAA, reversed -> AAGCTT (self reverse-complement).
  stopifnot(identical(as.character(reverseComplement(d)), "AAGCTT"))
})

run_test("reverseComplement / complement / reverse of a non-palindrome", function() {
  d <- DNAString("AAGC")
  # complement AAGC -> TTCG; reverse of that -> GCTT.
  stopifnot(identical(as.character(reverseComplement(d)), "GCTT"))
  stopifnot(identical(as.character(complement(d)), "TTCG"))
  stopifnot(identical(as.character(reverse(d)), "CGAA"))
})

run_test("alphabetFrequency counts each base", function() {
  af <- alphabetFrequency(DNAString("AACGT"), baseOnly = TRUE)
  stopifnot(af[["A"]] == 2, af[["C"]] == 1, af[["G"]] == 1, af[["T"]] == 1)
  stopifnot(af[["other"]] == 0)
  stopifnot(sum(af) == 5)
})

run_test("DNAStringSet holds two sequences with correct widths", function() {
  dss <- DNAStringSet(c("ACGT", "TTTT"))
  stopifnot(inherits(dss, "DNAStringSet"))
  stopifnot(length(dss) == 2L)
  stopifnot(identical(as.integer(width(dss)), c(4L, 4L)))
  stopifnot(identical(as.character(dss[[1]]), "ACGT"))
})

run_test("matchPattern finds all occurrences", function() {
  m <- matchPattern("CG", DNAString("ACGCG"))
  # 'CG' occurs at positions 2-3 and 4-5.
  stopifnot(length(m) == 2L)
  stopifnot(identical(as.integer(start(m)), c(2L, 4L)))
  stopifnot(identical(as.integer(end(m)), c(3L, 5L)))
})

run_test("translate uses the standard genetic code", function() {
  aa <- translate(DNAString("ATGGCC"))
  stopifnot(inherits(aa, "AAString"))
  # ATG -> Met (M), GCC -> Ala (A).
  stopifnot(identical(as.character(aa), "MA"))
})

run_test("subseq and letterFrequency", function() {
  d <- DNAString("AACGT")
  stopifnot(identical(as.character(subseq(d, start = 2, end = 4)), "ACG"))
  # 'CG' collapses to a single G+C count.
  stopifnot(as.integer(letterFrequency(d, "CG")) == 2L)
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all Biostrings smoke tests passed\n")
