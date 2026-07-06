#!/usr/bin/env Rscript
# Smoke test for the Bioconductor `MSnbase` package.
#
# Fully self-contained: no input files, NO network, no packages beyond MSnbase
# itself (a Bioconductor MS package that attaches Biobase / ProtGenerics /
# BiocGenerics). All data is built in memory: a hand-specified MS2 spectrum and
# a small fixed-seed expression matrix wrapped in an MSnSet. Checks are
# structural / exact on the values we put in, never on anything the package
# derives stochastically. Exits 0 only if every check passes, so it can be used
# as a pass/fail library validator:
#
#   Rscript MSnbase.R
#
# ============================ ASSUMPTIONS TO RE-CHECK ========================
# MSnbase is NOT installed in this environment, so the bodies below are written
# correct-by-review and could NOT be executed. Re-confirm once a build exists:
#   - new("Spectrum2", mz=, intensity=, rt=) accepts these slot names and keeps
#     the peaks in the supplied order (mz must be sorted ascending, as here).
#   - mz()/intensity()/peaksCount()/msLevel()/rtime() accessors behave as
#     asserted; peaksCount() == length(mz); Spectrum2's default msLevel == 2.
#   - Total ion current is checked as sum(intensity(sp)) (== 60), which is
#     robust. NOTE: tic(sp) returns the @tic HEADER slot (0 for a hand-built
#     spectrum -- only populated when importing raw files), so do NOT swap this
#     assertion to tic(sp) without re-verifying.
#   - The MSnSet(exprs=, fData=, pData=) constructor arg names and its validity
#     rule that fData/pData rownames match the expression matrix dimnames.
# ============================================================================

if (!requireNamespace("MSnbase", quietly = TRUE)) {
  cat("FAIL: package 'MSnbase' is not installed\n")
  quit(save = "no", status = 1)
}

suppressPackageStartupMessages(library(MSnbase))
cat(sprintf("MSnbase version: %s\n", as.character(packageVersion("MSnbase"))))

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

# A 5-feature x 4-sample expression matrix (fixed seed). Row/column names are
# needed because MSnSet's validity ties fData/pData rownames to the dimnames.
set.seed(1)
m <- matrix(rnorm(20), nrow = 5, ncol = 4)
rownames(m) <- paste0("feat", 1:5)
colnames(m) <- paste0("samp", 1:4)

run_test("Spectrum2 constructs and round-trips its peaks", function() {
  sp <- new("Spectrum2", mz = c(100, 150, 200), intensity = c(10, 20, 30), rt = 10.0)
  stopifnot(inherits(sp, "Spectrum2"))
  stopifnot(identical(mz(sp), c(100, 150, 200)))
  stopifnot(identical(intensity(sp), c(10, 20, 30)))
})

run_test("Spectrum2 peak count, ion current, level and rt", function() {
  sp <- new("Spectrum2", mz = c(100, 150, 200), intensity = c(10, 20, 30), rt = 10.0)
  stopifnot(peaksCount(sp) == 3L)
  # Total ion current == sum of intensities. Read off intensity() so the check
  # is independent of the header-only @tic slot (see ASSUMPTIONS above).
  stopifnot(sum(intensity(sp)) == 60)
  stopifnot(msLevel(sp) == 2L)
  stopifnot(rtime(sp) == 10.0)
})

run_test("MSnSet wraps an expression matrix with matching shape", function() {
  ms <- MSnSet(
    exprs = m,
    fData = data.frame(row.names = rownames(m), feature = rownames(m)),
    pData = data.frame(row.names = colnames(m), group = rep(c("a", "b"), 2))
  )
  stopifnot(inherits(ms, "MSnSet"))
  stopifnot(nrow(ms) == 5L, ncol(ms) == 4L)
  stopifnot(identical(featureNames(ms), rownames(m)))
  stopifnot(identical(sampleNames(ms), colnames(m)))
})

run_test("MSnSet exprs() round-trips the matrix", function() {
  ms <- MSnSet(
    exprs = m,
    fData = data.frame(row.names = rownames(m), feature = rownames(m)),
    pData = data.frame(row.names = colnames(m), group = rep(c("a", "b"), 2))
  )
  back <- exprs(ms)
  stopifnot(is.matrix(back), identical(dim(back), c(5L, 4L)))
  # exprs stores the values verbatim; equality is legitimate (the matrix is not
  # re-randomised, just wrapped and read back).
  stopifnot(isTRUE(all.equal(back, m)))
})

if (failures > 0L) {
  cat(sprintf("FAIL: %d test(s) failed\n", failures))
  quit(save = "no", status = 1)
}
cat("PASS: all MSnbase smoke tests passed\n")
